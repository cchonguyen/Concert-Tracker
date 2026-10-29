-- Friendliness PR 7 (Log data). See ARCHITECTURE.md ("Activity log").
-- Adds soft delete for shows and a per-member activity log. Not applied to the
-- live database until Charlie's go.

-- Deleted shows stay in the table with deleted_at set, so Restore is real.
-- Reads filter deleted_at IS NULL. A nightly job purges rows older than 90 days.
alter table logged_events add column if not exists deleted_at timestamptz;
create index if not exists logged_events_deleted_idx on logged_events(deleted_at) where deleted_at is not null;

-- One row per change, delete, restore or undo. Kept one year, then purged nightly.
-- For sensitive fields (notes, companions) before_value and after_value hold ciphertext only.
create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade default owner_user_id(),
  event_id text,
  action text not null check (action in ('create', 'update', 'delete', 'restore', 'undo')),
  field text,
  before_value jsonb,
  after_value jsonb,
  sensitive boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists activity_log_user_time_idx on activity_log(user_id, created_at desc);
create index if not exists activity_log_event_idx on activity_log(event_id);

alter table activity_log enable row level security;
drop policy if exists own_rows on activity_log;
create policy own_rows on activity_log for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
