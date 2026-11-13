-- RLS audit hardening (see the audit note in the PR). Written only; Charlie applies it.
-- Adds nothing and removes nothing: it turns row level security on for 14 public
-- tables whose policies were recorded in 0026 (and 0002's attendance and seen_sets)
-- but whose RLS switch is not in any migration. A policy has no effect while RLS is
-- off, so on a database where it was never switched on, anon and authenticated could
-- read and write these tables through the Supabase API.
--
-- Safe to run twice. The server's service key bypasses RLS, so the app is unchanged.
-- Member requests use their own token, and only touch the personal tables
-- (src/server/lineup/store/supabaseStore.ts, own()), none of which is listed here.

alter table public.attendance enable row level security;
alter table public.seen_sets enable row level security;
alter table public.quota_ledger enable row level security;
alter table public.source_stats enable row level security;
alter table public.source_documents enable row level security;
alter table public.performer_claims enable row level security;
alter table public.artist_aliases enable row level security;
alter table public.extraction_blocklist enable row level security;
alter table public.performances enable row level security;
alter table public.event_series enable row level security;
alter table public.event_editions enable row level security;
alter table public.canonical_artists enable row level security;
alter table public.corrections enable row level security;
alter table public.extraction_examples enable row level security;

-- Check (run after applying; expect 14 rows, all true):
--   select c.relname, c.relrowsecurity
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public' and c.relkind = 'r' order by c.relname;

-- Rollback (restores the state before this migration; policies are kept):
--   alter table public.attendance disable row level security;   -- repeat for each table above
