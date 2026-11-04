# Project Overview (Owner's Manual)

## What This App Does
- LiveArchive helps one person remember which events they went to and who they saw there. Full purpose and principles: [REQUIREMENTS.md](../REQUIREMENTS.md). How it works: [ARCHITECTURE.md](../ARCHITECTURE.md).

## Active External Services & Keys
- Cloudflare Workers (hosting, deployed with `npm run cf:deploy`), Supabase, Gemini, MusicBrainz. Key names are in `.env.example`; values live in `.env` (local) and Wrangler secrets (deployed), never in git.

## Current Build Status (as of 2026-11-04, main at PR #246)
- **Live:** two-stage capture, lineup lookup and review, ticket-email import, theme picker (PR #51), share page, Manage section (M1a to M6), Tier 3 TECH-04 and FETCH-01 (PRs #229, #233), Global archive slices 8.1 to 8.10 (PR #246 is the last merge).
- **In progress:** none. Check [PROGRESS.md](PROGRESS.md) for the single `[IN_PROGRESS]` slice.
- **Next step:** Charlie picks the next slice from [docs/tier3-specs.md](../docs/tier3-specs.md) or the engineering ticket bank.
- **Specs:** index in [docs/README.md](../docs/README.md). Decisions: [DECISIONS.md](DECISIONS.md).
