# Project Overview (Owner's Manual)

## What This App Does
- LiveArchive helps one person remember which events they went to and who they saw there. Full purpose and principles: [REQUIREMENTS.md](../REQUIREMENTS.md). How it works: [ARCHITECTURE.md](../ARCHITECTURE.md).

## Active External Services & Keys
- Cloudflare Workers (hosting, deployed with `npx wrangler deploy`), Supabase, Gemini, MusicBrainz. Key names are in `.env.example`; values live in `.env` (local) and Wrangler secrets (deployed), never in git.

## Current Build Status
- **Live & Verified:** Two-stage capture, lineup lookup and review, ticket-email import and merge (see git history up to PR #46).
- **In Progress:** None
- **Up Next:** Manage section, triaged 2026-10-28. A new Manage tab where each artist, person, venue, place, series and organization is one record with a permanent ID, so renaming or merging it once fixes every event. A venue's city, state and country flow to its events automatically. Google Sheets and CSV become copies written from the app, which stays the only source of truth. Scope and what not to build: [SYSTEM_SPEC.md](SYSTEM_SPEC.md). Full design: [designs/manage-section.md](designs/manage-section.md). Next: `/spec` to cut it into slices.
