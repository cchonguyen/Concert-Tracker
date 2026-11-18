# Series type fix: tours typed as festivals

Status: draft for Charlie's confirmation (2026-11-18). No code changed yet.

## Problem

88 of 118 Global Archive series are typed `festival`; 30 are `tour` (production, read-only check, 2026-11-18). Several festival-typed series are single-artist tours or shows.

Causes (from code):

1. Migration `0046_series_kind_and_place.sql` adds `event_series.kind` with default `'festival'`, so every existing series became festival.
2. `SupabaseStore.upsertEdition` creates a missing series with `upsertSeries({ slug, name })`, and `upsertSeries` maps a missing kind to `'festival'`.
3. No classifier runs. Only a person changes a series to tour.
4. The series update route (`PATCH /api/manage/canonical/series/:slug`, `src/server/entities/routes.ts`) calls `store.upsertSeries` directly. It writes no `edition_changes` row and offers no undo. This breaks AGENTS.md ("every change to a shared edition is recorded and can be undone") and the coordinator's rule that canonical edits are logged and undoable.

## Decisions (Charlie, 2026-11-18)

- **A.** Switch the nine tour-named series to `tour`: Taylor Swift | The Eras Tour, Lady Gaga: The Chromatica Ball, The Monster Ball Tour, Tension Tour, Heaven/Hell Tour, New Evolution Global Tour, Tove Lo - Dirt Femme Tour with Special Guest Slayyyter, Blue Babu Tour, Lucky Me Tour.
- **B.** New series created from an edition get no type (`kind` NULL, shown as "Not set") until someone picks one. No default.
- **C.** Check that type changes are logged and undoable before relying on them. Result: they are not (see cause 4). Fix as part of this work.

## Plan

### Slice 1: Logged, undoable series type change (C)

- Route the series PATCH through a logged write, using the same pattern as `writeEdition` / `edition_changes` (old value, new value, actor, reason, undo).
- Files: `src/server/entities/routes.ts`, `src/server/lineup/store/types.ts`, `src/server/lineup/store/supabaseStore.ts`, `src/server/lineup/store/fileStore.ts`, new migration for the change-log table if the existing one cannot hold series rows (a migration, held until Charlie applies it).
- Tests: `tests/` for log written, undo restores old kind, tour clears place fields.

### Slice 2: Migration: allow no type (B)

- Migration `0053_series_kind_nullable.sql`: drop default `'festival'`, allow NULL, keep the check constraint. Existing rows are not changed.
- Held until Charlie applies it.
- Files: migration only. Store: `upsertSeries` writes NULL when kind is absent instead of `'festival'`.

### Slice 3: Stop the default on auto-create (B)

- `upsertEdition` creates a series with no kind.
- `scale.ts` already treats a missing series kind as "no series rule", so event typing falls back to the day, act and Clashfinder rules. Confirm with a test.
- Files: `src/server/lineup/store/supabaseStore.ts`, `src/server/lineup/store/fileStore.ts`, `tests/`.

### Slice 4: Set the nine tours (A)

- A one-time data change: set `kind = 'tour'` and clear place fields on the nine series, each through the Slice 1 logged path, with a reason ("Charlie: tour, 2026-11-18").
- Do this by the logged route or a migration with an `edition_changes`-style record. Not a silent UPDATE.
- Effect: a tour series loses the Find lineup button (festivals only, `canonicalIngest.ts`). Stated, not hidden.

### Slice 5: Show "Not set" in Manage (B)

- `CanonicalArchive.tsx` series list and detail: show "Not set" with a picker, instead of "Festival" for missing kind.
- Use `src/components/ui/Pill`. Keep the existing type dropdown.

## Out of scope

- A third type for single-artist shows (option D). Not built now.
- Changing event-level typing (`scale.ts` rules).

## Open points

- Whether a series change log table already exists for series (not confirmed; check in Slice 1).
- ARCHITECTURE.md update is required with Slice 1 and Slice 2 (behavior changes).
