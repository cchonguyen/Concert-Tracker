-- Multi-user cutover for the owner's records. Apply once, after 0018 and
-- 0020, in the same maintenance window as turning MULTI_USER=on.
--
-- Copies the owner's records (entities, aliases, links, history) into the
-- per-member tables with the SAME ids, so every event's venue_id, place_id,
-- series_id and companion_ids stay valid whether the app reads the old
-- tables (MULTI_USER off) or the new ones. The old tables are left as they
-- are: turning MULTI_USER off goes back to them. Records and renames made
-- while multi-user was on stay in the new tables only.
-- The owner's genre files (artist_genres) stay shared with the owner only.

do $$
begin
  if owner_user_id() is null then
    raise exception 'No owner in members with a user_id. Apply 0018 first.';
  end if;
end $$;

-- The merge link is checked at the end of the statement (deferred), so a
-- merged record can arrive before its target.
insert into user_entities (user_id, id, kind, name, name_normalized, attrs, merged_into_id, created_at, updated_at)
  select owner_user_id(), id, kind, name, name_normalized, attrs, merged_into_id, created_at, updated_at
  from entities
  on conflict (user_id, id) do nothing;

insert into user_entity_aliases (user_id, entity_id, kind, companion_token)
  select owner_user_id(), entity_id, kind, alias_normalized from entity_aliases
  on conflict (user_id, kind, companion_token) do nothing;

insert into user_entity_links (user_id, from_id, to_id, role, created_at)
  select owner_user_id(), from_id, to_id, role, created_at from entity_links
  on conflict do nothing;

insert into user_entity_history (user_id, id, operation, manifest, created_at, undone_at)
  select owner_user_id(), id, operation, manifest, created_at, undone_at from entity_history
  on conflict (user_id, id) do nothing;
