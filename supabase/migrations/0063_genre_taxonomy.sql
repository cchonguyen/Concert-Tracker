-- 0063: genre taxonomy, Phase A (docs/specs/genre-taxonomy-phase-a.md, approved by Charlie 2026-11-27).
-- Families and macros become rows in genres, each genre gets one primary parent, and genre_relations
-- holds the links beside the tree (secondary families, adjacent, derived from). Every write still goes
-- through genre_vocabulary_write, is logged in genre_changes and can be undone. No personal fields.
-- Safe to run twice.

-- 1. Levels in the vocabulary table. A genre's key is genreKey(name); a family's is 'family:' plus that,
--    a macro's 'macro:' plus that. genreKey never makes a colon, so typed text never hits either.
alter table public.genres add column if not exists level text not null default 'genre';
alter table public.genres add column if not exists primary_parent_key text
  references public.genres (key) on update cascade on delete set null;
alter table public.genres add column if not exists specificity_tier text;
alter table public.genres drop constraint if exists genres_level_check;
alter table public.genres add constraint genres_level_check check (level in ('genre','family','macro'));
alter table public.genres drop constraint if exists genres_tier_check;
alter table public.genres add constraint genres_tier_check check (
  specificity_tier is null or (level = 'genre' and specificity_tier in ('specific','umbrella_fallback')));
alter table public.genres drop constraint if exists genres_parent_not_self;
alter table public.genres add constraint genres_parent_not_self check (primary_parent_key is null or primary_parent_key <> key);
alter table public.genres drop constraint if exists genres_key_space;
alter table public.genres add constraint genres_key_space check (
  (level = 'genre' and position(':' in key) = 0) or
  (level = 'family' and key like 'family:%') or
  (level = 'macro' and key like 'macro:%'));
create index if not exists genres_primary_parent_idx on public.genres (primary_parent_key);

-- 2. Links beside the tree. They never add to a total. 'curated' rows are the owner's; a later system
--    job may write 'artist_cooccur' and 'lineup_cooccur' rows from shared tables only, never over 'curated'.
create table if not exists public.genre_relations (
  source_key text not null references public.genres (key) on update cascade on delete cascade,
  target_key text not null references public.genres (key) on update cascade on delete cascade,
  type text not null check (type in ('secondary_parent','adjacent','derived_from')),
  weight numeric not null check (weight > 0 and weight <= 1),
  origin text not null check (origin in ('curated','artist_cooccur','lineup_cooccur')),
  updated_at timestamptz not null default now(),
  primary key (source_key, target_key, type),
  check (source_key <> target_key)
);
create index if not exists genre_relations_target_idx on public.genre_relations (target_key);
alter table public.genre_relations enable row level security;   -- no policies: server only
revoke all on public.genre_relations from anon, authenticated;

-- 3. The log gains the taxonomy operations (the 0060 names stay).
alter table public.genre_changes drop constraint if exists genre_changes_operation_check;
alter table public.genre_changes add constraint genre_changes_operation_check check (operation in (
  'rename','alias-add','alias-remove','merge','parent','umbrella-add','umbrella-remove','spelling','create','undo',
  'taxonomy-import','relations-import','relation-add','relation-remove','relation-weight','family'));

-- 4. Images now carry level, primaryParent, tier and the genre's outgoing relations.
create or replace function public.genre_vocabulary_images(p_keys text[])
returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'key', g.key,
             'name', g.name,
             'level', g.level,
             'aliases', coalesce((select jsonb_agg(jsonb_build_object('key', a.alias_key, 'alias', a.alias) order by a.alias_key)
                                    from public.genre_aliases a where a.genre_key = g.key), '[]'::jsonb),
             'umbrellas', coalesce((select jsonb_agg(u.umbrella_key order by u.umbrella_key)
                                      from public.genre_umbrellas u where u.genre_key = g.key), '[]'::jsonb),
             'relations', coalesce((select jsonb_agg(jsonb_build_object('target', r.target_key, 'type', r.type,
                                                                        'weight', r.weight, 'origin', r.origin)
                                                     order by r.target_key, r.type)
                                      from public.genre_relations r where r.source_key = g.key), '[]'::jsonb))
           || case when g.parent is null then '{}'::jsonb else jsonb_build_object('parent', g.parent) end
           || case when g.primary_parent_key is null then '{}'::jsonb else jsonb_build_object('primaryParent', g.primary_parent_key) end
           || case when g.specificity_tier is null then '{}'::jsonb else jsonb_build_object('tier', g.specificity_tier) end
           order by g.key), '[]'::jsonb)
  from public.genres g
  where g.key = any(p_keys);
$$;
revoke all on function public.genre_vocabulary_images(text[]) from public, anon, authenticated;
grant execute on function public.genre_vocabulary_images(text[]) to service_role;

-- 5. One write, as in 0060, now also replacing each listed genre's level, primary parent, tier and
--    outgoing relations. p_after: [{ key, image: { name, parent?, level, primaryParent?, tier?,
--    aliases, umbrellas, relations: [{ target, type, weight, origin }] } | null }]
--    An image with no 'level' is a pre-0063 image (an undo of an older change): it sets name, parent,
--    aliases and umbrellas only and leaves the genre's level, primary parent, tier and relations as they are.
--    Refused, beyond 0060's checks: a genre whose primary parent is not a family, a family whose primary
--    parent is not a macro, a macro with a parent, a parent that does not exist, a secondary_parent that is
--    not genre to family, an adjacent or derived_from that is not genre to genre, an adjacent pair stored in
--    both directions, a derived_from loop, and a system actor changing a curated relation.
create or replace function public.genre_vocabulary_write(
  p_after jsonb, p_operation text, p_actor text, p_reason text, p_summary text)
returns public.genre_changes
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r jsonb; a jsonb; u jsonb; rel jsonb;
  v_key text; v_image jsonb; v_alias_key text; v_alias text; v_umbrella text; v_target text; v_parent text;
  v_keys text[]; v_deleted text[]; v_full text[]; v_touched text[];
  v_before jsonb; v_after jsonb; v_change public.genre_changes;
begin
  if jsonb_typeof(p_after) is distinct from 'array' then
    raise exception 'genre_vocabulary_write: p_after must be an array';
  end if;
  if p_actor is null or not (p_actor = 'owner' or p_actor like 'system:%') then
    raise exception 'genre_vocabulary_write: actor must be owner or system:<job>';
  end if;
  if p_operation is null or p_operation not in ('rename','alias-add','alias-remove','merge','parent','umbrella-add',
       'umbrella-remove','spelling','create','undo','taxonomy-import','relations-import','relation-add',
       'relation-remove','relation-weight','family') then
    raise exception 'genre_vocabulary_write: unknown operation %', p_operation;
  end if;
  if coalesce(btrim(p_reason), '') = '' or coalesce(btrim(p_summary), '') = '' then
    raise exception 'genre_vocabulary_write: a reason and a summary are required';
  end if;

  perform pg_advisory_xact_lock(hashtext('public.genre_vocabulary_write'));

  select array_agg(x->>'key'),
         array_agg(x->>'key') filter (where jsonb_typeof(x->'image') is distinct from 'object'),
         array_agg(x->>'key') filter (where jsonb_typeof(x->'image') = 'object' and (x->'image') ? 'level')
    into v_keys, v_deleted, v_full
    from jsonb_array_elements(p_after) x;
  v_keys := coalesce(v_keys, '{}'); v_deleted := coalesce(v_deleted, '{}'); v_full := coalesce(v_full, '{}');
  if exists (select 1 from unnest(v_keys) k where coalesce(btrim(k), '') = '') then
    raise exception 'genre_vocabulary_write: every entry needs a key';
  end if;
  if (select count(*) from unnest(v_keys)) <> (select count(distinct k) from unnest(v_keys) k) then
    raise exception 'genre_vocabulary_write: a genre key is listed twice';
  end if;

  -- Touched: the listed genres, and any genre that loses an umbrella, a parent or a relation to a deleted one.
  select coalesce(array_agg(distinct k), '{}') into v_touched from (
    select unnest(v_keys) as k
    union select gu.genre_key from public.genre_umbrellas gu where gu.umbrella_key = any(v_deleted)
    union select g.key from public.genres g where g.primary_parent_key = any(v_deleted)
    union select gr.source_key from public.genre_relations gr where gr.target_key = any(v_deleted)
  ) t;
  perform 1 from public.genres g where g.key = any(v_touched) order by g.key for update;
  v_before := public.genre_vocabulary_images(v_touched);

  delete from public.genre_aliases where genre_key = any(v_keys);
  delete from public.genre_umbrellas where genre_key = any(v_keys);
  delete from public.genre_relations where source_key = any(v_full);
  delete from public.genres where key = any(v_deleted);

  -- Pass 1: every genre with an image, before any link or parent, so links between listed genres resolve.
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
    if v_image ? 'level' then
      insert into public.genres (key, name, parent, level, specificity_tier)
      values (v_key, btrim(v_image->>'name'), nullif(btrim(v_image->>'parent'), ''),
              v_image->>'level', nullif(btrim(v_image->>'tier'), ''))
      on conflict (key) do update
        set name = excluded.name, parent = excluded.parent, level = excluded.level,
            specificity_tier = excluded.specificity_tier, primary_parent_key = null, updated_at = now();
    else
      insert into public.genres (key, name, parent)
      values (v_key, btrim(v_image->>'name'), nullif(btrim(v_image->>'parent'), ''))
      on conflict (key) do update
        set name = excluded.name, parent = excluded.parent, updated_at = now();
    end if;
  end loop;

  -- Pass 2: primary parents, aliases, umbrellas and relations.
  for r in select * from jsonb_array_elements(p_after) loop
    v_image := r->'image';
    continue when jsonb_typeof(v_image) is distinct from 'object';
    v_key := r->>'key';

    if v_image ? 'level' then
      v_parent := nullif(btrim(v_image->>'primaryParent'), '');
      if v_parent is not null then
        if not exists (select 1 from public.genres g where g.key = v_parent) then
          raise exception 'genre_vocabulary_write: parent % of % does not exist', v_parent, v_key;
        end if;
        update public.genres set primary_parent_key = v_parent where key = v_key;
      end if;
    end if;

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

    continue when not (v_image ? 'level');
    for rel in select * from jsonb_array_elements(coalesce(v_image->'relations', '[]'::jsonb)) loop
      v_target := btrim(rel->>'target');
      if not exists (select 1 from public.genres g where g.key = v_target) then
        raise exception 'genre_vocabulary_write: relation target % of % does not exist', v_target, v_key;
      end if;
      insert into public.genre_relations (source_key, target_key, type, weight, origin)
      values (v_key, v_target, rel->>'type', (rel->>'weight')::numeric, rel->>'origin');
    end loop;
  end loop;

  -- Level rules, for every parent link that touches a listed genre (as child or as parent).
  if exists (
    select 1 from public.genres c join public.genres p on p.key = c.primary_parent_key
     where (c.key = any(v_keys) or p.key = any(v_keys))
       and not ((c.level = 'genre' and p.level = 'family') or (c.level = 'family' and p.level = 'macro'))
  ) then
    raise exception 'genre_vocabulary_write: a genre sits under a family and a family under a macro; a macro has no parent';
  end if;

  -- Relation rules, for every relation that touches a listed genre.
  if exists (
    select 1 from public.genre_relations gr
      join public.genres s on s.key = gr.source_key
      join public.genres t on t.key = gr.target_key
     where (gr.source_key = any(v_keys) or gr.target_key = any(v_keys))
       and not (
         (gr.type = 'secondary_parent' and s.level = 'genre' and t.level = 'family') or
         (gr.type in ('adjacent','derived_from') and s.level = 'genre' and t.level = 'genre'))
  ) then
    raise exception 'genre_vocabulary_write: secondary_parent runs genre to family; adjacent and derived_from run genre to genre';
  end if;
  if exists (
    select 1 from public.genre_relations x join public.genre_relations y
      on y.source_key = x.target_key and y.target_key = x.source_key and y.type = 'adjacent'
     where x.type = 'adjacent' and (x.source_key = any(v_keys) or x.target_key = any(v_keys))
  ) then
    raise exception 'genre_vocabulary_write: an adjacent pair is stored once, not in both directions';
  end if;
  for v_key, v_target in
    select gr.source_key, gr.target_key from public.genre_relations gr
     where gr.type = 'derived_from' and gr.source_key = any(v_keys)
  loop
    if exists (
      with recursive up(k) as (
        select v_target
        union
        select gr.target_key from public.genre_relations gr join up on gr.source_key = up.k and gr.type = 'derived_from'
      )
      select 1 from up where up.k = v_key
    ) then
      raise exception 'genre_vocabulary_write: % derived from % makes a loop', v_key, v_target;
    end if;
  end loop;

  -- A system actor never adds, removes or changes a 'curated' relation (the owner's own links).
  if p_actor like 'system:%' and (
    select coalesce(jsonb_agg(c order by c), '[]'::jsonb) from (
      select jsonb_build_object('s', b->>'key', 't', rr->>'target', 'y', rr->>'type', 'w', (rr->>'weight')::numeric) c
        from jsonb_array_elements(v_before) b, jsonb_array_elements(coalesce(b->'relations', '[]'::jsonb)) rr
       where rr->>'origin' = 'curated') x
  ) is distinct from (
    select coalesce(jsonb_agg(c order by c), '[]'::jsonb) from (
      select jsonb_build_object('s', gr.source_key, 't', gr.target_key, 'y', gr.type, 'w', gr.weight) c
        from public.genre_relations gr
       where gr.origin = 'curated' and gr.source_key = any(v_touched)) x
  ) then
    raise exception 'genre_vocabulary_write: a system job never changes a curated relation';
  end if;

  -- Umbrella loops, as in 0060.
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

-- 6. Read for the genres payload: every relation, shared data with no personal fields.
create or replace function public.genre_relations_list()
returns setof public.genre_relations
language sql stable set search_path = public, pg_temp as $$
  select * from public.genre_relations order by source_key, target_key, type;
$$;
revoke all on function public.genre_relations_list() from public, anon, authenticated;
grant execute on function public.genre_relations_list() to service_role;

-- Check (run after applying):
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'genres'
--      and column_name in ('level', 'primary_parent_key', 'specificity_tier');
--   -- expect 3 rows.
--   select c.relrowsecurity,
--          (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = 'genre_relations') as policies
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relname = 'genre_relations';
--   -- expect true and 0.
--   select count(*) from public.genres where level <> 'genre';
--   -- expect 0 until the tree is uploaded.
--
-- Rollback (removes the taxonomy and every relation; the 0060 functions must be re-created from 0060
-- afterwards). Run as one script:
--   drop function if exists public.genre_relations_list();
--   drop table if exists public.genre_relations;
--   delete from public.genres where level <> 'genre';
--   alter table public.genres drop constraint if exists genres_key_space,
--     drop constraint if exists genres_parent_not_self, drop constraint if exists genres_tier_check,
--     drop constraint if exists genres_level_check;
--   alter table public.genres drop column if exists specificity_tier, drop column if exists primary_parent_key,
--     drop column if exists level;
--   -- then run sections 4 to 6 of 0060_genre_vocabulary.sql again.
-- Stored artist genres (artist_genres, user_artist_genres) are not touched by this file or its rollback.
