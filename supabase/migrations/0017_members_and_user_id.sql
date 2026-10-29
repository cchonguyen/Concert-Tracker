-- Multi-user, step 1 of 2. See ARCHITECTURE.md ("Multi-user").
-- Safe to apply while the app is single-owner: it adds the invite list and a
-- nullable user_id on the personal tables, and turns on row level security
-- with owner-only policies. The server's service key bypasses RLS, so the
-- single-owner app keeps working unchanged. 0018 backfills and tightens.

-- Who has a tracker. Cloudflare Access decides who can sign in; a row here
-- decides who is a member. user_id is filled the first time they sign in
-- (src/server/auth/members.ts). Only the server reads it.
create table if not exists members (
  email text primary key check (email = lower(email)),
  user_id uuid unique references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  invited_at timestamptz not null default now()
);
create unique index if not exists members_one_owner on members ((role)) where role = 'owner';
alter table members enable row level security;

-- The owner's Supabase Auth id, for rows written without a user (the
-- single-owner app, and anything written before multi-user is turned on).
create or replace function owner_user_id() returns uuid
  language sql stable security definer set search_path = public
  as $$ select user_id from members where role = 'owner' $$;

alter table logged_events add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table email_imports add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table lookup_jobs add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table share_links add column if not exists user_id uuid references auth.users(id) on delete cascade;

alter table logged_events alter column user_id set default owner_user_id();
alter table email_imports alter column user_id set default owner_user_id();
alter table lookup_jobs alter column user_id set default owner_user_id();
alter table share_links alter column user_id set default owner_user_id();

create index if not exists logged_events_user_idx on logged_events(user_id);
create index if not exists email_imports_user_idx on email_imports(user_id);
create index if not exists lookup_jobs_user_idx on lookup_jobs(user_id);
create index if not exists share_links_user_idx on share_links(user_id);

-- A member's request carries a 60-second token whose sub is their user id;
-- these policies let it touch only that member's rows.
alter table logged_events enable row level security;
alter table email_imports enable row level security;
alter table lookup_jobs enable row level security;

drop policy if exists own_rows on logged_events;
create policy own_rows on logged_events for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists own_rows on email_imports;
create policy own_rows on email_imports for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists own_rows on lookup_jobs;
create policy own_rows on lookup_jobs for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists own_rows on share_links;
create policy own_rows on share_links for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Each member's own settings (share page name, scan cursors, Sheets link),
-- keyed like app_settings. app_settings keeps the app-wide flags; the owner's
-- existing personal settings are read from it until first written here.
create table if not exists user_settings (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table user_settings enable row level security;
drop policy if exists own_rows on user_settings;
create policy own_rows on user_settings for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
