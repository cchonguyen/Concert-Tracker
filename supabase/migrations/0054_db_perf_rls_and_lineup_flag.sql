-- Database performance, RLS initplan/keyless hardening, RPC grant verification,
-- and idempotent data repairs (Slice 21.4, docs/specs/2026-11-18-db-logs-improvement-spec.md).
-- Written only; Charlie reviews and applies in the Supabase SQL Editor.
--
-- Additive and idempotent: create index if not exists, drop-then-create policies,
-- guarded primary key DO blocks, and idempotent updates. Safe to run twice.

-- ============================================================================
-- 1. RPC grant verification (SECURITY DEFINER execute surface)
-- ============================================================================
-- Note: Do NOT revoke EXECUTE from `authenticated` on `owner_user_id()` or on the
-- three `canonical_*` RPCs (`canonical_artist_fingerprint`, `canonical_apply_artist_change`,
-- `canonical_undo_artist_change`):
--   * `owner_user_id()` is evaluated by `owner_read` RLS policies under `authenticated`.
--   * `SupabaseLineupStore.canonicalClient()` invokes the `canonical_*` RPCs with the
--     owner's `authenticated` JWT, and each RPC enforces `canonical_assert_owner(p_user_id)`
--     (SQLSTATE 42501) inside Postgres.
-- Re-affirm `PUBLIC` and `anon` stay revoked on all four functions.
revoke all on function public.owner_user_id() from public, anon;
grant execute on function public.owner_user_id() to authenticated, service_role;

revoke all on function public.canonical_artist_fingerprint(jsonb, uuid) from public, anon;
revoke all on function public.canonical_apply_artist_change(text, jsonb, uuid) from public, anon;
revoke all on function public.canonical_undo_artist_change(uuid, uuid) from public, anon;
grant execute on function public.canonical_artist_fingerprint(jsonb, uuid) to authenticated, service_role;
grant execute on function public.canonical_apply_artist_change(text, jsonb, uuid) to authenticated, service_role;
grant execute on function public.canonical_undo_artist_change(uuid, uuid) to authenticated, service_role;

-- ============================================================================
-- 2. Drop open legacy 0001 public policies (keep tables until operator drop)
-- ============================================================================
do $$
declare
  rec record;
begin
  for rec in
    select * from (values
      ('artists', 'Allow all access to artists'),
      ('venues', 'Allow all access to venues'),
      ('events', 'Allow all access to events'),
      ('event_appearances', 'Allow all access to event_appearances')
    ) as t(tbl, pol)
  loop
    if to_regclass('public.' || rec.tbl) is not null then
      execute format('drop policy if exists %I on public.%I', rec.pol, rec.tbl);
    end if;
  end loop;
end $$;

-- ============================================================================
-- 3. Rewrite all 19 RLS initplan policies with (select ...) scalar subqueries
-- ============================================================================
-- Wrapping auth.uid() and owner_user_id() in `(select ...)` lets Postgres evaluate
-- them once per query (InitPlan) rather than once per scanned row.

-- 3a. 11 per-user tables (`own_rows`)
drop policy if exists own_rows on public.activity_log;
create policy own_rows on public.activity_log for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists own_rows on public.email_imports;
create policy own_rows on public.email_imports for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists own_rows on public.logged_events;
create policy own_rows on public.logged_events for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists own_rows on public.lookup_jobs;
create policy own_rows on public.lookup_jobs for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists own_rows on public.share_links;
create policy own_rows on public.share_links for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists own_rows on public.user_artist_genres;
create policy own_rows on public.user_artist_genres for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists own_rows on public.user_entities;
create policy own_rows on public.user_entities for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists own_rows on public.user_entity_aliases;
create policy own_rows on public.user_entity_aliases for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists own_rows on public.user_entity_history;
create policy own_rows on public.user_entity_history for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists own_rows on public.user_entity_links;
create policy own_rows on public.user_entity_links for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists own_rows on public.user_settings;
create policy own_rows on public.user_settings for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- 3b. Legacy personal tables (`own_attendance`, `own_seen_sets`)
drop policy if exists "own_attendance" on public.attendance;
create policy "own_attendance" on public.attendance for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "own_seen_sets" on public.seen_sets;
create policy "own_seen_sets" on public.seen_sets for all to authenticated
  using (exists (select 1 from public.attendance a where a.id = seen_sets.attendance_id and a.user_id = (select auth.uid())))
  with check (exists (select 1 from public.attendance a where a.id = seen_sets.attendance_id and a.user_id = (select auth.uid())));

-- 3c. 6 owner-only operational/history tables (`owner_read`)
drop policy if exists "owner_read" on public.ai_calls;
create policy "owner_read" on public.ai_calls for select to authenticated
  using ((select auth.uid()) = (select public.owner_user_id()));

drop policy if exists "owner_read" on public.edition_changes;
create policy "owner_read" on public.edition_changes for select to authenticated
  using ((select auth.uid()) = (select public.owner_user_id()));

drop policy if exists "owner_read" on public.ingest_traces;
create policy "owner_read" on public.ingest_traces for select to authenticated
  using ((select auth.uid()) = (select public.owner_user_id()));

drop policy if exists "owner_read" on public.quota_ledger;
create policy "owner_read" on public.quota_ledger for select to authenticated
  using ((select auth.uid()) = (select public.owner_user_id()));

drop policy if exists "owner_read" on public.review_queue;
create policy "owner_read" on public.review_queue for select to authenticated
  using ((select auth.uid()) = (select public.owner_user_id()));

drop policy if exists "owner_read" on public.source_stats;
create policy "owner_read" on public.source_stats for select to authenticated
  using ((select auth.uid()) = (select public.owner_user_id()));

-- ============================================================================
-- 4. Covering indexes for unindexed foreign keys + pending research fast-path
-- ============================================================================
create index if not exists idx_attendance_edition_id on public.attendance (edition_id);
create index if not exists idx_event_editions_series_slug on public.event_editions (series_slug);
create index if not exists idx_event_editions_venue_id on public.event_editions (venue_id);
create index if not exists idx_logged_events_edition_id on public.logged_events (edition_id);
create index if not exists idx_performances_artist_key on public.performances (artist_key);
create index if not exists idx_performer_claims_document_id on public.performer_claims (document_id);
create index if not exists idx_review_queue_event_id on public.review_queue (event_id);
create index if not exists idx_seen_sets_artist_key on public.seen_sets (artist_key);
create index if not exists idx_user_entities_merged_into on public.user_entities (user_id, merged_into_id)
  where merged_into_id is not null;
create index if not exists idx_user_entity_links_to on public.user_entity_links (user_id, to_id);
create index if not exists idx_venue_aliases_venue_id on public.venue_aliases (venue_id);

-- Speeds up listPendingResearchUserIds() and idle cron scans (Slice 21.2).
create index if not exists idx_logged_events_pending_research
  on public.logged_events (user_id)
  where deleted_at is null and (details ->> 'status') = 'pending';

-- ============================================================================
-- 5. Primary keys on the 4 keyless join/alias tables
-- ============================================================================
do $$
begin
  if to_regclass('public.venue_aliases') is not null and not exists (
    select 1 from pg_constraint where conrelid = 'public.venue_aliases'::regclass and contype = 'p'
  ) then
    alter table public.venue_aliases add primary key (alias_normalized, venue_id);
  end if;

  if to_regclass('public.edition_external_ids') is not null and not exists (
    select 1 from pg_constraint where conrelid = 'public.edition_external_ids'::regclass and contype = 'p'
  ) then
    alter table public.edition_external_ids add primary key (source, external_id);
  end if;

  if to_regclass('public.entity_aliases') is not null and not exists (
    select 1 from pg_constraint where conrelid = 'public.entity_aliases'::regclass and contype = 'p'
  ) then
    alter table public.entity_aliases add primary key (kind, alias_normalized);
  end if;

  if to_regclass('public.user_entity_aliases') is not null and not exists (
    select 1 from pg_constraint where conrelid = 'public.user_entity_aliases'::regclass and contype = 'p'
  ) then
    alter table public.user_entity_aliases add primary key (user_id, kind, companion_token);
  end if;
end $$;

-- ============================================================================
-- 6. Safe, idempotent data repairs
-- ============================================================================

-- 6a. Sync event_editions.has_lineup for editions that already have performances.
update public.event_editions e
set has_lineup = true
where e.has_lineup is null
  and exists (select 1 from public.performances p where p.edition_id = e.id);

-- 6b. Normalize US country display variants to 'United States'.
update public.logged_events
set country = 'United States'
where lower(trim(country)) in ('usa', 'us', 'u.s.', 'u.s.a.', 'united states of america');

update public.event_editions
set country = 'United States'
where lower(trim(country)) in ('usa', 'us', 'u.s.', 'u.s.a.', 'united states of america');

-- 6c. Repair edition row where US state code 'WA' landed in country.
update public.event_editions
set
  region = coalesce(nullif(trim(region), ''), 'WA'),
  country = 'United States'
where trim(country) = 'WA';

-- 6d. Strip Eventbrite calendar-link footer strings from legacy email_imports.venue.
update public.email_imports
set
  data = case
    when (data ? 'sources') and jsonb_typeof(data -> 'sources') = 'object'
      then jsonb_set(data - 'venue', '{sources}', (data -> 'sources') - 'venue')
    else data - 'venue'
  end,
  updated_at = now()
where data ->> 'venue' ~* '(add\s+to\s+google|outlook.*ical.*yahoo|add\s+to\s+my\s+calendar)';

-- 6e. Promote refused_hosts from user_settings to shared app_settings if missing there.
insert into public.app_settings (key, data, updated_at)
select 'refused_hosts', us.data, us.updated_at
from public.user_settings us
where us.key = 'refused_hosts'
order by us.updated_at desc
limit 1
on conflict (key) do nothing;

-- ============================================================================
-- Check queries (run after applying)
-- ============================================================================
--   select tablename, policyname, qual, with_check
--     from pg_policies
--     where schemaname = 'public' and policyname in ('own_rows','own_attendance','own_seen_sets','owner_read')
--     order by tablename, policyname;
--   select indexname from pg_indexes
--     where schemaname = 'public' and indexname like 'idx\_%' escape '\' order by indexname;
--   select conrelid::regclass, conname from pg_constraint
--     where contype = 'p' and conrelid in (
--       'public.venue_aliases'::regclass, 'public.edition_external_ids'::regclass,
--       'public.entity_aliases'::regclass, 'public.user_entity_aliases'::regclass
--     );
--   select count(*) filter (where has_lineup is null and exists (select 1 from public.performances p where p.edition_id = id)) as missing_has_lineup
--     from public.event_editions;
--   select count(*) from public.email_imports where data ->> 'venue' ~* '(add\s+to\s+google|outlook.*ical.*yahoo|add\s+to\s+my\s+calendar)';

-- ============================================================================
-- OPTIONAL OPERATOR CLEANUP — NOT RUN BY THIS MIGRATION
-- ============================================================================
-- Inspect rows first, verify no active code reads them, then uncomment and run manually:
--
--   -- 1. Drop empty legacy 0001 tables (verified 0 rows in Nov 2026 audit):
--   -- select count(*) from public.artists;
--   -- select count(*) from public.venues;
--   -- select count(*) from public.events;
--   -- select count(*) from public.event_appearances;
--   -- drop table if exists public.event_appearances;
--   -- drop table if exists public.events;
--   -- drop table if exists public.venues;
--   -- drop table if exists public.artists;
--
--   -- 2. Remove obsolete pre-multi-user app_settings rows (personal equivalents live in user_settings):
--   -- select key, jsonb_pretty(data) from public.app_settings
--   --   where key in ('google_sheets', 'google_sheets_base', 'google_sheets_oauth', 'gmail', 'gmail_oauth', 'email_scan');
--   -- delete from public.app_settings
--   --   where key in ('google_sheets', 'google_sheets_base', 'google_sheets_oauth', 'gmail', 'gmail_oauth', 'email_scan');

-- ============================================================================
-- Rollback notes
-- ============================================================================
--   drop index if exists public.idx_attendance_edition_id;
--   drop index if exists public.idx_event_editions_series_slug;
--   drop index if exists public.idx_event_editions_venue_id;
--   drop index if exists public.idx_logged_events_edition_id;
--   drop index if exists public.idx_performances_artist_key;
--   drop index if exists public.idx_performer_claims_document_id;
--   drop index if exists public.idx_review_queue_event_id;
--   drop index if exists public.idx_seen_sets_artist_key;
--   drop index if exists public.idx_user_entities_merged_into;
--   drop index if exists public.idx_user_entity_links_to;
--   drop index if exists public.idx_venue_aliases_venue_id;
--   drop index if exists public.idx_logged_events_pending_research;
