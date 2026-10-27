# Project Overview (Owner's Manual)

## What This App Does
- LiveArchive helps one person remember which events they went to and who they saw there. Full purpose and principles: [REQUIREMENTS.md](../REQUIREMENTS.md). How it works: [ARCHITECTURE.md](../ARCHITECTURE.md).

## Active External Services & Keys
- Cloudflare Workers (hosting, deployed with `npx wrangler deploy`), Supabase, Gemini, MusicBrainz. Key names are in `.env.example`; values live in `.env` (local) and Wrangler secrets (deployed), never in git.

## Current Build Status
- **Live & Verified:** Two-stage capture, lineup lookup and review, ticket-email import and merge (see git history up to PR #46).
- **In Progress:** None
- **Up Next:** Theme picker, triaged 2026-10-27 (scope in `.spec/SYSTEM_SPEC.md`). Waiting on Charlie's choice: accent colors only, or a light mode too.
