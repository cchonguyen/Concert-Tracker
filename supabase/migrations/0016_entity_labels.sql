-- Labels as records (Manage step 5): kind 'label' on entities, linked from
-- venues and series with role 'has_label' (entity_links roles are checked in
-- code, src/server/entities/types.ts). Without this, adding a label fails;
-- everything else keeps working. Apply after 0014.

alter table entities drop constraint if exists entities_kind_check;
alter table entities add constraint entities_kind_check
  check (kind in ('artist', 'person', 'venue', 'place', 'series', 'organization', 'label'));
