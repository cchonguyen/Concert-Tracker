-- Slice 11.8 (docs/ingest-canon-plan.md, section 3). Written only; Charlie applies it after 0041.
--
-- merge_editions(keep_id, drop_id, p_actor, p_reason): one atomic Postgres function that folds one shared
-- edition into another. It moves everything that points at the dropped edition onto the kept one, records
-- the merge in edition_changes, and deletes the dropped edition. Any failure rolls the whole call back.
--
-- What moves (checked against 0002, 0003, 0029, 0041):
--   logged_events.edition_id          the members' linked events (personal fields are not read or copied)
--   attendance.edition_id             legacy 0002 table; its foreign key has no cascade and would block the delete
--   performances.edition_id           the lineup; a row the kept edition already has (same artist_key and
--                                     slot_id) is dropped instead of duplicated (counted in the change record)
--   edition_external_ids.edition_id   so the next lookup by a source's ID finds the kept edition
--   lookup_jobs.edition_id            jobs that pointed at the dropped edition (no foreign key)
--   review_queue.edition_id           open and closed rows
-- performer_claims has no edition column (it links through job_id and document_id) and is left as is.
-- edition_changes of the dropped edition keep its old id (append-only, no foreign key) and stay readable.
-- Nothing is filled into the kept edition's own facts: that is a separate, recorded edit (writeEdition).
--
-- Refuses when either id is missing, empty, or both are the same. Security definer with a fixed search_path;
-- execute is revoked from everyone and granted to service_role only (same pattern as 0025 and 0040).

create or replace function public.merge_editions(
  keep_id text,
  drop_id text,
  p_actor text default 'system',
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keep public.event_editions%rowtype;
  v_drop public.event_editions%rowtype;
  n_events int;
  n_attendance int;
  n_perf_moved int;
  n_perf_dup int;
  n_ext int;
  n_jobs int;
  n_review int;
  v_summary jsonb;
begin
  if keep_id is null or drop_id is null or keep_id = '' or drop_id = '' then
    raise exception 'merge_editions: both ids are required';
  end if;
  if keep_id = drop_id then
    raise exception 'merge_editions: keep_id and drop_id are the same edition';
  end if;

  -- Lock both rows in a fixed order (no deadlock between two opposite merges).
  perform 1 from public.event_editions where id in (keep_id, drop_id) order by id for update;
  select * into v_keep from public.event_editions where id = keep_id;
  if not found then
    raise exception 'merge_editions: edition % not found', keep_id;
  end if;
  select * into v_drop from public.event_editions where id = drop_id;
  if not found then
    raise exception 'merge_editions: edition % not found', drop_id;
  end if;

  update public.logged_events set edition_id = keep_id where edition_id = drop_id;
  get diagnostics n_events = row_count;

  update public.attendance set edition_id = keep_id where edition_id = drop_id;
  get diagnostics n_attendance = row_count;

  -- Performances: drop the ones the kept edition already has, move the rest.
  delete from public.performances d
  where d.edition_id = drop_id
    and exists (
      select 1 from public.performances k
      where k.edition_id = keep_id and k.artist_key = d.artist_key
        and coalesce(k.slot_id, '') = coalesce(d.slot_id, '')
    );
  get diagnostics n_perf_dup = row_count;
  update public.performances set edition_id = keep_id where edition_id = drop_id;
  get diagnostics n_perf_moved = row_count;

  -- External IDs are unique per (source, external_id), so each is held by one edition only: just repoint.
  update public.edition_external_ids set edition_id = keep_id where edition_id = drop_id;
  get diagnostics n_ext = row_count;

  update public.lookup_jobs set edition_id = keep_id where edition_id = drop_id;
  get diagnostics n_jobs = row_count;

  update public.review_queue set edition_id = keep_id where edition_id = drop_id;
  get diagnostics n_review = row_count;

  v_summary := jsonb_build_object(
    'keep_id', keep_id, 'drop_id', drop_id,
    'events_moved', n_events, 'attendance_moved', n_attendance,
    'performances_moved', n_perf_moved, 'performances_duplicate_dropped', n_perf_dup,
    'external_ids_moved', n_ext, 'lookup_jobs_moved', n_jobs, 'review_rows_moved', n_review);

  -- The record: before holds the dropped edition's row as it was; after says where everything went.
  insert into public.edition_changes (edition_id, actor, reason, before, after)
  values (keep_id, coalesce(nullif(p_actor, ''), 'system'), p_reason,
          jsonb_build_object('merged_edition', to_jsonb(v_drop)),
          jsonb_build_object('merged_into', keep_id) || v_summary);

  delete from public.event_editions where id = drop_id;

  return v_summary;
end;
$$;

revoke all on function public.merge_editions(text, text, text, text) from public, anon, authenticated;
grant execute on function public.merge_editions(text, text, text, text) to service_role;

-- Check (run after applying; expect one row, prosecdef true, proacl naming service_role only):
--   select p.proname, p.prosecdef, p.proconfig, p.proacl
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'merge_editions';

-- Rollback (nothing calls it until slice 11.9 onward):
--   drop function if exists public.merge_editions(text, text, text, text);
