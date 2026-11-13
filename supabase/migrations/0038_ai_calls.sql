-- AI call log (docs/ai-reader-spec.md, "AI call log"). Written only; Charlie applies it.
-- Counts and sizes only: never page text, prompts, quotes or names.
-- RLS follows 0026: the owner reads, no signed-in member writes, the service role writes.

create table if not exists ai_calls (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  feature text not null check (feature in ('lineup_extract','details_extract','discovery')),
  job_id uuid null,                 -- lookup_jobs.id; no foreign key, so a deleted job keeps its log
  event_id uuid null,               -- logged_events.id; no foreign key
  user_id uuid null,
  provider text not null,
  model text not null,
  source_document_id uuid null,
  input_chars int null,
  input_tokens int null,
  output_tokens int null,
  est_cost_usd numeric(10,6) null,
  duration_ms int null,
  outcome text not null check (outcome in ('ok','invalid_json','quota','busy','blocked_by_guard','error')),
  error_code text null,
  guard_reason text null,
  names_returned int null,
  names_verbatim int null,
  names_rejected int null
);
create index if not exists ai_calls_created_idx on ai_calls (created_at desc);
alter table ai_calls enable row level security;
drop policy if exists "owner_read" on ai_calls;
create policy "owner_read" on ai_calls for select to authenticated using (auth.uid() = owner_user_id());

-- Check (run after applying; expect relrowsecurity true and the policy owner_read):
--   select c.relname, c.relrowsecurity,
--          (select string_agg(policyname, ', ') from pg_policies p where p.tablename = c.relname) as policies
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public' and c.relname = 'ai_calls';
--   select count(*) from ai_calls;   -- expect 0 before the first call

-- Rollback:
--   drop table ai_calls;
