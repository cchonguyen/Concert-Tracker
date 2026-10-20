-- Source-first lineup architecture. See ARCHITECTURE.md.
-- Three layers: canonical facts, the evidence behind them, and the personal log,
-- plus operational tables for the lookup queue, quota and learning loops.
-- Existing tables (venues, artists, events, event_appearances) are untouched.

-- Canonical layer --------------------------------------------------------

create table if not exists event_series (
  slug text primary key,
  name text not null,
  lineup_url text,
  clashfinder_slugs jsonb not null default '{}'::jsonb,
  source_priority text[],
  created_at timestamptz not null default now()
);

create table if not exists event_editions (
  id text primary key,
  key text not null unique,                -- series_slug/year
  series_slug text not null references event_series(slug),
  year int not null,
  name text not null,
  start_date date,
  end_date date,
  venue text,
  city text,
  country text,
  status text not null check (status in ('draft', 'confirmed')),
  confirmed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists canonical_artists (
  key text primary key,                    -- normalized name
  name text not null,
  mbid text unique,
  resolved_at timestamptz
);

create table if not exists performances (
  edition_id text not null references event_editions(id) on delete cascade,
  artist_key text not null references canonical_artists(key),
  name text not null,
  days date[] not null default '{}',
  stages text[] not null default '{}',
  status text not null check (status in ('billed', 'performed', 'cancelled')),
  confidence numeric not null,
  sources jsonb not null default '[]'::jsonb,  -- CandidateSource[] with URLs and quoted spans
  primary key (edition_id, artist_key)
);

-- Evidence layer ---------------------------------------------------------

create table if not exists source_documents (
  id text primary key,
  url text not null,
  source_type text not null,
  fetched_at timestamptz not null,
  content_hash text not null,
  content_type text not null,
  body text not null,
  unique (url, content_hash)
);

create table if not exists performer_claims (
  id text primary key,
  job_id text not null,
  document_id text not null references source_documents(id),
  source_type text not null,
  source_url text not null,
  name text not null,
  quoted_span text not null,
  evidence text not null check (evidence in ('billed', 'performed', 'crowd')),
  day date,
  stage text,
  start_time text,
  end_time text,
  mbid text,
  extractor text not null,
  extractor_version text not null,
  created_at timestamptz not null default now()
);
create index if not exists performer_claims_job_idx on performer_claims(job_id);

-- Operations -------------------------------------------------------------

create table if not exists lookup_jobs (
  id text primary key,
  kind text not null,
  edition_key text not null,
  status text not null,
  stage text not null,
  input jsonb not null,
  attempts int not null default 0,
  next_attempt_at timestamptz,
  waiting_reason text,
  last_error text,
  pending_extraction jsonb not null default '[]'::jsonb,
  discovery_done boolean not null default false,
  facts jsonb not null default '{}'::jsonb,
  candidate jsonb,
  edition_id text,
  log jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists lookup_jobs_due_idx on lookup_jobs(status, next_attempt_at);

create table if not exists quota_ledger (
  key text primary key,                    -- provider:model:window
  used int not null default 0,
  exhausted_until timestamptz
);

-- Learning loops ---------------------------------------------------------

create table if not exists artist_aliases (
  alias_normalized text primary key,
  canonical_name text not null
);

create table if not exists extraction_blocklist (
  domain text not null,                    -- '*' for global
  normalized text not null,
  rejections int not null default 1,
  primary key (domain, normalized)
);

create table if not exists source_stats (
  source_type text not null,
  scope text not null,                     -- series slug or '*'
  accepted int not null default 0,
  rejected int not null default 0,
  primary key (source_type, scope)
);

create table if not exists corrections (
  id text primary key,
  edition_key text not null,
  kind text not null check (kind in ('rejected', 'renamed', 'added')),
  original text,
  corrected text,
  source_types text[] not null default '{}',
  source_urls text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists extraction_examples (
  id bigserial primary key,
  domain text not null,
  excerpt text not null,
  names text[] not null,
  created_at timestamptz not null default now()
);
create index if not exists extraction_examples_domain_idx on extraction_examples(domain);

-- Personal layer ---------------------------------------------------------

create table if not exists attendance (
  id text primary key,
  edition_id text not null references event_editions(id),
  days_attended date[] not null default '{}',
  rating numeric,
  ticket_price numeric,
  companions text[] not null default '{}',
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists seen_sets (
  attendance_id text not null references attendance(id) on delete cascade,
  artist_key text not null references canonical_artists(key),
  primary key (attendance_id, artist_key)
);
