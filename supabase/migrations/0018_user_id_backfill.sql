-- Multi-user, step 2 of 2. Apply after 0017, after the owner exists:
--   1. Supabase dashboard > Authentication > Users > Add user, with the
--      owner's Cloudflare Access email (no password needed).
--   2. insert into members (email, user_id, role)
--        values ('<owner email, lower case>', '<that user id>', 'owner');
--   3. Run this file.
-- Every existing row becomes the owner's, user_id becomes required, and an
-- email import's key is unique per member instead of across the app.

do $$
begin
  if owner_user_id() is null then
    raise exception 'No owner in members with a user_id. See the steps at the top of 0018_user_id_backfill.sql.';
  end if;
end $$;

update logged_events set user_id = owner_user_id() where user_id is null;
update email_imports set user_id = owner_user_id() where user_id is null;
update lookup_jobs set user_id = owner_user_id() where user_id is null;
update share_links set user_id = owner_user_id() where user_id is null;

alter table logged_events alter column user_id set not null;
alter table email_imports alter column user_id set not null;
alter table lookup_jobs alter column user_id set not null;
alter table share_links alter column user_id set not null;

alter table email_imports drop constraint if exists email_imports_key_key;
alter table email_imports drop constraint if exists email_imports_user_key;
alter table email_imports add constraint email_imports_user_key unique (user_id, key);
