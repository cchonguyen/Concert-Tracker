-- Share page links (ShareLink in src/server/share/types.ts). One row per link
-- you made; only the newest without revoked_at is active. Only a SHA-256 hash
-- of the link's code is stored, so this table alone cannot rebuild a working
-- link. settings: { displayName, timeZone, showDates, showVenues, showFormat }.
-- Apply this before deploying the code that reads it.

create table if not exists share_links (
  id text primary key,
  code_hash text not null unique,
  settings jsonb not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- Only the server (service role) reads or writes it; no policy grants anyone else access.
alter table share_links enable row level security;
