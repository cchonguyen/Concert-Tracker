# Docs, comments and app text cleanup

Status: scope approved by Charlie 2026-11-23 ("Yes move to archive. Plain words as well."). Building one slice at a time. Wording choices are in "Decisions" below.

## Goal

Make every doc say what is true today, file away finished or replaced specs, remove code comments that point at old work, and make every label, tooltip, placeholder, help line and empty state plain and clear. No behaviour changes.

## Decisions

- Finished or replaced specs move to `docs/archive/` with a one-line status at the top. They are not deleted. A spec that a rule in AGENTS.md or ARCHITECTURE.md links to stays where it is, so the link holds.
- Plain words on every screen, owner screens included.
- Ideas that were never started stay in `docs/` with a "Not started" status line.
- Code comments drop slice numbers. A date stays when it explains why a rule exists.
- Wording answers from Charlie, 2026-11-23:
  - The app's name stays "LiveArchive" (no s).
  - Keep the word "Edition". Drop "Canonical" where a person reads it.
  - Keep the status words Verified, Provisional, Draft and Candidate: one word each, and distinct.
  - No AI brand name on buttons. "Look again with Gemini" and the like become wording such as "Deep search with AI" that says the search goes deeper. AGENTS.md names that button, so its wording changes in the AGENTS.md pull request.
  - Tooltips are one sentence about what pressing does.
  - Before and after screenshots on the three screen slices (6, 7, 8).

## Out of scope

- Migrations, `.env.example` (tripwire), engine files (`.claude/`, `.harness/`, `.harness-version`).
- Code internals: identifiers, database values and API field names keep their names. Only text a person reads changes.
- AGENTS.md changes go in their own pull request and fix status words only, never a rule.

## Slices

1. Docs index and spec status lines: true status on every spec, finished or replaced specs moved to `docs/archive/`, `docs/specs/` added to the index, the broken link fixed, built tickets moved out of the open ticket bank. `[CORE / DATA]` (docs link tests).
2. Harness state files: `.spec/SESSION_HANDOFF.md`, `.spec/OVERVIEW.md`, `.spec/PROGRESS.md` empty headings, `.spec/CANON_REVIEW_SCOPE.md`, `.spec/SYSTEM_SPEC.md` brought to today.
3. Architecture sections 01 to 12 checked against the code.
4. Architecture sections 13 to 24, REQUIREMENTS.md and README.md checked against the code.
5. Code comments: drop slice numbers, fix comments that no longer match the code.
6. Member screens, part one: event detail, capture, Fill gaps, Check details, lineup review. `[UI / VISUAL]`
7. Member screens, part two: table, stats, timeline, map, account, share, import, sample mode. `[UI / VISUAL]`
8. Owner screens: Manage, Global Archive, Members, admin inbox, data health, reader and finder panels. `[UI / VISUAL]`
9. Public pages: home, privacy, terms, About box. `[UI / VISUAL]`
10. AGENTS.md status words (separate pull request).

Each slice passes `npm run lint` and `npm test` and merges when green. Tests that assert on changed text are updated in the same slice.
