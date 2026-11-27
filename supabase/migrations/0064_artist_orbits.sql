-- 0064: artist orbits, Release 3 (docs/specs/genre-taxonomy-release-3.md, section 2, approved by Charlie 2026-11-27).
-- An orbit is the owner's shared curation of a few acts that belong together (2 to 4 anchors), with its members
-- and how central each one is. Written only through artist_orbits_write, logged in artist_orbit_changes and
-- undoable through artist_orbits_undo. Shared data: no personal fields, never counted in a genre total.
-- Safe to run twice.

-- 1. Orbits. An anchor is always a member at centrality 1.0; the write function enforces that.
create table if not exists public.artist_orbits (
  id text primary key,
  anchor_keys text[] not null check (cardinality(anchor_keys) between 2 and 4),
  working_label text,                   -- the owner's working name; may be null
  parent_genre_key text references public.genres (key) on delete set null,
  origin text not null default 'curated' check (origin in ('curated','lineup_cluster','hybrid')),
  updated_at timestamptz not null default now(),
  check (btrim(id) <> '')
);

-- 2. Members. An artist key is the shared artist key (no personal fields).
create table if not exists public.artist_orbit_members (
  orbit_id text not null references public.artist_orbits (id) on delete cascade,
  artist_key text not null,
  centrality numeric not null check (centrality in (1.0, 0.5, 0.25)),
  primary key (orbit_id, artist_key),
  check (btrim(artist_key) <> '')
);
create index if not exists artist_orbit_members_artist_idx on public.artist_orbit_members (artist_key);

-- 3. The log. Each row holds the orbit images before and after one write or undo.
create table if not exists public.artist_orbit_changes (
  id uuid primary key default gen_random_uuid(),
  old jsonb,                            -- the images of the orbits as they were (null: none)
  new jsonb,                            -- the images of the orbits as they became (null: none)
  actor text not null check (actor = 'owner' or actor like 'system:%'),
  reason text,
  at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by text
);
create index if not exists artist_orbit_changes_at_idx on public.artist_orbit_changes (at desc);

alter table public.artist_orbits enable row level security;          -- no policies: server only
alter table public.artist_orbit_members enable row level security;
alter table public.artist_orbit_changes enable row level security;
revoke all on public.artist_orbits, public.artist_orbit_members, public.artist_orbit_changes from anon, authenticated;

-- 4. Images: the orbits named (null: all), each with its members. Ordered by id, then by centrality and key,
--    so an image compares equal to an earlier image of the same orbits.
create or replace function public.artist_orbits_images(ids text[])
returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', o.id,
             'anchorKeys', to_jsonb(o.anchor_keys),
             'workingLabel', o.working_label,
             'parentGenreKey', o.parent_genre_key,
             'origin', o.origin,
             'members', coalesce((select jsonb_agg(jsonb_build_object('artistKey', m.artist_key, 'centrality', m.centrality)
                                                   order by m.centrality desc, m.artist_key)
                                    from public.artist_orbit_members m where m.orbit_id = o.id), '[]'::jsonb))
           order by o.id), '[]'::jsonb)
  from public.artist_orbits o
  where ids is null or o.id = any(ids);
$$;
revoke all on function public.artist_orbits_images(text[]) from public, anon, authenticated;
grant execute on function public.artist_orbits_images(text[]) to service_role;

-- 5. Insert orbit images with their members. Used by the write and by the undo, never granted to the API roles.
--    Refused: an empty id, an orbit or member listed twice, an anchor listed at a centrality other than 1.0.
--    An anchor that is not listed as a member is added at 1.0.
create or replace function public.artist_orbits_insert(p_images jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  x jsonb; m jsonb;
  v_id text; v_anchors text[]; v_key text; v_anchor text; v_existing numeric;
begin
  if jsonb_typeof(p_images) is distinct from 'array' then
    raise exception 'artist_orbits: images must be an array';
  end if;
  for x in select * from jsonb_array_elements(p_images) loop
    v_id := btrim(x->>'id');
    if coalesce(v_id, '') = '' then
      raise exception 'artist_orbits: every orbit needs an id';
    end if;
    if jsonb_typeof(x->'anchorKeys') is distinct from 'array' then
      raise exception 'artist_orbits: orbit % needs anchorKeys', v_id;
    end if;
    select coalesce(array_agg(btrim(t.a) order by t.n), '{}') into v_anchors
      from jsonb_array_elements_text(x->'anchorKeys') with ordinality as t(a, n);
    if (select count(distinct a) from unnest(v_anchors) a) <> cardinality(v_anchors) then
      raise exception 'artist_orbits: an anchor of % is listed twice', v_id;
    end if;

    insert into public.artist_orbits (id, anchor_keys, working_label, parent_genre_key, origin, updated_at)
    values (v_id, v_anchors, nullif(btrim(x->>'workingLabel'), ''), nullif(btrim(x->>'parentGenreKey'), ''),
            coalesce(nullif(btrim(x->>'origin'), ''), 'curated'), now());

    for m in select * from jsonb_array_elements(coalesce(x->'members', '[]'::jsonb)) loop
      v_key := btrim(m->>'artistKey');
      if exists (select 1 from public.artist_orbit_members mm where mm.orbit_id = v_id and mm.artist_key = v_key) then
        raise exception 'artist_orbits: % is listed twice in orbit %', v_key, v_id;
      end if;
      insert into public.artist_orbit_members (orbit_id, artist_key, centrality)
      values (v_id, v_key, (m->>'centrality')::numeric);
    end loop;

    foreach v_anchor in array v_anchors loop
      select mm.centrality into v_existing from public.artist_orbit_members mm
       where mm.orbit_id = v_id and mm.artist_key = v_anchor;
      if not found then
        insert into public.artist_orbit_members (orbit_id, artist_key, centrality) values (v_id, v_anchor, 1.0);
      elsif v_existing <> 1.0 then
        raise exception 'artist_orbits: anchor % of orbit % must have centrality 1.0', v_anchor, v_id;
      end if;
    end loop;
  end loop;
end $$;
revoke all on function public.artist_orbits_insert(jsonb) from public, anon, authenticated;

-- 6. One write. Replaces the orbits named in replace_ids and in next (deleting them, members with them),
--    inserts next, and logs one change with the images before and after. Returns the change id.
--    next: [{ id, anchorKeys, workingLabel?, parentGenreKey?, origin?, members: [{ artistKey, centrality }] }]
create or replace function public.artist_orbits_write(
  next jsonb, replace_ids text[], actor text, reason text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ids text[]; v_touch text[]; v_old jsonb; v_new jsonb; v_change_id uuid;
begin
  if jsonb_typeof(next) is distinct from 'array' then
    raise exception 'artist_orbits_write: next must be an array';
  end if;
  if actor is null or not (actor = 'owner' or actor like 'system:%') then
    raise exception 'artist_orbits_write: actor must be owner or system:<job>';
  end if;
  if coalesce(btrim(reason), '') = '' then
    raise exception 'artist_orbits_write: a reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtext('public.artist_orbits_write'));

  select coalesce(array_agg(btrim(x->>'id')), '{}') into v_ids from jsonb_array_elements(next) x;
  if exists (select 1 from unnest(v_ids) i where coalesce(i, '') = '') then
    raise exception 'artist_orbits_write: every orbit needs an id';
  end if;
  if exists (select 1 from unnest(v_ids) i group by i having count(*) > 1) then
    raise exception 'artist_orbits_write: an orbit id is listed twice';
  end if;

  select coalesce(array_agg(distinct t) filter (where t is not null), '{}') into v_touch
    from unnest(coalesce(replace_ids, '{}') || v_ids) t;

  perform 1 from public.artist_orbits o where o.id = any(v_touch) order by o.id for update;
  v_old := public.artist_orbits_images(v_touch);

  delete from public.artist_orbits where id = any(v_touch);
  perform public.artist_orbits_insert(next);
  v_new := public.artist_orbits_images(v_ids);

  insert into public.artist_orbit_changes (old, new, actor, reason)
  values (v_old, v_new, actor, reason)
  returning id into v_change_id;
  return v_change_id;
end $$;
revoke all on function public.artist_orbits_write(jsonb, text[], text, text) from public, anon, authenticated;
grant execute on function public.artist_orbits_write(jsonb, text[], text, text) to service_role;

-- 7. Undo. Refused when the change is already undone, or when any orbit in its 'new' image has changed since
--    (stale). Otherwise the orbits in 'new' and 'old' are replaced by the 'old' images, the change is marked
--    undone, and a new change row (reason 'Undo') is logged. Returns the id of that new row.
create or replace function public.artist_orbits_undo(change_id uuid, actor text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_change public.artist_orbit_changes; v_new_ids text[]; v_ids text[];
  v_before jsonb; v_after jsonb; v_log_id uuid; v_actor text;
begin
  v_actor := actor;
  if actor is null or not (actor = 'owner' or actor like 'system:%') then
    raise exception 'artist_orbits_undo: actor must be owner or system:<job>';
  end if;

  perform pg_advisory_xact_lock(hashtext('public.artist_orbits_write'));

  select * into v_change from public.artist_orbit_changes c where c.id = change_id for update;
  if not found then
    raise exception 'artist_orbits_undo: no such change';
  end if;
  if v_change.undone_at is not null then
    raise exception 'artist_orbits_undo: change % is already undone', change_id;
  end if;

  select coalesce(array_agg(x->>'id'), '{}') into v_new_ids
    from jsonb_array_elements(coalesce(v_change.new, '[]'::jsonb)) x;
  if public.artist_orbits_images(v_new_ids) is distinct from coalesce(v_change.new, '[]'::jsonb) then
    raise exception 'artist_orbits_undo: change % is stale, an orbit changed after it', change_id;
  end if;

  select coalesce(array_agg(distinct i), '{}') into v_ids from (
    select x->>'id' as i from jsonb_array_elements(coalesce(v_change.new, '[]'::jsonb)) x
    union
    select x->>'id' from jsonb_array_elements(coalesce(v_change.old, '[]'::jsonb)) x) t;

  v_before := public.artist_orbits_images(v_ids);
  delete from public.artist_orbits where id = any(v_ids);
  perform public.artist_orbits_insert(coalesce(v_change.old, '[]'::jsonb));
  v_after := public.artist_orbits_images(v_ids);

  update public.artist_orbit_changes set undone_at = now(), undone_by = v_actor where id = change_id;
  insert into public.artist_orbit_changes (old, new, actor, reason)
  values (v_before, v_after, actor, 'Undo')
  returning id into v_log_id;
  return v_log_id;
end $$;
revoke all on function public.artist_orbits_undo(uuid, text) from public, anon, authenticated;
grant execute on function public.artist_orbits_undo(uuid, text) to service_role;

-- Check (run after applying):
--   select c.relrowsecurity,
--          (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = 'artist_orbits') as policies
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relname = 'artist_orbits';
--   -- expect true and 0.
--
-- Rollback (removes every orbit and its log; nothing else is touched). Run as one script:
--   drop function if exists public.artist_orbits_undo(uuid, text);
--   drop function if exists public.artist_orbits_write(jsonb, text[], text, text);
--   drop function if exists public.artist_orbits_insert(jsonb);
--   drop function if exists public.artist_orbits_images(text[]);
--   drop table if exists public.artist_orbit_changes;
--   drop table if exists public.artist_orbit_members;
--   drop table if exists public.artist_orbits;
