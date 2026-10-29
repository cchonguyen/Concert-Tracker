-- Tips and milestones, the account's copy. See ARCHITECTURE.md ("Home" and "Milestones").
--
-- Before this, the Home tips and the milestone mark lived in each browser's
-- localStorage. They now sit in user_settings (0017) under the keys 'tips' and
-- 'milestone', so they follow the account. The single-owner app keeps them in
-- app_settings (0006) under the same keys. No column or table changes are
-- needed: user_settings already keys each row by (user_id, key) with row level
-- security on. This file only makes sure that still holds, and it is safe to re-run.
--
-- Apply only after Charlie's go. Nothing in the app runs it.

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

-- CHECK QUERY (run after applying, read only). Expect:
--   * relrowsecurity = true for user_settings;
--   * one row per key that has been written, with its last write time;
--   * no error. A zero-row result is fine on a fresh install (nothing written yet).
--
-- select c.relname, c.relrowsecurity
--   from pg_class c
--  where c.relname = 'user_settings';
--
-- select 'user_settings' as source, key, count(*) as rows, max(updated_at) as last_write
--   from user_settings
--  where key in ('tips', 'milestone')
--  group by key
-- union all
-- select 'app_settings', key, count(*), max(updated_at)
--   from app_settings
--  where key in ('tips', 'milestone')
--  group by key;

-- ROLLBACK (destructive, run only if the new code must come off). Read the
-- first step, then run the rest in order.
--
-- 1. Keep a copy of what the account saved, in a table the app never reads:
--    create table if not exists prefs_rollback_0027 as
--      select 'user_settings'::text as source, user_id, key, data, updated_at
--        from user_settings where key in ('tips', 'milestone')
--      union all
--      select 'app_settings', null::uuid, key, data, updated_at
--        from app_settings where key in ('tips', 'milestone');
--
-- 2. Remove those keys. The table, its policies and every other key stay (0017 needs them):
--    delete from user_settings where key in ('tips', 'milestone');
--    delete from app_settings where key in ('tips', 'milestone');
--
-- After a rollback the old code reads localStorage again, so tips and the
-- milestone mark start over in each browser. The copy in prefs_rollback_0027
-- can be read back by hand if needed; drop it once nothing needs it.
