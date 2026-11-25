# Session Handoff

- **Last Active Platform:** Claude Code (cloud session, project thread "Build LiveArchive 2.0 design refresh")
- **Branch Owner:** Claude owns `claude/*` branches. Gemini (Antigravity or AI Studio) works on its own `antigravity/dr2-23.N` branches.
- **Active Branch / State:** Design refresh 2.0 (`docs/specs/design-refresh-2.md`). Stage 0 merged: slices 22.1 to 22.6 (#673, #675, #677, #679, #681, #683): tokens, fonts, contrast test, ink on accent, reduced motion, and the shared Tabs, Ledger, KindPill, HintPill, Stars and Equalizer.
- **Files Modified in Last Turn:** .spec/PROGRESS.md, .spec/SESSION_HANDOFF.md, .spec/archive/HISTORY.md, docs/specs/design-refresh-2-ledger-and-lobby.md
- **Verification Status:** Verified via finish-slice.mjs (Slice 26.3)
- **Immediate Next Step:** Two tracks now run in parallel. Gemini builds the "Ledger & Lobby" package, slices 23.1 to 23.8 (issues #684 to #691, brief `docs/specs/design-refresh-2-ledger-and-lobby.md`). Claude builds Track A (Popover, top bar and page rows, Summary, event detail poster and two-column body, DetailShell motion, Stats and heatmap) on `claude/*` branches. Neither track edits the other's files (the list is in the brief).
- **Streamlining (`claude/project-thread-47kcgx`, `docs/specs/streamlining-plan.md`):** all five slices built 2026-11-24 (#636, #639, #641, #643, #649, #652, and the last tidy-up PR). Charlie signed off deleting the four one-off scripts and the two unused packages.
- **Open gaps:**
  - Harness: hub PR #208 (merged 2026-11-23) makes the scope check read `Approved-Tripwire:` trailers from the PR's own head commit when CI checks out GitHub's merge commit. Synced into this repo in PR #592.
  - Charlie's wording answers for the cleanup (2026-11-23) are recorded in the cleanup spec under "Decisions".
  - The event check button is now "Deep search with AI" (screens, AGENTS.md, REQUIREMENTS, architecture and the privacy page agree). Owner screens drop "canonical" and "ingest"; "Edition" and "AKA" stay. Owner screens had no screenshots: their components import server code and need a signed-in owner.
  - Left as is on purpose: deep search notes still show the reader's own quota reason (for example "Gemini daily limit reached"), the stage 2 lookup log still says "no Gemini call", and the music-story genre import still shows its terminal command.
  - Older follow-ups not rechecked in this session: code that reads a linked event's venue, date or city straight from the store (stats, export, map, email scan, import) may still skip `resolveEvent`; `.env.example` comments still give old reader limits (left because of the env-file tripwire); `SUBREQUEST_LIMIT` defaults to 50, which slows the backfills; personal-field encryption is on hold ([docs/ingest-canon-plan.md](../docs/ingest-canon-plan.md) section 4).
