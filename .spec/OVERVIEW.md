# Project Overview (Owner's Manual)

## What This App Does
- LiveArchive helps one person remember which events they went to and who they saw there. Full purpose and principles: [REQUIREMENTS.md](../REQUIREMENTS.md). How it works: [ARCHITECTURE.md](../ARCHITECTURE.md).

## Active External Services & Keys
- Cloudflare Workers (hosting, deployed with `npx wrangler deploy`), Supabase, Gemini, MusicBrainz. Key names are in `.env.example`; values live in `.env` (local) and Wrangler secrets (deployed), never in git.

## Current Build Status
- **Live & Verified:** Two-stage capture, lineup lookup and review, ticket-email import and merge (see git history up to PR #46). Theme picker: Dark, Light or Match system and five accents, saved per device (PR #51).
- **In Progress:** None
- **Manage section:** slices M1a to M6 are marked done in [PROGRESS.md](PROGRESS.md). Design: [../docs/manage-section-design.md](../docs/manage-section-design.md). Next step is not set; pick it with `/triage`.
