-- Multi-user: each member's own records, step 3. Apply after 0017 and 0018.
-- Safe while single-owner: the tables are new and nothing reads them until
-- MULTI_USER=on. See ARCHITECTURE.md ("Multi-user").
--
-- Every member (the owner too, after 0021 copies their records) has their
-- own entities, aliases, links and history, so renaming, merging and adding
-- AKAs in Manage never touches anyone else's records. Nothing here is
-- readable by other members: the policies are own-rows only, and the old
-- shared tables (entities, ...) get no policy for members because they
-- were built from the owner's own events.

-- Records. A person whose vault is on has name_encrypted (AES-GCM, encrypted
-- in the browser) and no readable name; everything else keeps a plain name.
create table if not exists user_entities (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  kind text not null check (kind in ('artist', 'person', 'venue', 'place', 'series', 'organization', 'label')),
  name text not null default '',
  name_normalized text not null default '',
  name_encrypted text,
  attrs jsonb not null default '{}'::jsonb,
  merged_into_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, merged_into_id) references user_entities(user_id, id) on delete restrict deferrable initially deferred,
  check (merged_into_id is distinct from id),
  check (
    (name_encrypted is not null and kind = 'person' and name = '' and name_normalized = '')
    or (name_encrypted is null and name_normalized <> '')
  )
);
create unique index if not exists user_entities_live_name_idx
  on user_entities(user_id, kind, name_normalized) where merged_into_id is null and name_encrypted is null;

-- Typed names and spellings that lead to a record. For an encrypted person,
-- companion_token is HMAC-SHA256(companion key, normalized name) in hex, so
-- the server can match a typed name without being able to read any name; for
-- every other record it is the normalized alias itself.
create table if not exists user_entity_aliases (
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_id uuid not null,
  kind text not null,
  companion_token text not null check (companion_token <> ''),
  foreign key (user_id, entity_id) references user_entities(user_id, id) on delete cascade,
  unique (user_id, kind, companion_token)
);
create index if not exists user_entity_aliases_entity_idx on user_entity_aliases(user_id, entity_id);

create table if not exists user_entity_links (
  user_id uuid not null references auth.users(id) on delete cascade,
  from_id uuid not null,
  to_id uuid not null,
  role text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, from_id, to_id, role),
  foreign key (user_id, from_id) references user_entities(user_id, id) on delete cascade,
  foreign key (user_id, to_id) references user_entities(user_id, id) on delete cascade,
  check (from_id <> to_id)
);

create table if not exists user_entity_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  operation text not null,
  manifest jsonb not null,
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  primary key (user_id, id)
);

-- A member's own genres for the acts they saw. The shared artist_genres come
-- from the owner's listening export and are not shown to members.
create table if not exists user_artist_genres (
  user_id uuid not null references auth.users(id) on delete cascade,
  artist_key text not null,
  name text not null,
  genres jsonb not null default '[]',       -- [{ parent, style, weight }], as artist_genres
  updated_at timestamptz not null default now(),
  primary key (user_id, artist_key)
);

alter table logged_events add column if not exists person_ids uuid[] not null default '{}';

-- Events point at records by id. Members' ids live in user_entities, so the
-- foreign keys to the old shared table (0014) are replaced by one check that
-- accepts a record of the event's own user (or, for the owner's rows before
-- 0021 copies them, the shared table).
alter table logged_events drop constraint if exists logged_events_venue_id_fkey;
alter table logged_events drop constraint if exists logged_events_place_id_fkey;
alter table logged_events drop constraint if exists logged_events_series_id_fkey;

create or replace function check_event_record_ids() returns trigger
  language plpgsql set search_path = public as $$
declare
  rid uuid;
begin
  foreach rid in array array[new.venue_id, new.place_id, new.series_id]
  loop
    if rid is not null
       and not exists (select 1 from user_entities u where u.user_id = new.user_id and u.id = rid)
       and not exists (select 1 from entities e where e.id = rid) then
      raise exception 'Event % points at a record that does not exist (%).', new.id, rid;
    end if;
  end loop;
  if new.person_ids is not null and cardinality(new.person_ids) > 0 then
    if exists (
      select 1 from unnest(new.person_ids) p
      where not exists (select 1 from user_entities u where u.user_id = new.user_id and u.id = p and u.kind = 'person')
    ) then
      raise exception 'Event % lists a person that is not one of this user''s people.', new.id;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists logged_events_record_ids on logged_events;
create trigger logged_events_record_ids before insert or update on logged_events
  for each row execute function check_event_record_ids();

alter table user_entities enable row level security;
alter table user_entity_aliases enable row level security;
alter table user_entity_links enable row level security;
alter table user_entity_history enable row level security;
alter table user_artist_genres enable row level security;

drop policy if exists own_rows on user_entities;
create policy own_rows on user_entities for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists own_rows on user_entity_aliases;
create policy own_rows on user_entity_aliases for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists own_rows on user_entity_links;
create policy own_rows on user_entity_links for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists own_rows on user_entity_history;
create policy own_rows on user_entity_history for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists own_rows on user_artist_genres;
create policy own_rows on user_artist_genres for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
