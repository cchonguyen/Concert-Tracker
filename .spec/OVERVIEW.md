# Project Overview (Owner's Manual)

## What This App Does
- LiveArchive helps people remember which events they went to and who they saw there. Full purpose and principles: [REQUIREMENTS.md](../REQUIREMENTS.md). How it works: [ARCHITECTURE.md](../ARCHITECTURE.md).

## Active External Services & Keys
- Cloudflare Workers (hosting at concert.charliechonguyen.com, deployed only via GitHub Actions on merge to `main`), Cloudflare Access, Supabase, Gemini (paid key, model `gemini-3.5-flash-lite`), MusicBrainz, setlist.fm, Ticketmaster, Clashfinder, Brave Search (capped at 200 a month), Open-Meteo, Resend (email, sent only when its key is set). Key names are in `.env.example`; values live in `.env` (local) and Wrangler secrets (deployed), never in git.

## Current Build Status (as of 2026-11-28)
- **Live:** LiveArchive 3.0 design system (ticket stubs, 5 ticket stub styles, `PosterHeading`, `PostIt`, rotating contour + dot-grid `AppBackdrop`, accent `Logo`, playful `Tabs`, sliding `Segmented`, `btn-pop`), two-stage capture and lineup lookup, ticket-email import, share page + event share cards, Manage section, Global Archive (series, brands, editions, weekends, edition weather, series sync, artist entity cleanup), shared artist genres + vocabulary + taxonomy (macros, families, relations, Lineup DNA, Event Match, orbits, Constellation), invites and member accounts, private notes vault, guarded AI reader, event fetch Stages 0–4, auto-verify.
- **In progress:** Post-3.0 design system, documentation, and landing screenshot pass (Slices 49.x).
- **Not started:** event fetch Stage 4b and Stage 5, Global Editions admin Slice 5, open tickets in [docs/engineering-ticket-bank.md](../docs/engineering-ticket-bank.md) and [docs/tier3-specs.md](../docs/tier3-specs.md), social features.
- **Specs:** index and statuses in [docs/README.md](../docs/README.md). Decisions: [DECISIONS.md](DECISIONS.md).
