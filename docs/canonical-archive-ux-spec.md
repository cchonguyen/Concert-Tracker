# Global Archive UX spec (second pass)

Status: proposed 2026-11-03, agreed in principle by Charlie. Each slice is built and verified (lint, tests, typecheck) before the next one starts.
Base: `docs/global-archive-rework-spec.md` (GA1–GA4, built). AGENTS.md rules apply unchanged.

## Problem

- Artist rename, AKA edits and merge save at once, with no preview. Only edition facts and Edit lineup show old → new before saving.
- A merge shows a paragraph of effects, not counts (editions moved, your own records changed).
- Undo for a catalog change is a line that vanishes when the section changes. History is hidden in archive scope, and the shared History list holds only the last 50 entries.
- Editions load the newest 200 with no notice when there are more.
- Two navigation layers (scope switch plus a second menu). Archive screens use raw classes instead of `src/components/ui/`.
- `ARCHITECTURE.md` says edition facts are "not built" in the same paragraph that describes them as built.

## Decisions (agreed)

- Preview before every catalog write, not only merges.
- Catalog changes get a "Changes" section inside archive scope, with Undo. The shared History is unchanged.
- The scope switch moves into the page header as tabs (My records | Global archive). Archive has one section menu, not two layers.
- Owner only. No member-visible archive, no member names, no edits to members' `logged_events`. No delete. No new migration unless a slice proves it needs one.

## Slice UX1: Consistency [UI / VISUAL, Level 1]

- Artist rename, AKA add and remove, and merge show the old → new list (same pattern as `EditionFactsForm`) and save only on a second press, through the same request.
- Use `Confirm`, `Callout`, `SaveStatus` and `Button` from `src/components/ui/` in archive screens. Keep each section in its own file.
- Editions with more than 200 rows: show "Showing 200 of N. Narrow the search to see the rest." (N from the store count.)
- Fix the contradiction in `ARCHITECTURE.md` (edition facts are built; say what is not).
- Tests: rename, AKA and merge without a second press write nothing; the preview matches the saved change; truncation notice shows.
- Target files: `src/components/CanonicalArchive.tsx` (split), `src/components/CanonicalArtistEntry.tsx`, `src/components/ManageView.tsx`, `src/server/entities/routes.ts`, `ARCHITECTURE.md`, `tests/canonicalRoutes.test.ts`.

## Slice UX2: Impact before you save [CORE / DATA, Level 2]

- Server: a preview for rename, AKA, and merge that returns counts only: editions affected, performances moved, your own records that would change, and member-linked acts that would now match differently. Never names.
- Route: `POST /api/manage/canonical/artists/:key/preview` (owner only), same body as the write. Writes nothing.
- UI: the preview lists those counts above the Save button. The save sends the same request the preview described; a change since the preview asks for a new preview (as editions do).
- Tests: counts are correct on fixtures; owner only; preview writes nothing to `entity_history`, `logged_events` or `canonical_artists`.
- Target files: `src/server/entities/canonicalManage.ts`, `src/server/entities/routes.ts`, `src/services/lineupApi.ts`, `src/components/CanonicalArtistEntry.tsx`, `tests/canonicalManage.test.ts`.

## Slice UX3: Changes and header tabs [UI / VISUAL + CORE / DATA, Level 3]

- Server: `GET /api/manage/canonical/changes` (owner only) returns catalog history entries only (those with a `canonical` manifest), newest first, with a limit separate from the shared 50. Add a store filter or method; do not change `listEntityHistory`.
- Each entry shows its summary, time, a before/after line, and Undo when it is not undone. Undo uses the existing `POST /api/entities/history/:id/undo`, then refreshes the list. Undone entries show struck through, as in History.
- UI: the scope switch becomes header tabs. Archive sections are Artists, Editions & Lineups, Lookups, Changes. The second menu for archive is removed.
- Check first: whether `entity_history` stores the `canonical` manifest in a column or in JSON. No migration is expected; if one is needed, stop and ask.
- Tests: list shows only canonical entries; undone entries are struck through; undo from the Changes list restores the prior state and refreshes; members get 403.
- Target files: `src/server/lineup/store/types.ts`, `src/server/lineup/store/fileStore.ts`, `src/server/lineup/store/supabaseStore.ts`, `src/server/entities/routes.ts`, `src/components/ManageView.tsx`, `src/components/CanonicalArchive.tsx`, `tests/canonicalManage.test.ts`, `ARCHITECTURE.md`.

## Do not build

- No member-visible archive, member names, or edits to members' logs.
- No deletes; no demote-to-draft.
- No change to the shared History list or its 50-entry limit.
- No new migration without asking first.
