-- Ingest traces (docs/ingest-canon-plan.md, "Review queue and traces"). Written only; Charlie applies it.
-- One row per queue message or save request. Counts, status words, source names and ids only:
-- never page text, quotes, prompts, or personal fields (companions, notes, rating, price, attendance).
-- RLS follows 0038: the owner reads, no signed-in member writes, the service role writes.

create table if not exists ingest_traces (
  id uuid primary key default gen_random_uuid(),
  trigger text not null check (trigger in ('save','research','research_reader','backfill','research_backfill','lookup')),
  event_id uuid null,               -- logged_events.id; no foreign key, so a deleted event keeps its trace
  edition_id text null,             -- no foreign key
  job_id uuid null,                 -- lookup_jobs.id; no foreign key
  steps jsonb not null default '[]'::jsonb,
  subrequests int null,
  ai_cost_micros int null,
  created_at timestamptz not null default now()
);
create index if not exists ingest_traces_created_idx on ingest_traces (created_at desc);
alter table ingest_traces enable row level security;
drop policy if exists "owner_read" on ingest_traces;
create policy "owner_read" on ingest_traces for select to authenticated using (auth.uid() = owner_user_id());

-- Check (run after applying; expect relrowsecurity true and the policy owner_read):
--   select c.relname, c.relrowsecurity,
--          (select string_agg(policyname, ', ') from pg_policies p where p.tablename = c.relname) as policies
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public' and c.relname = 'ingest_traces';
--   select count(*) from ingest_traces;   -- expect 0 before the first message

-- Rollback:
--   drop table ingest_traces;
