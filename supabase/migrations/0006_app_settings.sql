-- Small app settings kept between runs. See ARCHITECTURE.md ("Stage 1 from
-- email"): "gmail" holds the Gmail sign-in for "Check email" (a refresh
-- token, read-only scope) and "email_scan" how far your mail has been read.
-- Only the server (service role) reads this table: row level security is on
-- and no policy grants anyone else access.
-- Needed only for "Check email"; the rest of the app works without it.

create table if not exists app_settings (
  key text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table app_settings enable row level security;
