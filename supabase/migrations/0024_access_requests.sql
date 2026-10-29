-- Request access, the only migration of this feature. See ARCHITECTURE.md
-- ("Request access"). Not applied to the live database until Charlie's go.
--
-- A signed-in Google account with no members row can ask for access. The owner
-- approves, declines (a lifetime ban, silent) or blocks from the Members panel.
-- Every change to access_requests and members goes through one of the
-- security definer functions below, so the two tables change together or not
-- at all. Each function is callable only by the server (service role): the
-- anon and authenticated keys are revoked, and tests/rls/accessRequests.test.ts
-- checks it.

-- A member whose access is blocked keeps their rows; they just cannot sign in.
alter table members add column if not exists blocked boolean not null default false;

-- Everyone who has ever asked, or was invited, or was banned, with a status.
-- The members table says who may use the app; this table keeps the history.
create table if not exists access_requests (
  email text primary key check (email = lower(email)),
  access_sub text,
  status text not null check (status in ('pending', 'accepted', 'declined', 'left')),
  source text not null check (source in ('requested', 'invited', 'blocked')),
  requested_at timestamptz not null default now(),
  status_changed_at timestamptz not null default now()
);
create index if not exists access_requests_sub_idx on access_requests(access_sub) where access_sub is not null;
alter table access_requests enable row level security;

-- Existing members are accepted, as invited (the owner included).
insert into access_requests (email, status, source, requested_at, status_changed_at)
select email, 'accepted', 'invited', invited_at, invited_at from members
on conflict (email) do nothing;

-- The pause switch and the pending cap, kept with the other app settings.
insert into app_settings (key, data) values ('access_requests', '{"paused": false, "cap": 20}')
on conflict (key) do nothing;

-- A non-member asks. Returns 'sent' (pending, declined, accepted or banned by
-- Access sub: nothing changes) or 'closed' (paused, or the pending cap is full).
-- A 'left' row asks again: it becomes pending, and approval gives an empty tracker.
create or replace function access_request_submit(p_email text, p_sub text)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  s jsonb;
  row_status text;
  pending int;
begin
  -- One request at a time, so two presses cannot overrun the cap or make two rows.
  perform pg_advisory_xact_lock(hashtext('access_requests'));
  select data into s from app_settings where key = 'access_requests';
  if coalesce((s->>'paused')::boolean, false) then return 'closed'; end if;

  select status into row_status from access_requests where email = p_email;
  if row_status is null and p_sub is not null and exists (
    select 1 from access_requests where access_sub = p_sub and status = 'declined'
  ) then
    return 'sent';
  end if;
  if row_status in ('pending', 'declined', 'accepted') then return 'sent'; end if;

  select count(*) into pending from access_requests where status = 'pending';
  if pending >= coalesce((s->>'cap')::int, 20) then return 'closed'; end if;

  if row_status is null then
    insert into access_requests (email, access_sub, status, source) values (p_email, p_sub, 'pending', 'requested');
  else
    update access_requests
      set status = 'pending', source = 'requested', access_sub = p_sub, requested_at = now(), status_changed_at = now()
      where email = p_email;
  end if;
  return 'sent';
end $$;

-- What the refusal screen may show a non-member: 'none' (may ask), 'sent'
-- (pending, banned or accepted), or 'closed'. Never another email or a count.
create or replace function access_request_state(p_email text, p_sub text)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  s jsonb;
  row_status text;
  pending int;
begin
  select data into s from app_settings where key = 'access_requests';
  if coalesce((s->>'paused')::boolean, false) then return 'closed'; end if;

  select status into row_status from access_requests where email = p_email;
  if row_status is null and p_sub is not null and exists (
    select 1 from access_requests where access_sub = p_sub and status = 'declined'
  ) then
    return 'sent';
  end if;
  if row_status in ('pending', 'declined', 'accepted') then return 'sent'; end if;

  select count(*) into pending from access_requests where status = 'pending';
  if pending >= coalesce((s->>'cap')::int, 20) then return 'closed'; end if;
  return 'none';
end $$;

-- The owner switches a status. Both tables change in this one call.
--   accepted: a members row (unblocked); new emails get source p_new_source.
--   declined: a ban. A members row, if any, is blocked (its data is kept).
--   pending:  for re-review. A members row, if any, is blocked (data kept).
-- The owner's own row cannot be changed. 'left' is set only by removal below.
create or replace function access_request_set(p_email text, p_to text, p_new_source text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_to not in ('pending', 'accepted', 'declined') then
    raise exception 'A status cannot be set to %.', p_to;
  end if;
  if p_new_source not in ('invited', 'blocked') then
    raise exception 'A new row cannot start as %.', p_new_source;
  end if;
  if exists (select 1 from members where email = p_email and role = 'owner') then
    raise exception 'The owner cannot be changed here.';
  end if;

  if p_to = 'accepted' then
    insert into members (email, role, blocked) values (p_email, 'member', false)
      on conflict (email) do update set blocked = false;
  else
    update members set blocked = true where email = p_email;
  end if;

  insert into access_requests (email, status, source, status_changed_at)
    values (p_email, p_to, p_new_source, now())
    on conflict (email) do update
      set status = excluded.status, status_changed_at = now()
      where access_requests.status is distinct from excluded.status;
end $$;

-- After a member's data is deleted (the Auth user, and with it the members row).
-- The owner deleting it leaves the row declined, or left if it already was.
-- A member deleting their own account leaves the row left.
create or replace function access_request_removed(p_email text, p_by text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_by not in ('owner', 'self') then raise exception 'Unknown remover %.', p_by; end if;
  insert into access_requests (email, status, source, status_changed_at)
    values (p_email, case when p_by = 'self' then 'left' else 'declined' end, 'invited', now())
    on conflict (email) do update
      set status = case when p_by = 'self' or access_requests.status = 'left' then 'left' else 'declined' end,
          status_changed_at = now();
end $$;

-- Only the server calls these. Supabase grants execute to the anon and
-- authenticated keys by default, so the grant is taken back explicitly.
revoke execute on function access_request_submit(text, text) from public, anon, authenticated;
revoke execute on function access_request_state(text, text) from public, anon, authenticated;
revoke execute on function access_request_set(text, text, text) from public, anon, authenticated;
revoke execute on function access_request_removed(text, text) from public, anon, authenticated;
grant execute on function access_request_submit(text, text) to service_role;
grant execute on function access_request_state(text, text) to service_role;
grant execute on function access_request_set(text, text, text) to service_role;
grant execute on function access_request_removed(text, text) to service_role;
