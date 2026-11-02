-- Email notifications and opt-outs (see ARCHITECTURE.md, "Email notifications").
-- Tracks who has opted out of emails and when invite/welcome emails were sent
-- so re-inviting or re-accepting never sends duplicate emails.
-- RLS is enabled with no policies for anon or authenticated: only the server
-- (service_role) reads or writes this table.

create table if not exists email_preferences (
  email text primary key check (email = lower(email)),
  opted_out boolean not null default false,
  opted_out_at timestamptz,
  invite_sent_at timestamptz,
  welcome_sent_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table email_preferences enable row level security;
revoke all on table email_preferences from public, anon, authenticated;
grant all on table email_preferences to service_role;
