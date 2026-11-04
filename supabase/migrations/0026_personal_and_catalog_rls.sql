-- Applied to the live database by Charlie (RLS, 2026-10-29). Committed here as the record.
-- Replaces the "members_all" draft (0024) on these 14 tables.
--
-- Model:
--   * attendance: each member sees and changes only their own rows (user_id = the token's sub).
--   * seen_sets: only through the member's own attendance rows.
--   * 10 catalog tables: signed-in members can read; only the server (service role) writes.
--   * quota_ledger and source_stats: owner only (operational counters).
-- Assumes: the member token's sub is the auth user id (src/server/auth/supabaseJwt.ts), so auth.uid() matches
-- user_id. The owner's row in members is set before this runs (0018 pattern); the check below stops it if not.

-- 1. attendance: add an owner, backfill, require it.
alter table public.attendance add column if not exists user_id uuid references auth.users(id) on delete cascade;
update public.attendance set user_id = owner_user_id() where user_id is null;
do $$
begin
  if exists (select 1 from public.attendance where user_id is null) then
    raise exception 'attendance backfill incomplete: the owner members row is missing';
  end if;
end $$;
alter table public.attendance alter column user_id set not null;
create index if not exists attendance_user_id_idx on public.attendance (user_id);

drop policy if exists "members_all" on public.attendance;
create policy "own_attendance" on public.attendance for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 2. seen_sets: visible only through the member's own attendance rows.
drop policy if exists "members_all" on public.seen_sets;
create policy "own_seen_sets" on public.seen_sets for all to authenticated
  using (exists (select 1 from public.attendance a where a.id = seen_sets.attendance_id and a.user_id = auth.uid()))
  with check (exists (select 1 from public.attendance a where a.id = seen_sets.attendance_id and a.user_id = auth.uid()));

-- 3. Catalog tables: read-only for signed-in members. No write policy, so only the server's key can write.
do $$
declare t text;
begin
  foreach t in array array[
    'source_documents','performer_claims','artist_aliases','extraction_blocklist',
    'performances','event_series','event_editions','canonical_artists','corrections','extraction_examples'
  ] loop
    execute format('drop policy if exists "members_all" on public.%I', t);
    execute format('create policy "members_read" on public.%I for select to authenticated using (true)', t);
  end loop;
end $$;

-- 4. Operational counters: owner only.
do $$
declare t text;
begin
  foreach t in array array['quota_ledger','source_stats'] loop
    execute format('drop policy if exists "members_all" on public.%I', t);
    execute format('create policy "owner_read" on public.%I for select to authenticated using (auth.uid() = owner_user_id())', t);
  end loop;
end $$;

-- Check (run after applying; expect 14 tables with RLS on, and attendance with user_id not null):
--   select c.relname, c.relrowsecurity,
--          (select string_agg(policyname, ', ') from pg_policies p where p.tablename = c.relname) as policies
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public' and c.relname in ('attendance','seen_sets','performances','quota_ledger');
--   select count(*) filter (where user_id is null) as unowned from public.attendance;   -- expect 0

-- Rollback (restores the 0024 state; the attendance column is kept, so no data is lost):
--   drop policy if exists "own_attendance" on public.attendance;
--   drop policy if exists "own_seen_sets" on public.seen_sets;
--   drop policy if exists "members_read" on public.performances;  -- repeat for each catalog table
--   drop policy if exists "owner_read" on public.quota_ledger;      -- and source_stats
--   alter table public.attendance alter column user_id drop not null;
