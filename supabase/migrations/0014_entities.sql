-- Records with permanent IDs for the things that repeat across events: the
-- artists you saw, the people you went with, venues, places (a city with
-- its state and country), series and organizations (src/server/entities/).
-- Contracts: .spec/SYSTEM_SPEC.md section 3.
--
-- This release dual-writes: the text columns on logged_events stay the
-- source of truth and the app fills the ID columns from them on every save,
-- so reading text only (a rollback) loses nothing. Existing events get
-- their IDs from the app's backfill (the minute cron), not from this file,
-- because names are matched with the app's own normalizer.
--
-- Optional until the Manage tab ships: the app saves events without IDs
-- when these tables are missing.

create table if not exists entities (
  id uuid primary key,
  kind text not null check (kind in ('artist', 'person', 'venue', 'place', 'series', 'organization')),
  name text not null,
  name_normalized text not null,
  attrs jsonb not null default '{}'::jsonb,
  -- Set when this record was merged into another. Merges are flattened, so
  -- the target is never itself merged. Records are never deleted.
  merged_into_id uuid references entities(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (merged_into_id is distinct from id)
);
-- One live record per name within a kind; the same name may exist under
-- different kinds (an artist and a series).
create unique index if not exists entities_kind_name_live_idx
  on entities(kind, name_normalized) where merged_into_id is null;
create index if not exists entities_merged_into_idx on entities(merged_into_id);

-- Other names a record goes by (AKA, old spellings, merged-away names).
create table if not exists entity_aliases (
  entity_id uuid not null references entities(id) on delete restrict,
  kind text not null,
  alias_normalized text not null,
  unique (kind, alias_normalized)
);
create index if not exists entity_aliases_entity_idx on entity_aliases(entity_id);

-- Relationships between records (venue in place, series hosted by
-- organization). Allowed kind/role/kind triples are checked in code.
create table if not exists entity_links (
  from_id uuid not null references entities(id) on delete restrict,
  to_id uuid not null references entities(id) on delete restrict,
  role text not null,
  created_at timestamptz not null default now(),
  primary key (from_id, to_id, role),
  check (from_id <> to_id)
);
create index if not exists entity_links_to_idx on entity_links(to_id);

-- Every rename, merge and attribute change, with a manifest that undoes it
-- exactly. Written from the Manage tab (later slice).
create table if not exists entity_history (
  id uuid primary key,
  operation text not null,
  manifest jsonb not null,
  created_at timestamptz not null default now(),
  undone_at timestamptz
);

-- Events point at records. People and artists live in JSON and arrays,
-- where Postgres cannot check them; the app does.
alter table logged_events add column if not exists venue_id uuid references entities(id) on delete restrict;
alter table logged_events add column if not exists place_id uuid references entities(id) on delete restrict;
alter table logged_events add column if not exists series_id uuid references entities(id) on delete restrict;
alter table logged_events add column if not exists companion_ids uuid[];
create index if not exists logged_events_venue_idx on logged_events(venue_id);
create index if not exists logged_events_place_idx on logged_events(place_id);
create index if not exists logged_events_series_idx on logged_events(series_id);

alter table entities enable row level security;
alter table entity_aliases enable row level security;
alter table entity_links enable row level security;
alter table entity_history enable row level security;
