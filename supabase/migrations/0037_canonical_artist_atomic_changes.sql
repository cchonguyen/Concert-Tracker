-- Canonical artist atomic apply and Undo (Global Archive, Store operation in docs/canonical-archive-ux-spec.md).
-- Not applied to the live database until Charlie's go.
--
-- Functions only: this migration changes no tables and no columns. Each function checks the
-- owner, has a fixed search_path, and is executable by authenticated and service_role only.
-- Authenticated callers must pass the members owner check inside the function; anon and public
-- callers get nothing.
--
--   canonical_artist_fingerprint(p_entry, p_user_id)           read-only. md5 of the current rows the change touches.
--   canonical_apply_artist_change(p_fingerprint, p_entry, p_user_id)
--       checks the owner, locks the touched rows, checks that the current rows equal the plan's "before"
--       side and match p_fingerprint, then writes the history entry and the "after" side.
--   canonical_undo_artist_change(p_history_id, p_user_id)
--       checks the owner, locks the touched rows, checks that the current rows equal the stored "after"
--       side, then writes "before".
--   canonical_artist_lock, canonical_artist_state, canonical_artist_write are helpers.
--
-- Owner-side writes are part of the same atomic apply and Undo: the owner's records, their aliases and
-- links, and the seen text of the owner's logged_events rows that a rename or merge rewrites. The
-- fingerprint and the Undo after-state check cover them too. Each seen-text change also writes its
-- activity_log rows (the same rows the TypeScript store writes): apply writes them from the entry's
-- "activity" list, and Undo writes one per seen text it puts back, with the stored text as "before".
--
-- p_user_id is null for the single-user store (tables entities, entity_aliases, entity_links, entity_history,
-- logged_events) and is the owner's auth id for the multi-user store (tables user_entities, user_entity_aliases,
-- user_entity_links, user_entity_history, and the logged_events rows with that user_id).
--
-- p_entry is built on the server from a fresh read of the current state. Clients never send it.
-- It is the history entry itself, and it is stored unchanged as the manifest:
--   {
--     "id": uuid, "operation": "canonical-rename" | "canonical-merge" | "canonical-alias-add" | "canonical-alias-remove",
--     "summary": text, "createdAt": iso-8601 text,
--     "canonical": {
--       "key": text,
--       "artists":      { "before": [ {key, name, mbid, resolved_at} ], "after": [ ... ] },
--       "performances": { "before": [ {id, edition_id, artist_key, name, days, stages, status, billing,
--                                      confidence, sources, slot_id, alias, b2b, set} ], "after": [ ... ] },
--       "aliases":      { "before": [ {alias, name} ], "after": [ ... ] },
--       "owner":        { "before": [ {id, kind, name, name_normalized, attrs, merged_into_id} ], "after": [ ... ] },
--       "ownerTouched": [ owner entity id, ... ],
--       "ownerAliases": { "before": [ {entity_id, kind, alias} ], "after": [ ... ] },
--       "ownerLinks":   { "before": [ {from_id, to_id, role, created_at} ], "after": [ ... ] },
--       "events":       { "before": [ {id, seen} ], "after": [ ... ] },
--       "activity":     [ {event_id, action: "update", field: "seen", before, after, sensitive} ]
--     }
--   }
-- Artists, performances and owner rows: each side holds the full current rows for the change's keys,
-- unchanged rows included, so the state check is exact. Aliases (artist AKAs) hold only the rows that change.
-- Owner aliases and links: each side holds the rows of the touched owner records (ownerTouched) as they
-- stand on that side. Events: each side holds the seen text of the rows the rewrite changes.
--
-- Atomicity: plpgsql runs the whole function body in one transaction. Any error (fingerprint mismatch,
-- shape error, failed write) rolls the whole call back, so no history entry or record change is kept.
-- Two applies on the same records run one after the other because the touched rows are locked first.

-- ---------------------------------------------------------------------------
-- Owner check. Authenticated callers must be members.user_id = auth.uid() with role 'owner'.
-- service_role is trusted (server-side calls only).
-- ---------------------------------------------------------------------------
create or replace function canonical_assert_owner(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() = 'service_role' then
    return;
  end if;
  if auth.uid() is null
     or not exists (select 1 from members m where m.user_id = auth.uid() and m.role = 'owner')
     or (p_user_id is not null and p_user_id <> auth.uid()) then
    raise exception 'Only the owner can do this.' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row projections. The same column list is used for the database rows and for the plan images,
-- so the state comparison is exact. Timestamps and other bookkeeping columns are left out.
-- ---------------------------------------------------------------------------
create or replace function canonical_json_artist(a canonical_artists)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object('key', a.key, 'name', a.name, 'mbid', a.mbid, 'resolved_at', a.resolved_at);
$$;

create or replace function canonical_json_perf(p performances)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p.id, 'edition_id', p.edition_id, 'artist_key', p.artist_key, 'name', p.name,
    'days', p.days, 'stages', p.stages, 'status', p.status, 'billing', p.billing,
    'confidence', p.confidence, 'sources', p.sources, 'slot_id', p.slot_id,
    'alias', p.alias, 'b2b', p.b2b, 'set', p."set"
  );
$$;

create or replace function canonical_json_entity(e entities)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', e.id, 'kind', e.kind, 'name', e.name, 'name_normalized', e.name_normalized,
    'attrs', e.attrs, 'merged_into_id', e.merged_into_id
  );
$$;

create or replace function canonical_json_user_entity(e user_entities)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', e.id, 'kind', e.kind, 'name', e.name, 'name_normalized', e.name_normalized,
    'attrs', e.attrs, 'merged_into_id', e.merged_into_id
  );
$$;

-- The artist keys a change touches: its own key and every artist key in its artist images.
create or replace function canonical_artist_keys(p_entry jsonb)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct s.k) filter (where s.k is not null), '{}'::text[])
  from (
    select p_entry #>> '{canonical,key}' as k
    union all
    select x ->> 'key'
      from jsonb_array_elements(
        coalesce(p_entry #> '{canonical,artists,before}', '[]'::jsonb)
        || coalesce(p_entry #> '{canonical,artists,after}', '[]'::jsonb)
      ) x
  ) s;
$$;

-- Locks every row a change reads or writes: artists, owner records, then events. Same order for apply and Undo.
create or replace function canonical_artist_lock(p_entry jsonb, p_user_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c jsonb := p_entry -> 'canonical';
  v_owner_ids uuid[] := array(select (x ->> 'id')::uuid
                                from jsonb_array_elements(coalesce(c #> '{owner,before}', '[]') || coalesce(c #> '{owner,after}', '[]')) x);
  v_touched uuid[] := array(select elem::uuid from jsonb_array_elements_text(coalesce(c -> 'ownerTouched', '[]')) elem);
  v_event_ids text[] := array(select x ->> 'id'
                                from jsonb_array_elements(coalesce(c #> '{events,before}', '[]') || coalesce(c #> '{events,after}', '[]')) x);
begin
  perform 1 from canonical_artists a where a.key = any(canonical_artist_keys(p_entry)) order by a.key for update;
  if p_user_id is null then
    perform 1 from entities e where e.id = any(v_owner_ids) or e.id = any(v_touched) order by e.id for update;
  else
    perform 1 from user_entities e
     where e.user_id = p_user_id and (e.id = any(v_owner_ids) or e.id = any(v_touched))
     order by e.id for update;
  end if;
  perform 1 from logged_events e
   where e.id = any(v_event_ids) and (p_user_id is null or e.user_id = p_user_id)
   order by e.id for update;
end;
$$;

-- The current state of everything a change touches ('db'), or the state a side of the plan describes
-- ('before' or 'after'). Both produce the same JSON shape, so they can be compared directly.
create or replace function canonical_artist_state(p_entry jsonb, p_source text, p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  c jsonb := p_entry -> 'canonical';
  v_keys text[] := canonical_artist_keys(p_entry);
  v_touched uuid[] := array(select elem::uuid from jsonb_array_elements_text(coalesce(c -> 'ownerTouched', '[]')) elem);
  v_all_perf jsonb;
  v_all_own jsonb;
  v_all_ali jsonb;
  v_all_oal jsonb;
  v_all_olk jsonb;
  v_all_evt jsonb;
  v_perf_ids uuid[];
  v_owner_ids uuid[];
  v_alias_keys text[];
  v_event_ids text[];
  v_art jsonb;
  v_perf jsonb;
  v_ali jsonb;
  v_own jsonb;
  v_oal jsonb;
  v_olk jsonb;
  v_evt jsonb;
begin
  if p_source not in ('db', 'before', 'after') then
    raise exception 'Unknown state source.' using errcode = '22023';
  end if;

  v_all_perf := coalesce(c #> '{performances,before}', '[]') || coalesce(c #> '{performances,after}', '[]');
  v_all_own := coalesce(c #> '{owner,before}', '[]') || coalesce(c #> '{owner,after}', '[]');
  v_all_ali := coalesce(c #> '{aliases,before}', '[]') || coalesce(c #> '{aliases,after}', '[]');
  v_all_oal := coalesce(c #> '{ownerAliases,before}', '[]') || coalesce(c #> '{ownerAliases,after}', '[]');
  v_all_olk := coalesce(c #> '{ownerLinks,before}', '[]') || coalesce(c #> '{ownerLinks,after}', '[]');
  v_all_evt := coalesce(c #> '{events,before}', '[]') || coalesce(c #> '{events,after}', '[]');
  v_perf_ids := array(select (x ->> 'id')::uuid from jsonb_array_elements(v_all_perf) x);
  v_owner_ids := array(select (x ->> 'id')::uuid from jsonb_array_elements(v_all_own) x);
  v_alias_keys := array(select distinct (x ->> 'alias') from jsonb_array_elements(v_all_ali) x);
  v_event_ids := array(select x ->> 'id' from jsonb_array_elements(v_all_evt) x);

  select coalesce(jsonb_agg(s.j order by s.j ->> 'key'), '[]'::jsonb) into v_art
  from (
    select canonical_json_artist(a) as j
      from canonical_artists a
     where p_source = 'db' and a.key = any(v_keys)
    union all
    select canonical_json_artist(r)
      from jsonb_populate_recordset(null::canonical_artists, coalesce(c #> array['artists', p_source], '[]')) r
  ) s;

  select coalesce(jsonb_agg(s.j order by s.j ->> 'id'), '[]'::jsonb) into v_perf
  from (
    select canonical_json_perf(p) as j
      from performances p
     where p_source = 'db' and (p.id = any(v_perf_ids) or p.artist_key = any(v_keys))
    union all
    select canonical_json_perf(r)
      from jsonb_populate_recordset(null::performances, coalesce(c #> array['performances', p_source], '[]')) r
  ) s;

  select coalesce(jsonb_agg(s.j order by s.j ->> 'alias'), '[]'::jsonb) into v_ali
  from (
    select jsonb_build_object('alias', l.alias_normalized, 'name', l.canonical_name) as j
      from artist_aliases l
     where p_source = 'db' and l.alias_normalized = any(v_alias_keys)
    union all
    select jsonb_build_object('alias', x ->> 'alias', 'name', x ->> 'name')
      from jsonb_array_elements(coalesce(c #> array['aliases', p_source], '[]')) x
  ) s;

  if p_user_id is null then
    select coalesce(jsonb_agg(s.j order by s.j ->> 'id'), '[]'::jsonb) into v_own
    from (
      select canonical_json_entity(e) as j
        from entities e
       where p_source = 'db' and e.kind = 'artist' and (e.id = any(v_owner_ids) or e.name_normalized = any(v_keys))
      union all
      select canonical_json_entity(r)
        from jsonb_populate_recordset(null::entities, coalesce(c #> array['owner', p_source], '[]')) r
    ) s;
  else
    select coalesce(jsonb_agg(s.j order by s.j ->> 'id'), '[]'::jsonb) into v_own
    from (
      select canonical_json_user_entity(e) as j
        from user_entities e
       where p_source = 'db' and e.user_id = p_user_id and e.kind = 'artist'
         and (e.id = any(v_owner_ids) or e.name_normalized = any(v_keys))
      union all
      select canonical_json_user_entity(r)
        from jsonb_populate_recordset(null::user_entities, coalesce(c #> array['owner', p_source], '[]')) r
    ) s;
  end if;

  -- Owner aliases and links: the rows of the touched owner records. Events: the seen text of the rows the rewrite changes.
  if p_user_id is null then
    select coalesce(jsonb_agg(s.j order by s.j::text), '[]'::jsonb) into v_oal
    from (
      select jsonb_build_object('entity_id', a.entity_id, 'kind', a.kind, 'alias', a.alias_normalized) as j
        from entity_aliases a
       where p_source = 'db' and a.entity_id = any(v_touched)
      union all
      select jsonb_build_object('entity_id', x ->> 'entity_id', 'kind', x ->> 'kind', 'alias', x ->> 'alias')
        from jsonb_array_elements(coalesce(c #> array['ownerAliases', p_source], '[]')) x
    ) s;

    select coalesce(jsonb_agg(s.j order by s.j::text), '[]'::jsonb) into v_olk
    from (
      select jsonb_build_object('from_id', l.from_id, 'to_id', l.to_id, 'role', l.role) as j
        from entity_links l
       where p_source = 'db' and (l.from_id = any(v_touched) or l.to_id = any(v_touched))
      union all
      select jsonb_build_object('from_id', x ->> 'from_id', 'to_id', x ->> 'to_id', 'role', x ->> 'role')
        from jsonb_array_elements(coalesce(c #> array['ownerLinks', p_source], '[]')) x
    ) s;
  else
    select coalesce(jsonb_agg(s.j order by s.j::text), '[]'::jsonb) into v_oal
    from (
      select jsonb_build_object('entity_id', a.entity_id, 'kind', a.kind, 'alias', a.companion_token) as j
        from user_entity_aliases a
       where p_source = 'db' and a.user_id = p_user_id and a.entity_id = any(v_touched)
      union all
      select jsonb_build_object('entity_id', x ->> 'entity_id', 'kind', x ->> 'kind', 'alias', x ->> 'alias')
        from jsonb_array_elements(coalesce(c #> array['ownerAliases', p_source], '[]')) x
    ) s;

    select coalesce(jsonb_agg(s.j order by s.j::text), '[]'::jsonb) into v_olk
    from (
      select jsonb_build_object('from_id', l.from_id, 'to_id', l.to_id, 'role', l.role) as j
        from user_entity_links l
       where p_source = 'db' and l.user_id = p_user_id and (l.from_id = any(v_touched) or l.to_id = any(v_touched))
      union all
      select jsonb_build_object('from_id', x ->> 'from_id', 'to_id', x ->> 'to_id', 'role', x ->> 'role')
        from jsonb_array_elements(coalesce(c #> array['ownerLinks', p_source], '[]')) x
    ) s;
  end if;

  select coalesce(jsonb_agg(s.j order by s.j::text), '[]'::jsonb) into v_evt
  from (
    select jsonb_build_object('id', e.id, 'seen', e.seen) as j
      from logged_events e
     where p_source = 'db' and e.id = any(v_event_ids) and (p_user_id is null or e.user_id = p_user_id)
    union all
    select jsonb_build_object('id', x ->> 'id', 'seen', x -> 'seen')
      from jsonb_array_elements(coalesce(c #> array['events', p_source], '[]')) x
  ) s;

  return jsonb_build_object(
    'artists', v_art, 'performances', v_perf, 'aliases', v_ali, 'owner', v_own,
    'ownerAliases', v_oal, 'ownerLinks', v_olk, 'events', v_evt
  );
end;
$$;

-- Writes the "to" side over the "from" side. Order: free MBIDs, remove performances, remove artists and AKAs,
-- then insert artists, performances and AKAs, then update owner records in place (records are never deleted),
-- then replace the owner aliases and links of the touched records, then rewrite the event seen text.
create or replace function canonical_artist_write(p_entry jsonb, p_from text, p_to text, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c jsonb := p_entry -> 'canonical';
  v_touched uuid[] := array(select elem::uuid from jsonb_array_elements_text(coalesce(c -> 'ownerTouched', '[]')) elem);
  v_owned int;
  v_events int;
begin
  update canonical_artists set mbid = null
   where key in (select x ->> 'key' from jsonb_array_elements(coalesce(c #> array['artists', p_from], '[]')) x)
     and mbid is not null;
  delete from performances
   where id in (select (x ->> 'id')::uuid from jsonb_array_elements(coalesce(c #> array['performances', p_from], '[]')) x);
  delete from canonical_artists
   where key in (select x ->> 'key' from jsonb_array_elements(coalesce(c #> array['artists', p_from], '[]')) x);
  delete from artist_aliases
   where alias_normalized in (select x ->> 'alias' from jsonb_array_elements(coalesce(c #> array['aliases', p_from], '[]')) x);

  insert into canonical_artists (key, name, mbid, resolved_at)
  select r.key, r.name, r.mbid, r.resolved_at
    from jsonb_populate_recordset(null::canonical_artists, coalesce(c #> array['artists', p_to], '[]')) r;

  insert into performances (id, edition_id, artist_key, name, days, stages, status, billing, confidence, sources,
                            slot_id, alias, b2b, "set")
  select r.id, r.edition_id, r.artist_key, r.name, r.days, r.stages, r.status, r.billing, r.confidence, r.sources,
         r.slot_id, r.alias, r.b2b, r."set"
    from jsonb_populate_recordset(null::performances, coalesce(c #> array['performances', p_to], '[]')) r;

  insert into artist_aliases (alias_normalized, canonical_name)
  select x ->> 'alias', x ->> 'name'
    from jsonb_array_elements(coalesce(c #> array['aliases', p_to], '[]')) x;

  if p_user_id is null then
    update entities t
       set kind = r.kind, name = r.name, name_normalized = r.name_normalized,
           attrs = r.attrs, merged_into_id = r.merged_into_id, updated_at = now()
      from jsonb_populate_recordset(null::entities, coalesce(c #> array['owner', p_to], '[]')) r
     where t.id = r.id;
  else
    update user_entities t
       set kind = r.kind, name = r.name, name_normalized = r.name_normalized,
           attrs = r.attrs, merged_into_id = r.merged_into_id, updated_at = now()
      from jsonb_populate_recordset(null::user_entities, coalesce(c #> array['owner', p_to], '[]')) r
     where t.user_id = p_user_id and t.id = r.id;
  end if;
  get diagnostics v_owned = row_count;
  if v_owned <> jsonb_array_length(coalesce(c #> array['owner', p_to], '[]')) then
    raise exception 'Preview is out of date; review it again' using errcode = 'P0409';
  end if;

  -- Owner aliases and links of the touched records: replaced as sets, after the entity rows they point at are written.
  if p_user_id is null then
    delete from entity_aliases where entity_id = any(v_touched);
    insert into entity_aliases (entity_id, kind, alias_normalized)
    select (x ->> 'entity_id')::uuid, x ->> 'kind', x ->> 'alias'
      from jsonb_array_elements(coalesce(c #> array['ownerAliases', p_to], '[]')) x;

    delete from entity_links where from_id = any(v_touched) or to_id = any(v_touched);
    insert into entity_links (from_id, to_id, role, created_at)
    select (x ->> 'from_id')::uuid, (x ->> 'to_id')::uuid, x ->> 'role',
           coalesce((x ->> 'created_at')::timestamptz, now())
      from jsonb_array_elements(coalesce(c #> array['ownerLinks', p_to], '[]')) x;
  else
    delete from user_entity_aliases where user_id = p_user_id and entity_id = any(v_touched);
    insert into user_entity_aliases (user_id, entity_id, kind, companion_token)
    select p_user_id, (x ->> 'entity_id')::uuid, x ->> 'kind', x ->> 'alias'
      from jsonb_array_elements(coalesce(c #> array['ownerAliases', p_to], '[]')) x;

    delete from user_entity_links where user_id = p_user_id and (from_id = any(v_touched) or to_id = any(v_touched));
    insert into user_entity_links (user_id, from_id, to_id, role, created_at)
    select p_user_id, (x ->> 'from_id')::uuid, (x ->> 'to_id')::uuid, x ->> 'role',
           coalesce((x ->> 'created_at')::timestamptz, now())
      from jsonb_array_elements(coalesce(c #> array['ownerLinks', p_to], '[]')) x;
  end if;

  -- Event seen text: only the seen column of rows already in the plan. No rows are inserted or deleted.
  update logged_events e
     set seen = x -> 'seen', updated_at = now()
    from jsonb_array_elements(coalesce(c #> array['events', p_to], '[]')) x
   where e.id = (x ->> 'id') and (p_user_id is null or e.user_id = p_user_id);
  get diagnostics v_events = row_count;
  if v_events <> jsonb_array_length(coalesce(c #> array['events', p_to], '[]')) then
    raise exception 'Preview is out of date; review it again' using errcode = 'P0409';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public functions (service_role only).
-- ---------------------------------------------------------------------------
create or replace function canonical_artist_fingerprint(p_entry jsonb, p_user_id uuid default null)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform canonical_assert_owner(p_user_id);
  return md5(canonical_artist_state(p_entry, 'db', p_user_id)::text);
end;
$$;

create or replace function canonical_apply_artist_change(p_fingerprint text, p_entry jsonb, p_user_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c jsonb := p_entry -> 'canonical';
  v_path text;
  v_op text := p_entry ->> 'operation';
  v_id uuid := (p_entry ->> 'id')::uuid;
  v_activity int;
begin
  perform canonical_assert_owner(p_user_id);

  if v_op not in ('canonical-rename', 'canonical-merge', 'canonical-alias-add', 'canonical-alias-remove') then
    raise exception 'Not a canonical artist operation.' using errcode = '22023';
  end if;
  if v_id is null or jsonb_typeof(c) is distinct from 'object' then
    raise exception 'The change has no id or canonical block.' using errcode = '22023';
  end if;
  foreach v_path in array array['{artists,before}', '{artists,after}', '{performances,before}', '{performances,after}',
                                '{aliases,before}', '{aliases,after}', '{owner,before}', '{owner,after}',
                                '{ownerAliases,before}', '{ownerAliases,after}', '{ownerLinks,before}', '{ownerLinks,after}',
                                '{events,before}', '{events,after}', '{activity}'] loop
    if jsonb_typeof(coalesce(c #> v_path::text[], '[]')) <> 'array' then
      raise exception 'Each side of the change must be a list.' using errcode = '22023';
    end if;
  end loop;
  if jsonb_typeof(coalesce(c -> 'ownerTouched', '[]')) <> 'array' then
    raise exception 'The touched owner records must be a list.' using errcode = '22023';
  end if;

  -- Lock the touched rows so concurrent applies or Undos on the same records wait.
  perform canonical_artist_lock(p_entry, p_user_id);

  -- Fingerprint and plan check: the current rows must equal the plan's "before" side and match the fingerprint.
  if canonical_artist_state(p_entry, 'db', p_user_id) is distinct from canonical_artist_state(p_entry, 'before', p_user_id)
     or md5(canonical_artist_state(p_entry, 'db', p_user_id)::text) is distinct from p_fingerprint then
    raise exception 'Preview is out of date; review it again' using errcode = 'P0409';
  end if;

  -- History first, in this same transaction: the entry holds what Undo needs.
  if p_user_id is null then
    insert into entity_history (id, operation, manifest, created_at)
    values (v_id, v_op, p_entry, coalesce((p_entry ->> 'createdAt')::timestamptz, now()));
  else
    insert into user_entity_history (user_id, id, operation, manifest, created_at)
    values (p_user_id, v_id, v_op, p_entry, coalesce((p_entry ->> 'createdAt')::timestamptz, now()));
  end if;

  perform canonical_artist_write(p_entry, 'before', 'after', p_user_id);

  -- Activity rows for the seen-text rewrite, written after it in this transaction. Owner: the owner's id.
  insert into activity_log (user_id, event_id, action, field, before_value, after_value, sensitive, created_at)
  select coalesce(p_user_id, owner_user_id()), x ->> 'event_id', x ->> 'action', x ->> 'field',
         nullif(x -> 'before', 'null'::jsonb), nullif(x -> 'after', 'null'::jsonb), (x ->> 'sensitive')::boolean,
         coalesce((p_entry ->> 'createdAt')::timestamptz, now())
    from jsonb_array_elements(coalesce(c -> 'activity', '[]'::jsonb)) x;
  get diagnostics v_activity = row_count;
  if v_activity <> jsonb_array_length(coalesce(c -> 'activity', '[]'::jsonb)) then
    raise exception 'Preview is out of date; review it again' using errcode = 'P0409';
  end if;

  return jsonb_build_object('id', v_id, 'operation', v_op);
end;
$$;

create or replace function canonical_undo_artist_change(p_history_id uuid, p_user_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entry jsonb;
  v_undone timestamptz;
  v_undo_activity jsonb;
  v_activity int;
begin
  perform canonical_assert_owner(p_user_id);

  if p_user_id is null then
    select h.manifest, h.undone_at into v_entry, v_undone
      from entity_history h where h.id = p_history_id for update;
  else
    select h.manifest, h.undone_at into v_entry, v_undone
      from user_entity_history h where h.user_id = p_user_id and h.id = p_history_id for update;
  end if;
  if not found then
    raise exception 'No such change.' using errcode = 'P0002';
  end if;
  if jsonb_typeof(v_entry -> 'canonical') is distinct from 'object' then
    raise exception 'That change is not a canonical artist change.' using errcode = '22023';
  end if;
  if v_undone is not null then
    raise exception 'That change was already undone.' using errcode = 'P0409';
  end if;

  perform canonical_artist_lock(v_entry, p_user_id);

  -- Check the current after-state before restoring the before-state.
  if canonical_artist_state(v_entry, 'db', p_user_id) is distinct from canonical_artist_state(v_entry, 'after', p_user_id) then
    raise exception 'Those records changed after this. Undo the later change first.' using errcode = 'P0409';
  end if;

  perform canonical_artist_write(v_entry, 'after', 'before', p_user_id);

  -- Activity rows for the seen text put back, as the TypeScript undo logs them: the text before the undo
  -- ("before") and the restored text ("after"), for each event whose seen text differs. Built from the entry,
  -- which the after-state check above has just confirmed matches the database.
  select coalesce(jsonb_agg(jsonb_build_object('event_id', a.id, 'action', 'update', 'field', 'seen',
                                                 'before', a.seen, 'after', b.seen, 'sensitive', false)), '[]'::jsonb)
    into v_undo_activity
    from (select x ->> 'id' as id, x -> 'seen' as seen from jsonb_array_elements(coalesce(v_entry #> '{canonical,events,after}', '[]'::jsonb)) x) a
    join (select x ->> 'id' as id, x -> 'seen' as seen from jsonb_array_elements(coalesce(v_entry #> '{canonical,events,before}', '[]'::jsonb)) x) b
      on b.id = a.id
   where a.seen is distinct from b.seen;

  insert into activity_log (user_id, event_id, action, field, before_value, after_value, sensitive, created_at)
  select coalesce(p_user_id, owner_user_id()), x ->> 'event_id', x ->> 'action', x ->> 'field',
         nullif(x -> 'before', 'null'::jsonb), nullif(x -> 'after', 'null'::jsonb), (x ->> 'sensitive')::boolean, now()
    from jsonb_array_elements(v_undo_activity) x;
  get diagnostics v_activity = row_count;
  if v_activity <> jsonb_array_length(v_undo_activity) then
    raise exception 'Preview is out of date; review it again' using errcode = 'P0409';
  end if;

  if p_user_id is null then
    update entity_history set undone_at = now() where id = p_history_id;
  else
    update user_entity_history set undone_at = now() where user_id = p_user_id and id = p_history_id;
  end if;
  return jsonb_build_object('id', p_history_id, 'undone', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: nothing for public or anon. authenticated and service_role may run the three public functions;
-- the owner check inside each function decides who may act.
-- ---------------------------------------------------------------------------
revoke all on function canonical_assert_owner(uuid) from public, anon, authenticated, service_role;
revoke all on function canonical_json_artist(canonical_artists) from public, anon, authenticated, service_role;
revoke all on function canonical_json_perf(performances) from public, anon, authenticated, service_role;
revoke all on function canonical_json_entity(entities) from public, anon, authenticated, service_role;
revoke all on function canonical_json_user_entity(user_entities) from public, anon, authenticated, service_role;
revoke all on function canonical_artist_keys(jsonb) from public, anon, authenticated, service_role;
revoke all on function canonical_artist_lock(jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function canonical_artist_state(jsonb, text, uuid) from public, anon, authenticated, service_role;
revoke all on function canonical_artist_write(jsonb, text, text, uuid) from public, anon, authenticated, service_role;

revoke all on function canonical_artist_fingerprint(jsonb, uuid) from public, anon;
revoke all on function canonical_apply_artist_change(text, jsonb, uuid) from public, anon;
revoke all on function canonical_undo_artist_change(uuid, uuid) from public, anon;
grant execute on function canonical_artist_fingerprint(jsonb, uuid) to authenticated, service_role;
grant execute on function canonical_apply_artist_change(text, jsonb, uuid) to authenticated, service_role;
grant execute on function canonical_undo_artist_change(uuid, uuid) to authenticated, service_role;
