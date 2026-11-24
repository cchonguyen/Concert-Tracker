# Session Handoff

- **Last Active Platform:** Claude Code (cloud session, project thread "Scope auto-filling venue location")
- **Branch Owner:** Claude
- **Active Branch / State:** `claude/project-thread-ipjor1`. Venue location fill: all 7 slices merged (#619 to #633). Members share the state (notice version 3): PR #637.
- **Files Modified in Last Turn:** NoticeModal.tsx, auth/routes.ts, events/details.ts, canon/memberBackfill.ts, AGENTS.md, REQUIREMENTS.md, docs/architecture 02 and 12, member tests.
- **Verification Status:** Verified via finish-slice.mjs (Slice 21.654)
- **Immediate Next Step:** None for venue fill once #637 merges. Members accept the notice again on next sign-in.
- **Streamlining (`claude/project-thread-47kcgx`, `docs/specs/streamlining-plan.md`):** slice 1 merged (#636), slice 2 auto-verify wired into the lookup (#639). Next: slice 3, one Clashfinder list download shared by both stages, then shared Ticketmaster, setlist.fm and Brave clients.
- **Open gaps:**
  - Harness: hub PR #208 (merged 2026-11-23) makes the scope check read `Approved-Tripwire:` trailers from the PR's own head commit when CI checks out GitHub's merge commit. Synced into this repo in PR #592.
  - Charlie's wording answers for the cleanup (2026-11-23) are recorded in the cleanup spec under "Decisions".
  - The event check button is now "Deep search with AI" (screens, AGENTS.md, REQUIREMENTS, architecture and the privacy page agree). Owner screens drop "canonical" and "ingest"; "Edition" and "AKA" stay. Owner screens had no screenshots: their components import server code and need a signed-in owner.
  - Left as is on purpose: deep search notes still show the reader's own quota reason (for example "Gemini daily limit reached"), the stage 2 lookup log still says "no Gemini call", and the music-story genre import still shows its terminal command.
  - Older follow-ups not rechecked in this session: code that reads a linked event's venue, date or city straight from the store (stats, export, map, email scan, import) may still skip `resolveEvent`; `.env.example` comments still give old reader limits (left because of the env-file tripwire); `SUBREQUEST_LIMIT` defaults to 50, which slows the backfills; personal-field encryption is on hold ([docs/ingest-canon-plan.md](../docs/ingest-canon-plan.md) section 4).
