-- Legacy conversion (planned in 0041, applied after 0041 and 0043 by Charlie, 2026-11-14).
-- Turns the old 'confirmed' editions into 'verified' and tightens the status check to the new set.
-- Check first: select status, count(*) from public.event_editions group by status;   -- expect a 'confirmed' count
begin;
update public.event_editions set status = 'verified' where status = 'confirmed';
alter table public.event_editions drop constraint if exists event_editions_status_check;
alter table public.event_editions add constraint event_editions_status_check
  check (status in ('draft', 'provisional', 'verified'));
commit;
