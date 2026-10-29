-- A 24-hour cache of raw upstream responses (src/server/lineup/responseCache.ts).
-- Only Ticketmaster Discovery responses are kept: its terms allow "reasonable
-- periods". Brave Search results are never stored (its terms forbid it).
-- The key is a hash of the request URL with the API key removed; no personal
-- field is in it. Off unless SOURCE_CACHE=on. Only the server reads it.

create table if not exists source_response_cache (
  key text primary key,
  source_type text not null,
  status int not null,
  body text not null,
  fetched_at timestamptz not null,
  expires_at timestamptz not null
);
create index if not exists source_response_cache_expires_idx on source_response_cache(expires_at);
alter table source_response_cache enable row level security;
