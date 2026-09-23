import { PopulatedEvent } from '../types/schema';

/**
 * CSV Serialization adhering to specification:
 * Single row per event, multiple artists grouped into a semicolon-delimited field ("Porter Robinson; Ericdoa")
 */
export function serializeEventsToCsv(events: PopulatedEvent[]): string {
  const headers = [
    'Event ID',
    'Event Name',
    'Tour Name',
    'Event Date',
    'Is Festival',
    'End Date',
    'Total Festival Days',
    'Attended Days Count',
    'Attended Days Details',
    'Venue Name',
    'Venue City',
    'Venue State',
    'Venue Country',
    'Is Outdoor',
    'Artists (Semicolon Delimited)',
    'Headliners',
    'Support Acts',
    'Setlist Confirmed',
    'Confidence Score',
    'Ticket Price (USD)',
    'Seating Tier',
    'Companions',
    'Attendance Status',
    'Rating',
    'Created At',
  ];

  const rows = events.map((e) => {
    // Semicolon-delimited list of all artists in billing order
    const allArtists = e.appearances
      .sort((a, b) => a.billing_order - b.billing_order)
      .map((a) => a.artist.name)
      .join('; ');

    const headliners = e.appearances
      .filter((a) => a.billing_role === 'headliner')
      .map((a) => a.artist.name)
      .join('; ');

    const supportActs = e.appearances
      .filter((a) => a.billing_role === 'support' || a.billing_role === 'guest')
      .map((a) => a.artist.name)
      .join('; ');

    const companions = (e.companions || []).join('; ');

    const isFestival = e.is_festival || (e.festival_days && e.festival_days.length > 0);
    const totalDays = e.festival_days?.length || (isFestival ? 1 : '');
    const attendedDaysCount = e.festival_days
      ? e.festival_days.filter((d) => d.attended).length
      : isFestival
        ? (e.attendance_status === 'attended' ? 1 : 0)
        : '';
    const attendedDaysDetails = e.festival_days
      ? e.festival_days
          .filter((d) => d.attended)
          .map((d) => `${d.label || 'Day ' + d.day_index} (${d.date})`)
          .join('; ')
      : '';

    return [
      escapeCsv(e.id),
      escapeCsv(e.name),
      escapeCsv(e.tour_name || ''),
      escapeCsv(e.event_date),
      isFestival ? 'TRUE' : 'FALSE',
      escapeCsv(e.end_date || ''),
      totalDays.toString(),
      attendedDaysCount.toString(),
      escapeCsv(attendedDaysDetails),
      escapeCsv(e.venue.name),
      escapeCsv(e.venue.city),
      escapeCsv(e.venue.state || ''),
      escapeCsv(e.venue.country || ''),
      e.venue.isOutdoor ? 'TRUE' : 'FALSE',
      escapeCsv(allArtists),
      escapeCsv(headliners),
      escapeCsv(supportActs),
      e.setlist_confirmed ? 'TRUE' : 'FALSE',
      e.confidence_score.toFixed(2),
      e.ticket_price != null ? e.ticket_price.toString() : '',
      escapeCsv(e.seating_tier || ''),
      escapeCsv(companions),
      escapeCsv(e.attendance_status),
      e.rating != null ? e.rating.toString() : '',
      escapeCsv(e.created_at),
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

function escapeCsv(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes(';')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

/**
 * JSON Serialization: nested document collections containing complete arrays
 * of artist objects, venue details, and raw timestamps.
 */
export function serializeEventsToJson(events: PopulatedEvent[]): string {
  const exportPayload = {
    version: '1.0',
    exported_at: new Date().toISOString(),
    source: 'LiveArchive Grounded Concert Tracking Intelligence Engine',
    total_records: events.length,
    events: events.map((e) => ({
      id: e.id,
      name: e.name,
      tour_name: e.tour_name || null,
      event_date: e.event_date,
      created_at: e.created_at,
      notes: e.notes || '',
      setlist_confirmed: e.setlist_confirmed,
      confidence_score: e.confidence_score,
      source_urls: e.source_urls,
      ticket_price: e.ticket_price ?? null,
      seating_tier: e.seating_tier ?? null,
      companions: e.companions ?? [],
      attendance_status: e.attendance_status,
      rating: e.rating ?? null,
      venue: {
        id: e.venue.id,
        name: e.venue.name,
        city: e.venue.city,
        state: e.venue.state,
        country: e.venue.country,
        is_outdoor: e.venue.isOutdoor ?? false,
        capacity: e.venue.capacity ?? null,
      },
      artists: e.appearances
        .sort((a, b) => a.billing_order - b.billing_order)
        .map((app) => ({
          id: app.artist.id,
          name: app.artist.name,
          musicbrainz_id: app.artist.musicbrainz_id || null,
          billing_role: app.billing_role,
          billing_order: app.billing_order,
          stage_name: app.stage_name || null,
        })),
      setlist_tracks: e.setlist_tracks || [],
    })),
  };

  return JSON.stringify(exportPayload, null, 2);
}

/**
 * Supabase DDL SQL Schema matching the exact relational topology specified:
 */
export function generateSupabaseSqlSchema(): string {
  return `-- ====================================================================
-- LIVEARCHIVE: SUPABASE RELATIONAL CORE SCHEMA
-- Relational Topology for High-Fidelity Concert Manifests & Downstream Sync
-- ====================================================================

-- 1. Enable UUID extension
create extension if not exists "uuid-ossp";

-- 2. Venues Table
create table if not exists public.venues (
    id uuid primary key default uuid_generate_v4(),
    name text not null unique,
    city text not null,
    state text,
    country text not null,
    is_outdoor boolean default false,
    capacity integer,
    created_at timestamp with time zone default now()
);

-- 3. Artists Table (with MusicBrainz Canonical Identifier)
create table if not exists public.artists (
    id uuid primary key default uuid_generate_v4(),
    name text not null unique,
    musicbrainz_id text,
    disambiguation text,
    genres text[],
    created_at timestamp with time zone default now()
);

-- 4. Events Table (Authoritative transactional core)
create table if not exists public.events (
    id uuid primary key default uuid_generate_v4(),
    name text not null,
    tour_name text,
    event_date date not null,
    is_festival boolean default false,
    end_date date,
    festival_days jsonb, -- Array of { date, day_index, label, attended, notes }
    venue_id uuid not null references public.venues(id) on delete restrict,
    notes text,
    setlist_confirmed boolean default false,
    confidence_score numeric(4,3) check (confidence_score >= 0 and confidence_score <= 1.0),
    source_urls text[],
    ticket_price numeric(10,2),
    seating_tier text,
    companions text[],
    attendance_status text default 'attended' check (attendance_status in ('attended', 'upcoming', 'wishlist')),
    rating smallint check (rating between 1 and 5),
    created_at timestamp with time zone default now()
);

-- 5. Event Appearances (Lineup Decomposition Junction Table)
create table if not exists public.event_appearances (
    id uuid primary key default uuid_generate_v4(),
    event_id uuid not null references public.events(id) on delete cascade,
    artist_id uuid not null references public.artists(id) on delete restrict,
    billing_role text not null check (billing_role in ('headliner', 'support', 'guest', 'festival_lineup')),
    billing_order integer not null default 1,
    stage_name text,
    created_at timestamp with time zone default now(),
    unique(event_id, artist_id)
);

-- Indices for dynamic typeahead querying and aggregation performance
create index if not exists idx_events_date on public.events(event_date desc);
create index if not exists idx_events_venue on public.events(venue_id);
create index if not exists idx_venues_name_trgm on public.venues using gin(name gin_trgm_ops);
create index if not exists idx_artists_name_trgm on public.artists using gin(name gin_trgm_ops);
create index if not exists idx_appearances_event on public.event_appearances(event_id);
create index if not exists idx_appearances_artist on public.event_appearances(artist_id);

-- Downstream Google Sheets Webhook Trigger Function
-- Automatically dispatches a POST webhook payload to an edge function
create or replace function public.dispatch_google_sheets_sync()
returns trigger as $$
declare
    v_payload jsonb;
    v_artists text;
    v_venue_name text;
    v_venue_city text;
begin
    select string_agg(a.name, '; ' order by ea.billing_order)
    into v_artists
    from public.event_appearances ea
    join public.artists a on a.id = ea.artist_id
    where ea.event_id = NEW.id;

    select name, city into v_venue_name, v_venue_city
    from public.venues where id = NEW.venue_id;

    v_payload := jsonb_build_object(
        'event_id', NEW.id,
        'event_name', NEW.name,
        'tour_name', NEW.tour_name,
        'event_date', NEW.event_date,
        'venue', v_venue_name,
        'city', v_venue_city,
        'artists', coalesce(v_artists, ''),
        'ticket_price', NEW.ticket_price,
        'synced_at', now()
    );

    -- Call Supabase pg_net / edge webhook
    perform net.http_post(
        url := current_setting('app.settings.sheets_webhook_url', true),
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body := v_payload
    );

    return NEW;
end;
$$ language plpgsql security definer;
`;
}

/**
 * Download file helper in browser
 */
export function downloadFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
