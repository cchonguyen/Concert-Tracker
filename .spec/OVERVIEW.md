# Project Overview (Owner's Manual)

## What This App Does
- LiveArchive helps people remember which events they went to and who they saw there. Full purpose and principles: [REQUIREMENTS.md](../REQUIREMENTS.md). How it works: [ARCHITECTURE.md](../ARCHITECTURE.md).

## Active External Services & Keys
- Cloudflare Workers (hosting at concert.charliechonguyen.com, deployed with `npm run cf:deploy`), Cloudflare Access, Supabase, Gemini (paid key, model `gemini-3.5-flash-lite`), MusicBrainz, setlist.fm, Ticketmaster, Clashfinder, Brave Search (capped at 200 a month), Open-Meteo, Resend (email, sent only when its key is set). Key names are in `.env.example`; values live in `.env` (local) and Wrangler secrets (deployed), never in git.

## Current Build Status (as of 2026-11-23, main at PR #592)
- **Live:** two-stage capture and lineup lookup, ticket-email import, share page, Manage section, the shared catalog (Global Archive with series, brands, editions, weekends and edition weather), invites and member accounts, the guarded AI reader with its call log and spend guards, event fetch Stages 0 to 4 (setlist.fm by city, batch research, web results), auto-verify of acts and editions, the series type fix, and the DB and logs improvement pass (PRs #587, #589).
- **Done 2026-11-24:** the docs, comments and app text cleanup ([docs/specs/docs-and-text-cleanup.md](../docs/specs/docs-and-text-cleanup.md)). The event check button is now "Deep search with AI".
- **In progress:** nothing.
- **Not started:** event fetch Stage 4b and Stage 5, Global Editions admin Slice 5, the open tickets in [docs/engineering-ticket-bank.md](../docs/engineering-ticket-bank.md) and [docs/tier3-specs.md](../docs/tier3-specs.md), social features.
- **Specs:** index and statuses in [docs/README.md](../docs/README.md). Decisions: [DECISIONS.md](DECISIONS.md).
