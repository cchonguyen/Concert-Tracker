-- Slice 11.8 (docs/ingest-canon-plan.md, section 3). Written only; Charlie applies it in the Supabase SQL editor.
--
-- Schema for shared occurrences (editions), their history, the review queue and inheritance for personal
-- events. Nothing in the app reads or writes any of this yet (slices 11.9 onward do). It is safe to apply
-- BEFORE the code that reads 'verified': the status check keeps accepting 'confirmed' and no existing row
-- is changed. Converting 'confirmed' rows to 'verified' is a separate step at the bottom, commented out,
-- for a later slice.
--
-- Additive and idempotent: create ... if not exists, add column if not exists, drop-then-create for
-- constraints, policies and triggers. One file, safe to run twice. Run as one script (the SQL editor runs
-- it in a single transaction).
--
-- Privacy (AGENTS.md, rule 6): no shared table, default or backfill below holds a personal field
-- (companions, notes, rating, price, attendance). logged_events.captured holds only name, dates, venue,
-- city, region and country, and it lives on the member's own row, which stays private under RLS (0017).

-- 1. event_editions.status: draft (owner only, unchanged), provisional, verified, and 'confirmed' kept.
--    'confirmed' means verified until the later conversion (see the end of this file). No row is changed here.
--    The check constraint from 0002 is unnamed, so Postgres named it event_editions_status_check.
alter table public.event_editions drop constraint if exists event_editions_status_check;
alter table public.event_editions add constraint event_editions_status_check
  check (status in ('draft', 'provisional', 'verified', 'confirmed'));

-- 2. canonical_venues: one shared row per real venue, so two spellings of a venue are one place.
create table if not exists public.canonical_venues (
  id text primary key,
  name text not null,
  city text,
  region text,
  country text,
  created_at timestamptz not null default now()
);

-- 3. venue_aliases: other spellings of a venue (normalized), and a source's own ID for it.
create table if not exists public.venue_aliases (
  venue_id text not null references public.canonical_venues(id) on delete cascade,
  alias_normalized text not null,
  source text,
  external_id text,
  created_at timestamptz not null default now(),
  unique (alias_normalized, venue_id)
);
create index if not exists venue_aliases_alias_idx on public.venue_aliases (alias_normalized);
-- A source's venue ID points at one venue only.
create unique index if not exists venue_aliases_external_uidx
  on public.venue_aliases (source, external_id) where external_id is not null;

-- 4. event_editions: the new nullable columns and the occurrence key.
--    subject_key is the shared artist key for a headline show, or the series slug for a festival.
alter table public.event_editions add column if not exists venue_id text references public.canonical_venues(id) on delete set null;
alter table public.event_editions add column if not exists subject_key text;
alter table public.event_editions add column if not exists has_lineup boolean;
-- Same date, same shared venue, same subject: the same occurrence. Applies only when all three are set.
create unique index if not exists event_editions_occurrence_uidx
  on public.event_editions (start_date, venue_id, subject_key)
  where start_date is not null and venue_id is not null and subject_key is not null;

-- 5. edition_external_ids: a source's own ID for an edition. One edition per (source, external_id).
create table if not exists public.edition_external_ids (
  edition_id text not null references public.event_editions(id) on delete cascade,
  source text not null,
  external_id text not null,
  created_at timestamptz not null default now(),
  unique (source, external_id)
);
create index if not exists edition_external_ids_edition_idx on public.edition_external_ids (edition_id);

-- 6. edition_changes: every change to a shared edition (old value, new value, who or what, why).
--    No foreign key on edition_id, so the history of a merged-away edition survives its deletion
--    (same choice as ai_calls). Append-only: the trigger below refuses delete, and refuses any update
--    except setting undone_at once.
create table if not exists public.edition_changes (
  id uuid primary key default gen_random_uuid(),
  edition_id text not null,
  at timestamptz not null default now(),
  actor text not null,            -- a member id, 'owner', or the name of a job or adapter
  reason text,
  before jsonb,
  after jsonb,
  undone_at timestamptz
);
create index if not exists edition_changes_edition_idx on public.edition_changes (edition_id, at desc);

create or replace function public.edition_changes_append_only() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'edition_changes is append-only: rows are never deleted';
  end if;
  -- The one defined path: set undone_at, once, and change nothing else.
  if (new.id, new.edition_id, new.at, new.actor, new.reason, new.before, new.after)
       is distinct from (old.id, old.edition_id, old.at, old.actor, old.reason, old.before, old.after)
     or old.undone_at is not null
     or new.undone_at is null then
    raise exception 'edition_changes is append-only: only undone_at may be set, once';
  end if;
  return new;
end;
$$;
drop trigger if exists edition_changes_append_only on public.edition_changes;
create trigger edition_changes_append_only before update or delete on public.edition_changes
  for each row execute function public.edition_changes_append_only();

-- 7. review_queue: one owner inbox for what needs a person's call. Payloads hold edition facts and
--    field names only, never personal fields.
create table if not exists public.review_queue (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('override', 'merge_suggestion', 'provisional', 'formatting', 'failed_lookup')),
  edition_id text references public.event_editions(id) on delete set null,
  event_id text references public.logged_events(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text
);
create index if not exists review_queue_open_idx on public.review_queue (kind, created_at) where status = 'open';
create index if not exists review_queue_edition_idx on public.review_queue (edition_id);

-- 8. logged_events.captured and overrides (inheritance).
--    captured: name, dates, venue, city, region, country as first typed or imported. Written once.
--    overrides: the fields the person changed while linked to an edition. Empty by default.
alter table public.logged_events add column if not exists captured jsonb;
alter table public.logged_events add column if not exists overrides jsonb not null default '{}'::jsonb;

-- Backfill captured from the CURRENT field values, only for rows where it is still null.
update public.logged_events
set captured = jsonb_build_object(
  'name', name, 'year', year, 'month', month, 'start_date', start_date, 'end_date', end_date,
  'venue', venue, 'city', city, 'region', region, 'country', country)
where captured is null;

-- captured is never overwritten once set: whatever an update says, the stored value stays.
create or replace function public.logged_events_captured_once() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.captured is not null then
    new.captured := old.captured;
  end if;
  return new;
end;
$$;
drop trigger if exists logged_events_captured_once on public.logged_events;
create trigger logged_events_captured_once before update on public.logged_events
  for each row execute function public.logged_events_captured_once();

-- 9. Row level security, following 0026 and 0039.
--    Shared catalog tables: signed-in members read, no write policy, so only the service key writes.
--    edition_changes and review_queue: owner reads only; the service key writes.
alter table public.canonical_venues enable row level security;
alter table public.venue_aliases enable row level security;
alter table public.edition_external_ids enable row level security;
alter table public.edition_changes enable row level security;
alter table public.review_queue enable row level security;

do $$
declare t text;
begin
  foreach t in array array['canonical_venues','venue_aliases','edition_external_ids'] loop
    execute format('drop policy if exists "members_read" on public.%I', t);
    execute format('create policy "members_read" on public.%I for select to authenticated using (true)', t);
  end loop;
  foreach t in array array['edition_changes','review_queue'] loop
    execute format('drop policy if exists "owner_read" on public.%I', t);
    execute format('create policy "owner_read" on public.%I for select to authenticated using (auth.uid() = owner_user_id())', t);
  end loop;
end $$;

-- Grants: no signed-in or anonymous write on any new table; only the service key writes.
revoke insert, update, delete, truncate on public.canonical_venues, public.venue_aliases,
  public.edition_external_ids, public.edition_changes, public.review_queue from anon, authenticated;
revoke all on public.edition_changes, public.review_queue from anon;
grant select, insert, update, delete on public.canonical_venues, public.venue_aliases,
  public.edition_external_ids, public.review_queue to service_role;
-- edition_changes: insert and read; update only the undone_at column (the trigger enforces once); no delete.
grant select, insert on public.edition_changes to service_role;
grant update (undone_at) on public.edition_changes to service_role;

-- Check (run after applying):
--   select status, count(*) from public.event_editions group by status;                -- unchanged counts
--   select conname, pg_get_constraintdef(oid) from pg_constraint where conname = 'event_editions_status_check';
--   select count(*) filter (where captured is null) as no_captured from public.logged_events;   -- expect 0
--   select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
--     where n.nspname = 'public' and c.relname in
--     ('canonical_venues','venue_aliases','edition_external_ids','edition_changes','review_queue');  -- all true
--   select tgname from pg_trigger where tgname in ('edition_changes_append_only','logged_events_captured_once');

-- LATER STEP, NOT RUN BY THIS MIGRATION (a later slice, once all code reads 'verified' as the status):
-- convert existing 'confirmed' rows and tighten the check. Uncomment and run only then.
--   update public.event_editions set status = 'verified' where status = 'confirmed';
--   alter table public.event_editions drop constraint if exists event_editions_status_check;
--   alter table public.event_editions add constraint event_editions_status_check
--     check (status in ('draft', 'provisional', 'verified'));
-- Check for that step: select status, count(*) from public.event_editions group by status;   -- no 'confirmed'

-- Rollback (the new tables are empty until later slices use them; dropping them loses nothing today).
-- Status: no row was changed, so only the constraint goes back (needs no 'provisional' or 'verified' rows;
-- if any exist, set them to 'draft' or 'confirmed' first):
--   alter table public.event_editions drop constraint if exists event_editions_status_check;
--   alter table public.event_editions add constraint event_editions_status_check check (status in ('draft', 'confirmed'));
--   drop trigger if exists logged_events_captured_once on public.logged_events;
--   drop function if exists public.logged_events_captured_once();
--   alter table public.logged_events drop column if exists captured;   -- and overrides
--   drop table if exists public.review_queue;
--   drop table if exists public.edition_changes;      -- the append-only trigger blocks row deletes, not DROP TABLE
--   drop function if exists public.edition_changes_append_only();
--   drop table if exists public.edition_external_ids;
--   drop index if exists public.event_editions_occurrence_uidx;
--   alter table public.event_editions drop column if exists venue_id;   -- subject_key, has_lineup
--   drop table if exists public.venue_aliases;
--   drop table if exists public.canonical_venues;
