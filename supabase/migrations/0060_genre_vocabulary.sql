-- Genre vocabulary (docs/specs/genre-vocabulary.md, section 2). Written only; Charlie applies it in the
-- Supabase SQL editor.
--
-- The owner's genre decisions: the spelling shown for a genre, its group (parent), its other spellings
-- (aliases), the umbrella genres it sits under, and an append-only log of every change. A genre nobody
-- has changed has no row: it resolves to itself by its key (genreKey in
-- src/server/events/genreVocabulary.ts). Stored artist genres are never rewritten by this file.
--
-- Run as one script (the SQL editor runs it in a single transaction). Safe to run twice: tables,
-- indexes, functions and triggers use if not exists, create or replace or drop-then-create.
--
-- Privacy (AGENTS.md): these tables hold genre keys, spellings, groups, links between genres, and for
-- changes an actor, an operation, a reason, a summary and before and after images of genres. No user id,
-- event id, artist, date seen, companion, note, rating, price or attendance. Server only: RLS on with no
-- policies, and every write goes through genre_vocabulary_write.

-- 1. Genres the owner has changed: the shown spelling and the owner's group.
create table if not exists public.genres (
  key text primary key,                 -- genreKey(name), checked in code
  name text not null,                   -- the spelling shown everywhere
  parent text,                          -- the owner's group; null: from the genre map
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. Other spellings. An alias key belongs to one genre and is never itself a genre key.
create table if not exists public.genre_aliases (
  alias_key text primary key,           -- genreKey of the other spelling
  alias text not null,                  -- the spelling as typed
  genre_key text not null references public.genres (key) on update cascade on delete cascade
);
create index if not exists genre_aliases_genre_idx on public.genre_aliases (genre_key);

-- 3. Umbrellas: many to many. "tech house" (genre_key) sits under "house" (umbrella_key). No loops.
create table if not exists public.genre_umbrellas (
  genre_key text not null references public.genres (key) on update cascade on delete cascade,
  umbrella_key text not null references public.genres (key) on update cascade on delete cascade,
  primary key (genre_key, umbrella_key),
  check (genre_key <> umbrella_key)
);
create index if not exists genre_umbrellas_umbrella_idx on public.genre_umbrellas (umbrella_key);

-- 4. Every change: the genres it touched as they were and as they became.
--    Images: [{ key, name, parent?, aliases: [{ key, alias }], umbrellas: [key] }] (VocabGenre in
--    src/server/events/genreTypes.ts). An empty array: none of them had a row.
create table if not exists public.genre_changes (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  actor text not null check (actor = 'owner' or actor like 'system:%'),
  operation text not null check (operation in ('rename','alias-add','alias-remove','merge','parent','umbrella-add','umbrella-remove','spelling','create','undo')),
  reason text not null,
  summary text not null,                -- "electro-house merged into electro house"
  before jsonb not null,
  after jsonb not null,
  undone_at timestamptz
);
create index if not exists genre_changes_at_idx on public.genre_changes (at desc);

-- Append-only: rows are never deleted, and the only update allowed sets undone_at once.
create or replace function public.genre_changes_append_only() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'genre_changes is append-only: rows are never deleted';
  end if;
  if (new.id, new.at, new.actor, new.operation, new.reason, new.summary, new.before, new.after)
       is distinct from (old.id, old.at, old.actor, old.operation, old.reason, old.summary, old.before, old.after)
     or old.undone_at is not null or new.undone_at is null then
    raise exception 'genre_changes is append-only: only undone_at may be set, once';
  end if;
  return new;
end $$;
drop trigger if exists genre_changes_append_only on public.genre_changes;
create trigger genre_changes_append_only before update or delete on public.genre_changes
  for each row execute function public.genre_changes_append_only();

alter table public.genres enable row level security;            -- no policies: server only
alter table public.genre_aliases enable row level security;
alter table public.genre_umbrellas enable row level security;
alter table public.genre_changes enable row level security;
revoke all on public.genres, public.genre_aliases, public.genre_umbrellas, public.genre_changes from anon, authenticated;

-- 5. The images of the given genres as they are now, ordered by key. A key with no row is left out.
create or replace function public.genre_vocabulary_images(p_keys text[])
returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'key', g.key,
             'name', g.name,
             'aliases', coalesce((select jsonb_agg(jsonb_build_object('key', a.alias_key, 'alias', a.alias) order by a.alias_key)
                                    from public.genre_aliases a where a.genre_key = g.key), '[]'::jsonb),
             'umbrellas', coalesce((select jsonb_agg(u.umbrella_key order by u.umbrella_key)
                                      from public.genre_umbrellas u where u.genre_key = g.key), '[]'::jsonb))
           || case when g.parent is null then '{}'::jsonb else jsonb_build_object('parent', g.parent) end
           order by g.key), '[]'::jsonb)
  from public.genres g
  where g.key = any(p_keys);
$$;
revoke all on function public.genre_vocabulary_images(text[]) from public, anon, authenticated;
grant execute on function public.genre_vocabulary_images(text[]) to service_role;

-- 6. One write: replace the listed genres' rows (name, parent, aliases, umbrellas) with the 'after'
--    images, delete those with no image, and log one change, in one transaction.
--    p_after: [{ key, image: { name, parent, aliases: [{ alias_key, alias }], umbrellas: [key] } | null }]
--    An alias may give its key as alias_key or key (the VocabGenre shape).
--    The before images are read here, under a lock, so the log is what was really there. A genre that
--    is not listed but sits under a deleted genre loses that link, so it is logged too.
--    Refused: a key listed twice, an empty key or name, an alias key that is a genre key or another
--    genre's alias, an umbrella that is not a genre, an umbrella on itself, and any umbrella loop.
create or replace function public.genre_vocabulary_write(
  p_after jsonb, p_operation text, p_actor text, p_reason text, p_summary text)
returns public.genre_changes
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r jsonb; a jsonb; u jsonb;
  v_key text; v_image jsonb; v_alias_key text; v_alias text; v_umbrella text;
  v_keys text[]; v_deleted text[]; v_touched text[];
  v_before jsonb; v_after jsonb; v_change public.genre_changes;
begin
  if jsonb_typeof(p_after) is distinct from 'array' then
    raise exception 'genre_vocabulary_write: p_after must be an array';
  end if;
  if p_actor is null or not (p_actor = 'owner' or p_actor like 'system:%') then
    raise exception 'genre_vocabulary_write: actor must be owner or system:<job>';
  end if;
  if p_operation is null or p_operation not in ('rename','alias-add','alias-remove','merge','parent','umbrella-add','umbrella-remove','spelling','create','undo') then
    raise exception 'genre_vocabulary_write: unknown operation %', p_operation;
  end if;
  if coalesce(btrim(p_reason), '') = '' or coalesce(btrim(p_summary), '') = '' then
    raise exception 'genre_vocabulary_write: a reason and a summary are required';
  end if;

  -- One vocabulary write at a time, so the loop and alias checks see a settled table.
  perform pg_advisory_xact_lock(hashtext('public.genre_vocabulary_write'));

  select array_agg(x->>'key'), array_agg(x->>'key') filter (where jsonb_typeof(x->'image') is distinct from 'object')
    into v_keys, v_deleted
    from jsonb_array_elements(p_after) x;
  v_keys := coalesce(v_keys, '{}'); v_deleted := coalesce(v_deleted, '{}');
  if exists (select 1 from unnest(v_keys) k where coalesce(btrim(k), '') = '') then
    raise exception 'genre_vocabulary_write: every entry needs a key';
  end if;
  if (select count(*) from unnest(v_keys)) <> (select count(distinct k) from unnest(v_keys) k) then
    raise exception 'genre_vocabulary_write: a genre key is listed twice';
  end if;

  -- Touched: the listed genres, and any genre that sits under one being deleted.
  select coalesce(array_agg(distinct k), '{}') into v_touched from (
    select unnest(v_keys) as k
    union
    select gu.genre_key from public.genre_umbrellas gu where gu.umbrella_key = any(v_deleted)
  ) t;
  perform 1 from public.genres g where g.key = any(v_touched) order by g.key for update;
  v_before := public.genre_vocabulary_images(v_touched);

  -- Clear the listed genres' own links, and delete the genres with no image (cascades their links).
  delete from public.genre_aliases where genre_key = any(v_keys);
  delete from public.genre_umbrellas where genre_key = any(v_keys);
  delete from public.genres where key = any(v_deleted);

  -- Upsert every genre that has an image before any link, so links between listed genres resolve.
  for r in select * from jsonb_array_elements(p_after) loop
    v_image := r->'image';
    continue when jsonb_typeof(v_image) is distinct from 'object';
    v_key := r->>'key';
    if coalesce(btrim(v_image->>'name'), '') = '' then
      raise exception 'genre_vocabulary_write: genre % needs a name', v_key;
    end if;
    if exists (select 1 from public.genre_aliases ga where ga.alias_key = v_key) then
      raise exception 'genre_vocabulary_write: % is already another genre''s alias', v_key;
    end if;
    insert into public.genres (key, name, parent)
    values (v_key, btrim(v_image->>'name'), nullif(btrim(v_image->>'parent'), ''))
    on conflict (key) do update
      set name = excluded.name, parent = excluded.parent, updated_at = now();
  end loop;

  for r in select * from jsonb_array_elements(p_after) loop
    v_image := r->'image';
    continue when jsonb_typeof(v_image) is distinct from 'object';
    v_key := r->>'key';

    for a in select * from jsonb_array_elements(coalesce(v_image->'aliases', '[]'::jsonb)) loop
      v_alias_key := coalesce(a->>'alias_key', a->>'key');
      v_alias := btrim(a->>'alias');
      if coalesce(btrim(v_alias_key), '') = '' or coalesce(v_alias, '') = '' then
        raise exception 'genre_vocabulary_write: an alias of % needs a key and a spelling', v_key;
      end if;
      if exists (select 1 from public.genres g where g.key = v_alias_key) then
        raise exception 'genre_vocabulary_write: alias key % is already a genre key', v_alias_key;
      end if;
      if exists (select 1 from public.genre_aliases ga where ga.alias_key = v_alias_key) then
        raise exception 'genre_vocabulary_write: alias key % is already an alias of another genre', v_alias_key;
      end if;
      insert into public.genre_aliases (alias_key, alias, genre_key) values (v_alias_key, v_alias, v_key);
    end loop;

    for u in select * from jsonb_array_elements(coalesce(v_image->'umbrellas', '[]'::jsonb)) loop
      v_umbrella := u #>> '{}';
      if v_umbrella = v_key then
        raise exception 'genre_vocabulary_write: % cannot sit under itself', v_key;
      end if;
      if not exists (select 1 from public.genres g where g.key = v_umbrella) then
        raise exception 'genre_vocabulary_write: umbrella % is not a genre', v_umbrella;
      end if;
      insert into public.genre_umbrellas (genre_key, umbrella_key) values (v_key, v_umbrella)
      on conflict do nothing;
    end loop;
  end loop;

  -- Umbrella loops: walk up from each new link's umbrella; reaching the genre itself is a loop.
  for v_key, v_umbrella in
    select gu.genre_key, gu.umbrella_key from public.genre_umbrellas gu where gu.genre_key = any(v_keys)
  loop
    if exists (
      with recursive up(k) as (
        select v_umbrella
        union
        select gu.umbrella_key from public.genre_umbrellas gu join up on gu.genre_key = up.k
      )
      select 1 from up where up.k = v_key
    ) then
      raise exception 'genre_vocabulary_write: putting % under % makes an umbrella loop', v_key, v_umbrella;
    end if;
  end loop;

  v_after := public.genre_vocabulary_images(v_touched);
  insert into public.genre_changes (actor, operation, reason, summary, before, after)
  values (p_actor, p_operation, p_reason, p_summary, v_before, v_after)
  returning * into v_change;
  return v_change;
end $$;
revoke all on function public.genre_vocabulary_write(jsonb, text, text, text, text) from public, anon, authenticated;
grant execute on function public.genre_vocabulary_write(jsonb, text, text, text, text) to service_role;

-- Check (run after applying; expect four tables with RLS on and no policies, and the function rows):
--   select c.relname, c.relrowsecurity,
--          (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relname in ('genres', 'genre_aliases', 'genre_umbrellas', 'genre_changes');
--   -- expect relrowsecurity true and policies 0 for all four.
--   select p.proname, p.prosecdef,
--          has_function_privilege('anon', p.oid, 'execute') as anon_exec,
--          has_function_privilege('authenticated', p.oid, 'execute') as member_exec,
--          has_function_privilege('service_role', p.oid, 'execute') as server_exec
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname in ('genre_vocabulary_write', 'genre_vocabulary_images');
--   -- expect anon_exec false, member_exec false, server_exec true for both; prosecdef true for the write.
--
-- Rollback (removes everything this migration added, including any vocabulary written since). Run as
-- one script:
--   drop function if exists public.genre_vocabulary_write(jsonb, text, text, text, text);
--   drop function if exists public.genre_vocabulary_images(text[]);
--   drop table if exists public.genre_changes;
--   drop function if exists public.genre_changes_append_only();
--   drop table if exists public.genre_umbrellas;
--   drop table if exists public.genre_aliases;
--   drop table if exists public.genres;
-- Stored artist genres (artist_genres, user_artist_genres) are not touched by this file or its rollback.
