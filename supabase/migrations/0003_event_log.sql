-- Two-stage capture. See REQUIREMENTS.md and ARCHITECTURE.md.
-- Stage 1 stores the event you went to in logged_events, right away.
-- Stage 2 (a lineup lookup started from that event) links it to a canonical
-- edition. logged_events replaces attendance and seen_sets, which are left in
-- place, no longer written, and copied over below.

create table if not exists logged_events (
  id text primary key,
  input text not null default '',          -- the line you typed
  name text not null,
  year int,
  month int check (month between 1 and 12),
  start_date date,
  end_date date,
  venue text,
  city text,
  country text,
  sources jsonb not null default '{}'::jsonb,   -- field -> { sourceType, sourceUrl }
  details jsonb not null default '{"status":"pending","candidates":[],"notes":[]}'::jsonb,
  lineup_job_id text,
  edition_id text references event_editions(id) on delete set null,
  seen jsonb not null default '[]'::jsonb,      -- [{ key, name, from: 'you' | 'lineup' }]
  days_attended date[] not null default '{}',
  companions text[] not null default '{}',
  rating numeric,
  ticket_price numeric,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists logged_events_start_idx on logged_events(start_date);

alter table lookup_jobs add column if not exists event_id text;

-- Carry over what was saved through the old single-step flow.
insert into logged_events (
  id, input, name, year, start_date, end_date, venue, city, country, sources, details,
  edition_id, seen, days_attended, companions, rating, ticket_price, notes, created_at, updated_at
)
select
  a.id,
  e.name,
  e.name,
  e.year,
  e.start_date,
  e.end_date,
  e.venue,
  e.city,
  e.country,
  '{}'::jsonb,
  '{"status":"resolved","candidates":[],"notes":["Carried over from an earlier version."]}'::jsonb,
  e.id,
  coalesce(
    (select jsonb_agg(jsonb_build_object('key', s.artist_key, 'name', coalesce(p.name, ca.name, s.artist_key), 'from', 'lineup'))
       from seen_sets s
       left join performances p on p.edition_id = e.id and p.artist_key = s.artist_key
       left join canonical_artists ca on ca.key = s.artist_key
      where s.attendance_id = a.id),
    '[]'::jsonb
  ),
  a.days_attended,
  a.companions,
  a.rating,
  a.ticket_price,
  a.notes,
  a.created_at,
  a.created_at
from attendance a
join event_editions e on e.id = a.edition_id
on conflict (id) do nothing;
