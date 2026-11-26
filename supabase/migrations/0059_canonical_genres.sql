-- Canonical genres (docs/specs/canonical-genres.md, section 3). Written only; Charlie applies it in the
-- Supabase SQL editor.
--
-- Adds the 'owner' source, an append-only change log, one atomic write function, the owner's seen-act
-- list function, and moves the owner's 'you' rows to 'owner'. Run as one script (the SQL editor runs it
-- in a single transaction). Safe to run twice: tables, indexes, functions, triggers and constraints use
-- if not exists, create or replace or drop-then-create, and the copy of 'you' rows finds none the
-- second time.
--
-- 'you' stays allowed by the source check: code deployed before this migration may still write it, and
-- the change log keeps the moved rows under it. No 'you' row is left once this runs.
--
-- Privacy (AGENTS.md): artist_genres and artist_genre_changes hold an act key, a name, genres, a source,
-- a MusicBrainz ID or page, and for changes an actor, a reason and a batch id. No user id, event id, date
-- seen, companion, note, rating, price or attendance. seen_act_names returns act keys and names only.

-- 1. The owner's shared genres get their own source.
alter table public.artist_genres drop constraint if exists artist_genres_source_check;
alter table public.artist_genres add constraint artist_genres_source_check
  check (source in ('music-story', 'musicbrainz', 'you', 'owner'));

-- 2. Every change to a shared genre row: old, new, who or what, why. No personal fields.
create table if not exists public.artist_genre_changes (
  id uuid primary key default gen_random_uuid(),
  artist_key text not null,
  source text not null,                 -- which artist_genres row changed
  at timestamptz not null default now(),
  actor text not null check (actor = 'owner' or actor like 'system:%'),
  reason text not null,
  batch_id text,                        -- one genres file upload
  before jsonb,                         -- the row as it was (null: there was none)
  after jsonb,                          -- the row as it became (null: removed)
  undone_at timestamptz
);
create index if not exists artist_genre_changes_key_idx on public.artist_genre_changes (artist_key, at desc);
create index if not exists artist_genre_changes_batch_idx on public.artist_genre_changes (batch_id) where batch_id is not null;

-- Append-only: rows are never deleted, and the only update allowed sets undone_at once.
create or replace function public.artist_genre_changes_append_only() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'artist_genre_changes is append-only: rows are never deleted';
  end if;
  if (new.id, new.artist_key, new.source, new.at, new.actor, new.reason, new.batch_id, new.before, new.after)
       is distinct from (old.id, old.artist_key, old.source, old.at, old.actor, old.reason, old.batch_id, old.before, old.after)
     or old.undone_at is not null or new.undone_at is null then
    raise exception 'artist_genre_changes is append-only: only undone_at may be set, once';
  end if;
  return new;
end $$;
drop trigger if exists artist_genre_changes_append_only on public.artist_genre_changes;
create trigger artist_genre_changes_append_only before update or delete on public.artist_genre_changes
  for each row execute function public.artist_genre_changes_append_only();

alter table public.artist_genre_changes enable row level security;   -- no policies: server only
revoke all on public.artist_genre_changes from anon, authenticated;

-- 3. One write: upsert or delete each row and log it, in one transaction.
--    p_rows: [{ artist_key, source, row: {name, mbid, genres, source_url, inputs, checked_at} | null }]
--    Returns the change rows written. A re-check that changes only checked_at writes no change.
create or replace function public.artist_genres_write(p_rows jsonb, p_actor text, p_reason text, p_batch text default null)
returns setof public.artist_genre_changes
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r jsonb; v_key text; v_source text; v_before jsonb; v_after jsonb; v_change public.artist_genre_changes;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    v_key := r->>'artist_key';
    v_source := r->>'source';
    select to_jsonb(g) into v_before from public.artist_genres g
     where g.artist_key = v_key and g.source = v_source for update;
    if jsonb_typeof(r->'row') = 'object' then
      insert into public.artist_genres (artist_key, source, name, mbid, genres, source_url, inputs, checked_at)
      select v_key, v_source, x.name, x.mbid, coalesce(x.genres, '[]'), x.source_url, coalesce(x.inputs, '{}'), x.checked_at
        from jsonb_populate_record(null::public.artist_genres, r->'row') x
      on conflict (artist_key, source) do update
        set name = excluded.name, mbid = excluded.mbid, genres = excluded.genres,
            source_url = excluded.source_url, inputs = excluded.inputs, checked_at = excluded.checked_at;
      select to_jsonb(g) into v_after from public.artist_genres g where g.artist_key = v_key and g.source = v_source;
    else
      delete from public.artist_genres where artist_key = v_key and source = v_source;
      v_after := null;
    end if;
    if (v_before - 'checked_at') is distinct from (v_after - 'checked_at') then
      insert into public.artist_genre_changes (artist_key, source, actor, reason, batch_id, before, after)
      values (v_key, v_source, p_actor, p_reason, p_batch, v_before, v_after)
      returning * into v_change;
      return next v_change;
    end if;
  end loop;
end $$;
revoke all on function public.artist_genres_write(jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.artist_genres_write(jsonb, text, text, text) to service_role;

-- 4. The owner's genres file: every act any member ticked as seen, names only.
--    It reads other members' rows, so it is security definer and callable only by the server (service
--    role); the owner check also happens in the route and the store. It returns a key and a name and
--    nothing else: no member, event, date or count. One row per key; the name is the lowest spelling.
--    Deleted events, empty keys and names, and vault ciphertext ("v1:...") are skipped.
create or replace function public.seen_act_names()
returns table(artist_key text, name text)
language sql stable security definer set search_path = public, pg_temp as $$
  select x.k, min(x.n)
  from (
    select btrim(s->>'key') as k, btrim(s->>'name') as n
    from (select seen from public.logged_events
           where deleted_at is null and jsonb_typeof(seen) = 'array') e
    cross join lateral jsonb_array_elements(e.seen) s
    where coalesce(btrim(s->>'key'), '') <> ''
      and coalesce(btrim(s->>'name'), '') <> ''
      and s->>'name' not like 'v1:%'
  ) x
  group by x.k;
$$;
revoke all on function public.seen_act_names() from public, anon, authenticated;
grant execute on function public.seen_act_names() to service_role;

-- 5. The owner's own genres become the shared ones: copy 'you' to 'owner', log both, then drop 'you'.
insert into public.artist_genre_changes (artist_key, source, actor, reason, before, after)
select g.artist_key, 'owner', 'system:migration-0059', 'The owner''s genres became the shared genres',
       null, to_jsonb(g) || jsonb_build_object('source', 'owner')
  from public.artist_genres g
 where g.source = 'you'
   and not exists (select 1 from public.artist_genres o where o.artist_key = g.artist_key and o.source = 'owner');
insert into public.artist_genres (artist_key, source, name, mbid, genres, source_url, inputs, checked_at)
select artist_key, 'owner', name, mbid, genres, source_url, inputs, checked_at
  from public.artist_genres where source = 'you'
on conflict (artist_key, source) do nothing;
insert into public.artist_genre_changes (artist_key, source, actor, reason, before, after)
select artist_key, 'you', 'system:migration-0059', 'Moved to the owner source', to_jsonb(g), null
  from public.artist_genres g where g.source = 'you';
delete from public.artist_genres where source = 'you';

-- Members' own genres (user_artist_genres, 0020) are not touched by this file.

-- Check (run after applying; expect no 'you' row, an 'owner' row per moved act, and the two log counts):
--   select source, count(*) from public.artist_genres group by source order by source;
--   select source, count(*) from public.artist_genre_changes
--    where actor = 'system:migration-0059' group by source order by source;
--   select p.proname, p.prosecdef,
--          has_function_privilege('anon', p.oid, 'execute') as anon_exec,
--          has_function_privilege('authenticated', p.oid, 'execute') as member_exec,
--          has_function_privilege('service_role', p.oid, 'execute') as server_exec
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname in ('artist_genres_write', 'seen_act_names');
--   -- expect prosecdef true, anon_exec false, member_exec false, server_exec true for both.
--
-- Rollback (restores the 'you' rows from the log, then removes what this migration added). Run as one
-- script:
--   insert into public.artist_genres select (jsonb_populate_record(null::public.artist_genres, before)).*
--     from public.artist_genre_changes where actor = 'system:migration-0059' and source = 'you'
--     on conflict do nothing;
--   delete from public.artist_genres where source = 'owner';
--   drop function if exists public.seen_act_names();
--   drop function if exists public.artist_genres_write(jsonb, text, text, text);
--   drop table if exists public.artist_genre_changes;
--   drop function if exists public.artist_genre_changes_append_only();
--   alter table public.artist_genres drop constraint if exists artist_genres_source_check;
--   alter table public.artist_genres add constraint artist_genres_source_check
--     check (source in ('music-story', 'musicbrainz', 'you'));
-- Note: rollback deletes every 'owner' row, including any written after this migration ran.
