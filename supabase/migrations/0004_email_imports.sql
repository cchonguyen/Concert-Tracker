-- Stage 1 from email. See ARCHITECTURE.md ("Stage 1 from email").
-- One row per show found in your ticket emails, waiting for your review.
-- Nothing here is part of your log until you tick "I went"; the event is
-- then written to logged_events with each field sourced to the email.
-- The app starts without this table; only email import needs it.

create table if not exists email_imports (
  id text primary key,
  key text not null unique,          -- name + date, or seller + order number
  status text not null check (status in ('new', 'added', 'skipped', 'unreadable', 'flag')),
  start_date date,
  data jsonb not null,               -- the row: fields, quoted sources, message ids and subjects
  updated_at timestamptz not null default now()
);
create index if not exists email_imports_status_idx on email_imports(status);
