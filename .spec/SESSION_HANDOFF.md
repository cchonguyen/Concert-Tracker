# Session Handoff

- **Last Active Platform:** Claude Code (cloud session, project thread "Clean up outdated docs and app text")
- **Branch Owner:** Claude
- **Active Branch / State:** `claude/project-thread-47kcgx`, off main at 09d2e5f (PR #607 merged 2026-11-24). Last slice of the docs, comments and app text cleanup (Slice 9, issue #608); all other slices merged.
- **Files Modified in Last Turn:** `public/privacy.html`, `public/terms.html`, `src/components/AboutDialog.tsx`, `tests/uiText.test.ts`, `docs/README.md`, `docs/specs/docs-and-text-cleanup.md`, `.spec/OVERVIEW.md`, `.spec/SESSION_HANDOFF.md`.
- **Verification Status:** Verified via finish-slice.mjs (Slice 21.608)
- **Immediate Next Step:** merge the Slice 9 pull request when green. The cleanup is then done; nothing else is queued.
- **Open gaps:**
  - Harness: hub PR #208 (merged 2026-11-23) makes the scope check read `Approved-Tripwire:` trailers from the PR's own head commit when CI checks out GitHub's merge commit. Synced into this repo in PR #592.
  - Charlie's wording answers for the cleanup (2026-11-23) are recorded in the cleanup spec under "Decisions".
  - The event check button is now "Deep search with AI" (screens, AGENTS.md, REQUIREMENTS, architecture and the privacy page agree). Owner screens drop "canonical" and "ingest"; "Edition" and "AKA" stay. Owner screens had no screenshots: their components import server code and need a signed-in owner.
  - Left as is on purpose: deep search notes still show the reader's own quota reason (for example "Gemini daily limit reached"), the stage 2 lookup log still says "no Gemini call", and the music-story genre import still shows its terminal command.
  - Older follow-ups not rechecked in this session: code that reads a linked event's venue, date or city straight from the store (stats, export, map, email scan, import) may still skip `resolveEvent`; `.env.example` comments still give old reader limits (left because of the env-file tripwire); `SUBREQUEST_LIMIT` defaults to 50, which slows the backfills; personal-field encryption is on hold ([docs/ingest-canon-plan.md](../docs/ingest-canon-plan.md) section 4).
