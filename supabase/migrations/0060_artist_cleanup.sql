-- 0060 artist entity cleanup (docs/specs/artist-entity-cleanup.md). Apply only on Charlie's go.
-- Adds canonical_artists.alter_ego_of (FK to canonical_artists.key) and extraction_blocklist.reason,
-- plus the reusable single-transaction RPC public.canonical_artist_cleanup(...) with dry-run rollback.

-- 1. Additive schema columns.
alter table public.canonical_artists
  add column if not exists alter_ego_of text references public.canonical_artists(key) on delete set null;

alter table public.extraction_blocklist
  add column if not exists reason text;

-- 2. Reusable single-transaction artist cleanup RPC (service_role only).
--    p_rows: parsed ArtistCleanupRow[] JSON array from artistCleanupCsv.ts.
--    p_dry_run: when true, runs the full cleanup in a subtransaction and rolls back via SQLSTATE 'P0099'.
--    p_owner_user_id: when set (multi-user), scopes personal follow-through to that owner's logged_events & user_entities;
--                     when null (single-user), updates logged_events & entities. Never touches other members' rows.
create or replace function public.canonical_artist_cleanup(
  p_rows jsonb,
  p_dry_run boolean default true,
  p_actor text default 'system:artist-cleanup',
  p_reason text default 'Artist entity cleanup',
  p_owner_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row jsonb;
  v_line int;
  v_artist text;
  v_artist_key text;
  v_mbid text;
  v_status text;
  v_invalid_reason text;
  v_canonical_artist text;
  v_canonical_key text;
  v_canonical_target_key text;
  v_canonical_new_key text;
  v_set_qual text;
  v_combo_alias text;
  v_alter_ego_of text;
  v_alter_ego_key text;
  v_alter_ego_target_key text;

  v_src public.canonical_artists%rowtype;
  v_tgt public.canonical_artists%rowtype;
  v_parent public.canonical_artists%rowtype;
  v_split_item jsonb;
  v_split_name text;
  v_split_key_raw text;
  v_split_norm_key text;
  v_split_resolved_keys text[];
  v_split_resolved_names text[];
  v_b2b_keys text[];
  v_slot_id text;

  v_perf public.performances%rowtype;
  v_existing_perf public.performances%rowtype;
  v_genre public.artist_genres%rowtype;
  v_before jsonb;
  v_after jsonb;

  v_counts jsonb := jsonb_build_object(
    'invalid_non_artist', 0,
    'merge_duplicate', 0,
    'remap_set', 0,
    'split_multi_artist', 0,
    'rename', 0,
    'link_alter_ego', 0
  );
  v_total_rows int := 0;
  v_perfs_migrated int := 0;
  v_perfs_deduped int := 0;
  v_new_artists int := 0;
  v_parent_stubs int := 0;
  v_owner_events_updated int := 0;
  v_failed jsonb := '[]'::jsonb;
  v_report jsonb;

  v_deprecated_keys text[] := '{}'::text[];
  v_invalid_norms text[] := '{}'::text[];
  v_remaining_deprecated int := 0;
  v_orphaned_perfs int := 0;
  v_missing_blocklist int := 0;

  v_evt record;
  v_new_seen jsonb;
  v_seen_elem jsonb;
  v_seen_changed boolean;
  v_seen_slot text;
  v_idx int;
  v_ent_id uuid;
  v_tgt_ent_id uuid;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;

  begin
    -- Upfront snapshot of pre-rename artist names/keys so artist:<Original> targets resolve
    -- even when another row in the same batch renames that artist.
    create temp table _orig_artists (
      key text primary key,
      name text not null,
      mbid text
    ) on commit drop;

    insert into _orig_artists (key, name, mbid)
    select a.key, a.name, a.mbid from public.canonical_artists a;

    -- Process rows in strict 6-stage order.
    for v_row in
      select value
      from jsonb_array_elements(p_rows) with ordinality as t(value, ord)
      order by
        case value->>'status'
          when 'invalid_non_artist' then 1
          when 'merge_duplicate' then 2
          when 'remap_set' then 3
          when 'split_multi_artist' then 4
          when 'rename' then 5
          when 'link_alter_ego' then 6
          else 99
        end,
        coalesce((value->>'line')::int, ord::int)
    loop
      v_total_rows := v_total_rows + 1;
      v_line := coalesce((v_row->>'line')::int, 0);
      v_artist := coalesce(v_row->>'artist', '');
      v_artist_key := coalesce(v_row->>'artistKey', '');
      v_mbid := nullif(trim(coalesce(v_row->>'mbid', '')), '');
      v_status := coalesce(v_row->>'status', '');
      v_invalid_reason := nullif(trim(coalesce(v_row->>'invalidReason', '')), '');
      v_canonical_artist := coalesce(v_row->>'canonicalArtist', '');
      v_canonical_key := coalesce(v_row->>'canonicalKey', '');
      v_canonical_target_key := coalesce(v_row->>'canonicalTargetKey', '');
      v_canonical_new_key := coalesce(v_row->>'canonicalNewKey', '');
      v_set_qual := nullif(trim(coalesce(v_row->>'setQualifier', '')), '');
      v_combo_alias := nullif(trim(coalesce(v_row->>'comboAlias', '')), '');
      v_alter_ego_of := nullif(trim(coalesce(v_row->>'alterEgoOf', '')), '');
      v_alter_ego_key := coalesce(v_row->>'alterEgoOfKey', '');
      v_alter_ego_target_key := coalesce(v_row->>'alterEgoTargetKey', '');

      if v_counts ? v_status then
        v_counts := jsonb_set(v_counts, array[v_status], to_jsonb(((v_counts->>v_status)::int) + 1));
      end if;

      -- 1. Resolve source row: MBID first, then exact name (preserving \xa0), then normalized key.
      v_src := null;
      if v_mbid is not null then
        select * into v_src from public.canonical_artists where mbid = v_mbid limit 1;
      end if;
      if v_src.key is null then
        select * into v_src from public.canonical_artists where name = v_artist limit 1;
      end if;
      if v_src.key is null and v_artist_key <> '' then
        select * into v_src from public.canonical_artists where key = v_artist_key limit 1;
      end if;

      -- =====================================================================
      -- 1) invalid_non_artist
      -- =====================================================================
      if v_status = 'invalid_non_artist' then
        v_invalid_norms := array_append(v_invalid_norms, coalesce(nullif(v_artist_key, ''), lower(trim(v_artist))));
        insert into public.extraction_blocklist (domain, normalized, rejections, reason)
        values ('*', coalesce(nullif(v_artist_key, ''), lower(trim(v_artist))), 1, v_invalid_reason)
        on conflict (domain, normalized) do update
          set rejections = public.extraction_blocklist.rejections + 1,
              reason = coalesce(excluded.reason, public.extraction_blocklist.reason);

        if v_src.key is not null then
          v_deprecated_keys := array_append(v_deprecated_keys, v_src.key);
          delete from public.performances where artist_key = v_src.key;
          delete from public.seen_sets where artist_key = v_src.key;
          for v_genre in select * from public.artist_genres where artist_key = v_src.key loop
            v_before := to_jsonb(v_genre);
            delete from public.artist_genres where artist_key = v_genre.artist_key and source = v_genre.source;
            insert into public.artist_genre_changes (artist_key, source, actor, reason, before, after)
            values (v_genre.artist_key, v_genre.source, p_actor, p_reason || ' (invalid_non_artist)', v_before, null);
          end loop;
          update public.canonical_artists set alter_ego_of = null where alter_ego_of = v_src.key;
          delete from public.canonical_artists where key = v_src.key;
        end if;

        -- Owner personal log follow-through (remove bogus seen entries).
        for v_evt in
          select id, seen from public.logged_events
          where deleted_at is null
            and jsonb_typeof(seen) = 'array'
            and (p_owner_user_id is null or user_id = p_owner_user_id)
        loop
          v_new_seen := '[]'::jsonb;
          v_seen_changed := false;
          for v_seen_elem in select * from jsonb_array_elements(v_evt.seen) loop
            if (v_src.key is not null and v_seen_elem->>'key' = v_src.key)
               or (v_artist_key <> '' and v_seen_elem->>'key' = v_artist_key)
               or v_seen_elem->>'name' = v_artist then
              v_seen_changed := true;
            else
              v_new_seen := v_new_seen || jsonb_build_array(v_seen_elem);
            end if;
          end loop;
          if v_seen_changed then
            update public.logged_events set seen = v_new_seen where id = v_evt.id;
            v_owner_events_updated := v_owner_events_updated + 1;
          end if;
        end loop;

      -- =====================================================================
      -- 2) merge_duplicate & 3) remap_set
      -- =====================================================================
      elsif v_status in ('merge_duplicate', 'remap_set') then
        v_tgt := null;
        if v_canonical_key like 'mbid:%' then
          select * into v_tgt from public.canonical_artists where mbid = substr(v_canonical_key, 6) limit 1;
        elsif v_canonical_key like 'artist:%' then
          select a.* into v_tgt
          from _orig_artists o
          join public.canonical_artists a on a.key = o.key
          where o.name = substr(v_canonical_key, 8)
          limit 1;
          if v_tgt.key is null and v_canonical_target_key <> '' then
            select * into v_tgt from public.canonical_artists where key = v_canonical_target_key limit 1;
          end if;
        end if;

        if v_tgt.key is null then
          v_failed := v_failed || jsonb_build_array(jsonb_build_object(
            'line', v_line, 'artist', v_artist, 'status', v_status,
            'targetKey', v_canonical_key, 'reason', 'Target artist not found'
          ));
          continue;
        end if;

        -- Save spelling alias / remap rule.
        if v_artist_key <> '' and v_artist_key <> v_tgt.key then
          insert into public.artist_aliases (alias_normalized, canonical_name)
          values (v_artist_key, v_tgt.name)
          on conflict (alias_normalized) do update set canonical_name = excluded.canonical_name;
        end if;

        if v_src.key is not null and v_src.key <> v_tgt.key then
          v_deprecated_keys := array_append(v_deprecated_keys, v_src.key);

          -- Transfer MBID on merge_duplicate only if target lacks one.
          if v_status = 'merge_duplicate' and v_src.mbid is not null and v_tgt.mbid is null then
            update public.canonical_artists set mbid = null where key = v_src.key;
            update public.canonical_artists set mbid = v_src.mbid where key = v_tgt.key;
          end if;

          -- Migrate performances and deduplicate collisions on (edition_id, target.key).
          for v_perf in select * from public.performances where artist_key = v_src.key loop
            select * into v_existing_perf
            from public.performances
            where edition_id = v_perf.edition_id and artist_key = v_tgt.key
              and coalesce(slot_id, '') = coalesce(v_perf.slot_id, '')
            limit 1;

            if v_existing_perf.id is not null then
              update public.performances set
                days = array(select distinct d from unnest(coalesce(v_existing_perf.days, '{}') || coalesce(v_perf.days, '{}')) d order by d),
                stages = array(select distinct s from unnest(coalesce(v_existing_perf.stages, '{}') || coalesce(v_perf.stages, '{}')) s),
                billing = coalesce(v_existing_perf.billing, v_perf.billing),
                sources = coalesce(v_existing_perf.sources, '[]'::jsonb) || coalesce(v_perf.sources, '[]'::jsonb),
                "set" = case
                  when v_status = 'remap_set' then coalesce(nullif(v_existing_perf."set", ''), v_set_qual, v_perf."set")
                  else coalesce(nullif(v_existing_perf."set", ''), v_perf."set")
                end
              where id = v_existing_perf.id;
              delete from public.performances where id = v_perf.id;
              v_perfs_deduped := v_perfs_deduped + 1;
            else
              update public.performances set
                artist_key = v_tgt.key,
                name = v_tgt.name,
                "set" = case
                  when v_status = 'remap_set' then coalesce(v_set_qual, v_perf."set")
                  else v_perf."set"
                end
              where id = v_perf.id;
              v_perfs_migrated := v_perfs_migrated + 1;
            end if;
          end loop;

          -- Legacy seen_sets cleanup.
          update public.seen_sets set artist_key = v_tgt.key
          where artist_key = v_src.key
            and not exists (select 1 from public.seen_sets s2 where s2.attendance_id = public.seen_sets.attendance_id and s2.artist_key = v_tgt.key);
          delete from public.seen_sets where artist_key = v_src.key;

          -- Genre handling: merge_duplicate copies only where target lacks that source; remap_set never copies.
          for v_genre in select * from public.artist_genres where artist_key = v_src.key loop
            if v_status = 'merge_duplicate'
               and not exists (select 1 from public.artist_genres g2 where g2.artist_key = v_tgt.key and g2.source = v_genre.source) then
              insert into public.artist_genres (artist_key, source, name, mbid, genres, source_url, inputs, checked_at)
              values (v_tgt.key, v_genre.source, v_tgt.name, coalesce(v_tgt.mbid, v_genre.mbid), v_genre.genres, v_genre.source_url, v_genre.inputs, v_genre.checked_at);
              select to_jsonb(g) into v_after from public.artist_genres g where g.artist_key = v_tgt.key and g.source = v_genre.source;
              insert into public.artist_genre_changes (artist_key, source, actor, reason, before, after)
              values (v_tgt.key, v_genre.source, p_actor, p_reason || ' (merge_duplicate copy)', null, v_after);
            end if;
            v_before := to_jsonb(v_genre);
            delete from public.artist_genres where artist_key = v_genre.artist_key and source = v_genre.source;
            insert into public.artist_genre_changes (artist_key, source, actor, reason, before, after)
            values (v_genre.artist_key, v_genre.source, p_actor, p_reason || ' (' || v_status || ')', v_before, null);
          end loop;

          update public.artist_aliases set canonical_name = v_tgt.name where canonical_name = v_src.name;
          update public.canonical_artists set alter_ego_of = v_tgt.key where alter_ego_of = v_src.key;
          delete from public.canonical_artists where key = v_src.key;
        end if;

        -- Owner personal log follow-through.
        for v_evt in
          select id, seen from public.logged_events
          where deleted_at is null
            and jsonb_typeof(seen) = 'array'
            and (p_owner_user_id is null or user_id = p_owner_user_id)
        loop
          v_new_seen := '[]'::jsonb;
          v_seen_changed := false;
          for v_seen_elem in select * from jsonb_array_elements(v_evt.seen) loop
            if (v_src.key is not null and v_seen_elem->>'key' = v_src.key)
               or (v_artist_key <> '' and v_seen_elem->>'key' = v_artist_key)
               or v_seen_elem->>'name' = v_artist then
              v_seen_changed := true;
              v_seen_elem := jsonb_set(v_seen_elem, '{key}', to_jsonb(v_tgt.key));
              v_seen_elem := jsonb_set(v_seen_elem, '{name}', to_jsonb(v_tgt.name));
              if v_status = 'remap_set' and v_set_qual is not null then
                v_seen_elem := jsonb_set(v_seen_elem, '{set}', to_jsonb(coalesce(nullif(v_seen_elem->>'set', ''), v_set_qual)));
              end if;
            end if;
            v_new_seen := v_new_seen || jsonb_build_array(v_seen_elem);
          end loop;
          if v_seen_changed then
            update public.logged_events set seen = v_new_seen where id = v_evt.id;
            v_owner_events_updated := v_owner_events_updated + 1;
          end if;
        end loop;

      -- =====================================================================
      -- 4) split_multi_artist
      -- =====================================================================
      elsif v_status = 'split_multi_artist' then
        v_split_resolved_keys := '{}'::text[];
        v_split_resolved_names := '{}'::text[];

        for v_split_item in select * from jsonb_array_elements(coalesce(v_row->'splitItems', '[]'::jsonb)) loop
          v_split_name := coalesce(v_split_item->>'name', '');
          v_split_key_raw := coalesce(v_split_item->>'key', '');
          v_split_norm_key := coalesce(v_split_item->>'normalizedKey', '');
          v_tgt := null;

          if v_split_key_raw like 'mbid:%' then
            select * into v_tgt from public.canonical_artists where mbid = substr(v_split_key_raw, 6) limit 1;
          elsif v_split_key_raw like 'artist:%' then
            select a.* into v_tgt
            from _orig_artists o
            join public.canonical_artists a on a.key = o.key
            where o.name = substr(v_split_key_raw, 8)
            limit 1;
            if v_tgt.key is null and v_split_norm_key <> '' then
              select * into v_tgt from public.canonical_artists where key = v_split_norm_key limit 1;
            end if;
          elsif v_split_key_raw = 'NEW' then
            select * into v_tgt from public.canonical_artists where key = v_split_norm_key limit 1;
            if v_tgt.key is null and v_split_norm_key <> '' then
              insert into public.canonical_artists (key, name)
              values (v_split_norm_key, v_split_name)
              returning * into v_tgt;
              v_new_artists := v_new_artists + 1;
            end if;
          end if;

          if v_tgt.key is null then
            v_failed := v_failed || jsonb_build_array(jsonb_build_object(
              'line', v_line, 'artist', v_artist, 'status', v_status,
              'targetKey', v_split_key_raw, 'reason', 'Split constituent not found: ' || v_split_name
            ));
          else
            v_split_resolved_keys := array_append(v_split_resolved_keys, v_tgt.key);
            v_split_resolved_names := array_append(v_split_resolved_names, v_tgt.name);
          end if;
        end loop;

        if array_length(v_split_resolved_keys, 1) is null or array_length(v_split_resolved_keys, 1) < 2 then
          continue;
        end if;

        if v_src.key is not null then
          v_deprecated_keys := array_append(v_deprecated_keys, v_src.key);

          for v_perf in select * from public.performances where artist_key = v_src.key loop
            v_slot_id := coalesce(nullif(v_perf.slot_id, ''), gen_random_uuid()::text);
            for v_idx in 1..array_length(v_split_resolved_keys, 1) loop
              v_b2b_keys := array(
                select x from unnest(v_split_resolved_keys) with ordinality as t(x, i)
                where i <> v_idx
              );
              select * into v_existing_perf
              from public.performances
              where edition_id = v_perf.edition_id
                and artist_key = v_split_resolved_keys[v_idx]
                and coalesce(slot_id, '') = v_slot_id
              limit 1;

              if v_existing_perf.id is not null then
                update public.performances set
                  alias = coalesce(nullif(v_existing_perf.alias, ''), v_combo_alias),
                  "set" = coalesce(nullif(v_existing_perf."set", ''), v_set_qual, v_perf."set")
                where id = v_existing_perf.id;
                v_perfs_deduped := v_perfs_deduped + 1;
              else
                insert into public.performances (
                  id, edition_id, artist_key, name, days, stages, status, billing, confidence, sources, slot_id, alias, b2b, "set", verification
                ) values (
                  gen_random_uuid(), v_perf.edition_id, v_split_resolved_keys[v_idx], v_split_resolved_names[v_idx],
                  v_perf.days, v_perf.stages, v_perf.status, v_perf.billing, v_perf.confidence, v_perf.sources,
                  v_slot_id, v_combo_alias, v_b2b_keys, coalesce(v_set_qual, v_perf."set"), v_perf.verification
                );
                v_perfs_migrated := v_perfs_migrated + 1;
              end if;
            end loop;
            delete from public.performances where id = v_perf.id;
          end loop;

          delete from public.seen_sets where artist_key = v_src.key;
          for v_genre in select * from public.artist_genres where artist_key = v_src.key loop
            v_before := to_jsonb(v_genre);
            delete from public.artist_genres where artist_key = v_genre.artist_key and source = v_genre.source;
            insert into public.artist_genre_changes (artist_key, source, actor, reason, before, after)
            values (v_genre.artist_key, v_genre.source, p_actor, p_reason || ' (split_multi_artist)', v_before, null);
          end loop;
          update public.canonical_artists set alter_ego_of = null where alter_ego_of = v_src.key;
          delete from public.canonical_artists where key = v_src.key;
        end if;

        -- Owner personal log follow-through (expand split seen entry into N paired B2B entries).
        for v_evt in
          select id, seen from public.logged_events
          where deleted_at is null
            and jsonb_typeof(seen) = 'array'
            and (p_owner_user_id is null or user_id = p_owner_user_id)
        loop
          v_new_seen := '[]'::jsonb;
          v_seen_changed := false;
          for v_seen_elem in select * from jsonb_array_elements(v_evt.seen) loop
            if (v_src.key is not null and v_seen_elem->>'key' = v_src.key)
               or (v_artist_key <> '' and v_seen_elem->>'key' = v_artist_key)
               or v_seen_elem->>'name' = v_artist then
              v_seen_changed := true;
              v_seen_slot := coalesce(nullif(v_seen_elem->>'slotId', ''), gen_random_uuid()::text);
              for v_idx in 1..array_length(v_split_resolved_keys, 1) loop
                v_b2b_keys := array(
                  select x from unnest(v_split_resolved_keys) with ordinality as t(x, i)
                  where i <> v_idx
                );
                v_new_seen := v_new_seen || jsonb_build_array(
                  jsonb_strip_nulls(
                    v_seen_elem
                    || jsonb_build_object(
                      'key', v_split_resolved_keys[v_idx],
                      'name', v_split_resolved_names[v_idx],
                      'slotId', v_seen_slot,
                      'b2b', to_jsonb(v_b2b_keys),
                      'alias', coalesce(v_combo_alias, v_seen_elem->>'alias'),
                      'set', coalesce(v_set_qual, v_seen_elem->>'set')
                    )
                  )
                );
              end loop;
            else
              v_new_seen := v_new_seen || jsonb_build_array(v_seen_elem);
            end if;
          end loop;
          if v_seen_changed then
            update public.logged_events set seen = v_new_seen where id = v_evt.id;
            v_owner_events_updated := v_owner_events_updated + 1;
          end if;
        end loop;

      -- =====================================================================
      -- 5) rename
      -- =====================================================================
      elsif v_status = 'rename' then
        if v_src.key is null then
          v_failed := v_failed || jsonb_build_array(jsonb_build_object(
            'line', v_line, 'artist', v_artist, 'status', v_status,
            'targetKey', v_canonical_artist, 'reason', 'Source artist not found'
          ));
          continue;
        end if;

        if v_canonical_new_key = v_src.key or v_canonical_new_key = '' then
          update public.canonical_artists set name = v_canonical_artist where key = v_src.key;
          if v_set_qual is not null then
            update public.performances
            set "set" = coalesce(nullif("set", ''), v_set_qual)
            where artist_key = v_src.key;
          end if;
        else
          -- Key changed (e.g. Manilla Killa -> Manila Killa, Kepler -> Kep1er).
          select * into v_tgt from public.canonical_artists where key = v_canonical_new_key limit 1;
          if v_tgt.key is null then
            -- Free MBID on source before inserting renamed row.
            if v_src.mbid is not null then
              update public.canonical_artists set mbid = null where key = v_src.key;
            end if;
            insert into public.canonical_artists (key, name, mbid, resolved_at, alter_ego_of)
            values (v_canonical_new_key, v_canonical_artist, v_src.mbid, v_src.resolved_at, v_src.alter_ego_of)
            returning * into v_tgt;
          else
            if v_src.mbid is not null and v_tgt.mbid is null then
              update public.canonical_artists set mbid = null where key = v_src.key;
              update public.canonical_artists set mbid = v_src.mbid where key = v_tgt.key;
            end if;
          end if;

          for v_perf in select * from public.performances where artist_key = v_src.key loop
            select * into v_existing_perf
            from public.performances
            where edition_id = v_perf.edition_id and artist_key = v_tgt.key
              and coalesce(slot_id, '') = coalesce(v_perf.slot_id, '')
            limit 1;
            if v_existing_perf.id is not null then
              update public.performances set
                days = array(select distinct d from unnest(coalesce(v_existing_perf.days, '{}') || coalesce(v_perf.days, '{}')) d order by d),
                stages = array(select distinct s from unnest(coalesce(v_existing_perf.stages, '{}') || coalesce(v_perf.stages, '{}')) s),
                sources = coalesce(v_existing_perf.sources, '[]'::jsonb) || coalesce(v_perf.sources, '[]'::jsonb),
                "set" = coalesce(nullif(v_existing_perf."set", ''), v_set_qual, v_perf."set")
              where id = v_existing_perf.id;
              delete from public.performances where id = v_perf.id;
              v_perfs_deduped := v_perfs_deduped + 1;
            else
              update public.performances set
                artist_key = v_tgt.key,
                name = v_canonical_artist,
                "set" = coalesce(v_set_qual, v_perf."set")
              where id = v_perf.id;
              v_perfs_migrated := v_perfs_migrated + 1;
            end if;
          end loop;

          update public.seen_sets set artist_key = v_tgt.key
          where artist_key = v_src.key
            and not exists (select 1 from public.seen_sets s2 where s2.attendance_id = public.seen_sets.attendance_id and s2.artist_key = v_tgt.key);
          delete from public.seen_sets where artist_key = v_src.key;

          for v_genre in select * from public.artist_genres where artist_key = v_src.key loop
            if not exists (select 1 from public.artist_genres g2 where g2.artist_key = v_tgt.key and g2.source = v_genre.source) then
              insert into public.artist_genres (artist_key, source, name, mbid, genres, source_url, inputs, checked_at)
              values (v_tgt.key, v_genre.source, v_canonical_artist, coalesce(v_tgt.mbid, v_genre.mbid), v_genre.genres, v_genre.source_url, v_genre.inputs, v_genre.checked_at);
              select to_jsonb(g) into v_after from public.artist_genres g where g.artist_key = v_tgt.key and g.source = v_genre.source;
              insert into public.artist_genre_changes (artist_key, source, actor, reason, before, after)
              values (v_tgt.key, v_genre.source, p_actor, p_reason || ' (rename move)', null, v_after);
            end if;
            v_before := to_jsonb(v_genre);
            delete from public.artist_genres where artist_key = v_genre.artist_key and source = v_genre.source;
            insert into public.artist_genre_changes (artist_key, source, actor, reason, before, after)
            values (v_genre.artist_key, v_genre.source, p_actor, p_reason || ' (rename)', v_before, null);
          end loop;

          update public.canonical_artists set alter_ego_of = v_tgt.key where alter_ego_of = v_src.key;
          delete from public.canonical_artists where key = v_src.key;
          v_src := v_tgt;
        end if;

        -- Store old Artist string as redirect alias.
        if v_artist_key <> '' and v_artist_key <> v_src.key then
          insert into public.artist_aliases (alias_normalized, canonical_name)
          values (v_artist_key, v_canonical_artist)
          on conflict (alias_normalized) do update set canonical_name = excluded.canonical_name;
        end if;
        update public.artist_aliases set canonical_name = v_canonical_artist where canonical_name = v_artist;

        -- Owner personal log follow-through.
        for v_evt in
          select id, seen from public.logged_events
          where deleted_at is null
            and jsonb_typeof(seen) = 'array'
            and (p_owner_user_id is null or user_id = p_owner_user_id)
        loop
          v_new_seen := '[]'::jsonb;
          v_seen_changed := false;
          for v_seen_elem in select * from jsonb_array_elements(v_evt.seen) loop
            if (v_artist_key <> '' and v_seen_elem->>'key' = v_artist_key)
               or v_seen_elem->>'name' = v_artist then
              v_seen_changed := true;
              v_seen_elem := jsonb_set(v_seen_elem, '{key}', to_jsonb(v_src.key));
              v_seen_elem := jsonb_set(v_seen_elem, '{name}', to_jsonb(v_canonical_artist));
              if v_set_qual is not null then
                v_seen_elem := jsonb_set(v_seen_elem, '{set}', to_jsonb(coalesce(nullif(v_seen_elem->>'set', ''), v_set_qual)));
              end if;
            end if;
            v_new_seen := v_new_seen || jsonb_build_array(v_seen_elem);
          end loop;
          if v_seen_changed then
            update public.logged_events set seen = v_new_seen where id = v_evt.id;
            v_owner_events_updated := v_owner_events_updated + 1;
          end if;
        end loop;

        -- Also link alter ego if Alter_Ego_Of is populated on this rename row.
        if v_alter_ego_of is not null then
          v_parent := null;
          if v_alter_ego_key like 'mbid:%' then
            select * into v_parent from public.canonical_artists where mbid = substr(v_alter_ego_key, 6) limit 1;
          elsif v_alter_ego_key like 'artist:%' then
            select a.* into v_parent
            from _orig_artists o
            join public.canonical_artists a on a.key = o.key
            where o.name = substr(v_alter_ego_key, 8)
            limit 1;
            if v_parent.key is null and v_alter_ego_target_key <> '' then
              select * into v_parent from public.canonical_artists where key = v_alter_ego_target_key limit 1;
            end if;
          elsif v_alter_ego_key = 'NEW' then
            select * into v_parent from public.canonical_artists where key = v_alter_ego_target_key limit 1;
            if v_parent.key is null and v_alter_ego_target_key <> '' then
              insert into public.canonical_artists (key, name)
              values (v_alter_ego_target_key, v_alter_ego_of)
              returning * into v_parent;
              v_parent_stubs := v_parent_stubs + 1;
            end if;
          end if;
          if v_parent.key is null then
            v_failed := v_failed || jsonb_build_array(jsonb_build_object(
              'line', v_line, 'artist', v_artist, 'status', v_status,
              'targetKey', v_alter_ego_key, 'reason', 'Alter-ego parent not found: ' || v_alter_ego_of
            ));
          else
            update public.canonical_artists set alter_ego_of = v_parent.key where key = v_src.key;
          end if;
        end if;

      -- =====================================================================
      -- 6) link_alter_ego
      -- =====================================================================
      elsif v_status = 'link_alter_ego' then
        if v_src.key is null then
          v_failed := v_failed || jsonb_build_array(jsonb_build_object(
            'line', v_line, 'artist', v_artist, 'status', v_status,
            'targetKey', v_artist, 'reason', 'Alter-ego artist not found'
          ));
          continue;
        end if;

        v_parent := null;
        if v_alter_ego_key like 'mbid:%' then
          select * into v_parent from public.canonical_artists where mbid = substr(v_alter_ego_key, 6) limit 1;
        elsif v_alter_ego_key like 'artist:%' then
          select a.* into v_parent
          from _orig_artists o
          join public.canonical_artists a on a.key = o.key
          where o.name = substr(v_alter_ego_key, 8)
          limit 1;
          if v_parent.key is null and v_alter_ego_target_key <> '' then
            select * into v_parent from public.canonical_artists where key = v_alter_ego_target_key limit 1;
          end if;
        elsif v_alter_ego_key = 'NEW' then
          select * into v_parent from public.canonical_artists where key = v_alter_ego_target_key limit 1;
          if v_parent.key is null and v_alter_ego_target_key <> '' then
            insert into public.canonical_artists (key, name)
            values (v_alter_ego_target_key, v_alter_ego_of)
            returning * into v_parent;
            v_parent_stubs := v_parent_stubs + 1;
          end if;
        end if;

        if v_parent.key is null then
          v_failed := v_failed || jsonb_build_array(jsonb_build_object(
            'line', v_line, 'artist', v_artist, 'status', v_status,
            'targetKey', v_alter_ego_key, 'reason', 'Alter-ego parent not found: ' || v_alter_ego_of
          ));
        else
          update public.canonical_artists set alter_ego_of = v_parent.key where key = v_src.key;
        end if;
      end if;
    end loop;

    -- Owner personal entity records follow-through (merge/rename in user_entities or entities).
    if p_owner_user_id is not null then
      -- Multi-user mode: update owner's user_entities rows for renamed/merged/invalid artists where applicable.
      for v_row in select value from jsonb_array_elements(p_rows) value loop
        v_status := coalesce(v_row->>'status', '');
        v_artist_key := coalesce(v_row->>'artistKey', '');
        v_canonical_artist := coalesce(v_row->>'canonicalArtist', '');
        v_canonical_new_key := coalesce(v_row->>'canonicalNewKey', '');
        if v_status = 'rename' and v_artist_key <> '' and v_canonical_artist <> '' then
          select id into v_ent_id from public.user_entities
          where user_id = p_owner_user_id and kind = 'artist' and merged_into_id is null and name_normalized = v_artist_key
          limit 1;
          if v_ent_id is not null then
            select id into v_tgt_ent_id from public.user_entities
            where user_id = p_owner_user_id and kind = 'artist' and merged_into_id is null and name_normalized = v_canonical_new_key
            limit 1;
            if v_tgt_ent_id is null then
              update public.user_entities
              set name = v_canonical_artist, name_normalized = v_canonical_new_key, updated_at = now()
              where id = v_ent_id;
            elsif v_tgt_ent_id <> v_ent_id then
              update public.user_entities set merged_into_id = v_tgt_ent_id, updated_at = now() where id = v_ent_id;
            end if;
          end if;
        end if;
      end loop;
    end if;

    -- Post-commit assertions.
    if coalesce(array_length(v_deprecated_keys, 1), 0) > 0 then
      select count(*) into v_remaining_deprecated
      from public.canonical_artists where key = any(v_deprecated_keys);
    end if;

    select count(*) into v_orphaned_perfs
    from public.performances p
    left join public.canonical_artists a on a.key = p.artist_key
    where a.key is null;

    if coalesce(array_length(v_invalid_norms, 1), 0) > 0 then
      select count(*) into v_missing_blocklist
      from (select distinct x from unnest(v_invalid_norms) x) req
      left join public.extraction_blocklist b on b.domain = '*' and b.normalized = req.x
      where b.normalized is null;
    end if;

    v_report := jsonb_build_object(
      'dryRun', p_dry_run,
      'counts', v_counts,
      'totalRows', v_total_rows,
      'performancesMigrated', v_perfs_migrated,
      'performancesDeduped', v_perfs_deduped,
      'newArtistsInserted', v_new_artists,
      'parentStubsInserted', v_parent_stubs,
      'ownerEventsUpdated', v_owner_events_updated,
      'failedResolutions', v_failed,
      'assertions', jsonb_build_object(
        'remainingDeprecatedActive', v_remaining_deprecated,
        'orphanedPerformances', v_orphaned_perfs,
        'missingBlocklistEntries', v_missing_blocklist
      )
    );

    if p_dry_run then
      raise exception using errcode = 'P0099';
    end if;

    return v_report;
  exception
    when sqlstate 'P0099' then
      return v_report;
  end;
end;
$$;

revoke all on function public.canonical_artist_cleanup(jsonb, boolean, text, text, uuid) from public, anon, authenticated;
grant execute on function public.canonical_artist_cleanup(jsonb, boolean, text, text, uuid) to service_role;

-- Check:
--   select column_name from information_schema.columns where table_name = 'canonical_artists' and column_name = 'alter_ego_of';
--   select column_name from information_schema.columns where table_name = 'extraction_blocklist' and column_name = 'reason';
-- Rollback:
--   drop function if exists public.canonical_artist_cleanup(jsonb, boolean, text, text, uuid);
--   alter table public.extraction_blocklist drop column if exists reason;
--   alter table public.canonical_artists drop column if exists alter_ego_of;
