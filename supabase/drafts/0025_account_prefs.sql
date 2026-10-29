-- DRAFT, NOT APPLIED. Lives in supabase/drafts/ so no migration runner picks it up.
-- Move it to supabase/migrations/ (as 0025) only after Charlie's go, and then apply it.
-- Friendliness follow-up: saves Home tips and milestone progress per account, so they
-- follow you to another browser. Today they live in localStorage (services/tips.ts,
-- App milestone effect).

-- One row per preference per account. Keys used by the app:
--   'tips'      { dismissed: string[], allHidden: boolean }
--   'milestone' { shows: number, artists: number }   (highest milestone shown)
create table if not exists account_prefs (
  user_id uuid not null references auth.users(id) on delete cascade default owner_user_id(),
  key text not null check (key in ('tips', 'milestone')),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table account_prefs enable row level security;
drop policy if exists own_rows on account_prefs;
create policy own_rows on account_prefs for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
