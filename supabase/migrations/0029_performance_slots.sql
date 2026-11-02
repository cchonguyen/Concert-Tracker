-- 0029_performance_slots.sql
-- Allow artists to have multiple distinct performances (e.g. solo + B2B) in the same festival edition,
-- and store performance slotId, alias, and reciprocal b2b links directly on performance rows.

-- 1. Add id, slot_id, alias, and b2b columns if they don't exist
alter table performances add column if not exists id uuid default gen_random_uuid();
alter table performances add column if not exists slot_id text;
alter table performances add column if not exists alias text;
alter table performances add column if not exists b2b text[] default '{}';

-- 2. Populate id for existing rows
update performances set id = gen_random_uuid() where id is null;
alter table performances alter column id set not null;

-- 3. Replace the composite (edition_id, artist_key) primary key constraint with id primary key
alter table performances drop constraint if exists performances_pkey;
alter table performances add constraint performances_pkey primary key (id);

-- 4. Add index for fast lookups by edition and artist_key
create index if not exists idx_performances_edition_artist on performances(edition_id, artist_key);
create index if not exists idx_performances_slot_id on performances(slot_id);
