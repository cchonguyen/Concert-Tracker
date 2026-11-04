# Global Archive UX spec (second pass)

Status: proposed 2026-11-03; revised 2026-11-04 after cross-vendor review. Charlie agreed with the direction and UX choices. The slice order follows dependencies; level estimates describe complexity, not build order. Each slice is built and verified (lint, tests, typecheck) before the next one starts.
Base: `docs/global-archive-rework-spec.md` (GA1–GA4, built). AGENTS.md rules apply unchanged.

## Problem

- Artist rename, AKA edits and merge save at once, with no preview. Edition facts and Edit lineup already show old → new before saving.
- A merge explains effects in prose but does not show counts (editions/performance rows affected, or the owner's record).
- Undo for a catalog change is a line that vanishes when the section changes. History is hidden in archive scope, and the shared History list holds only the last 50 entries.
- Editions load the newest 200 without saying when the catalog has more; the current search filters only those loaded editions.
- Two navigation layers (scope switch plus a second menu). Archive screens use raw classes instead of `src/components/ui/`.
- The edition-facts paragraph in `ARCHITECTURE.md` needs reconciliation: code has an Edit facts form and route, while the paragraph also says editing facts is not built and describes migration 0034 as not applied by the repo. Confirm the intended migration/deployment statement and make the paragraph internally accurate; do not copy the discrepancy into this spec as an established implementation fact.

## Decisions (agreed)

- Preview before every catalog write, not only merges.
- Catalog changes get a "Changes" section inside archive scope, with Undo. The shared History is unchanged.
- The scope switch moves into the page header as tabs (My records | Global archive). Archive has one section menu, not two layers.
- The archive and catalog writes are owner-only. No member names or member-specific records are returned or changed. Aggregate counts may be shown only when they are supported by an efficient, well-defined server query.
- No deletes. On 2026-11-04, Charlie approved one additive SQL migration that creates an owner-checked atomic RPC function for canonical apply/undo; it may add no tables or columns. Any migration or schema change beyond that function requires approval.

## Slice UX1: Preview contract and server counts [CORE / API, Level 2]

Build the read-only server contracts before the UI consumes them.

- Artist preview route: `POST /api/manage/canonical/artists/:key/preview` (owner-only). Body is a discriminated union:
  - `{ op: 'rename', name: string }`
  - `{ op: 'alias-add', name: string }`
  - `{ op: 'alias-remove', name: string }`
  - `{ op: 'merge', into: string }`
- Preview returns only the operation, aggregate impact counts, and an opaque `previewFingerprint`. It writes nothing to `entity_history`, `logged_events`, `canonical_artists`, artist aliases, performances, or the owner's entity tables. It returns no names, IDs, personal details, or member-specific rows.
- The preview and apply paths use one shared planner over a read-only snapshot, including a read-only plan for any owner entity/event changes currently performed through `renameEntity` or `mergeEntity` in `manage.ts`. The planner describes the proposed before/after state and impact counts; only the apply path executes its recomputed plan. Do not maintain separate preview and mutation calculations. The planner must not call mutating entity operations while constructing a preview.
- Count semantics:
  - `editionsAffected`: distinct editions with at least one performance row changed by the proposed operation.
  - `performancesMoved`: existing performance rows whose artist key changes; for merge collisions, count the collapsed source row as affected and do not count the retained target row as moved.
  - `ownerRecordsAffected`: the number of the owner's artist entity records that the operation changes (0, 1, or 2); do not include details.
  - `communityNameKeysAffected`: number of distinct normalized keys in the existing aggregate community-count map whose canonical resolution changes under the proposed artist/alias state. Return null when that aggregate is unavailable; the UI says "Not available," never zero. Do not return key values, member counts, names, or records. This is an aggregate name-match count, not a count of people or event rows.
- Apply route: `POST /api/manage/canonical/artists/:key/apply`, with the same `op` and operation fields plus `previewFingerprint`. Recompute the plan on the server; never accept a client-supplied plan. A mismatching fingerprint returns 409 with a clear "Preview is out of date; review it again" response and performs no writes. The Global Archive uses this route for rename, alias add/remove, and merge; any retained legacy write route must enforce equivalent preview validation or be removed from use.
- The fingerprint covers all state the plan relies on or changes: source and target artists, relevant performances and aliases, and the owner's affected artist records. The aggregate community-count keys are informational; recompute their count when applying and report the applied count, but do not reject a write solely because member activity changed after preview.
- Store operation: implement the approved function-only migration as an owner-checked Postgres RPC. The RPC validates the fingerprint against current canonical/owner state and applies the supplied server-built plan, owner record changes, and canonical history in one database transaction; it must not accept a client-built plan. It also handles canonical Undo atomically, checking the current after-state before restoring the before-state and updating owner history. Authenticate authenticated callers against `members.user_id`/`members.role = 'owner'`; allow `service_role` only for trusted server-side calls. Use a fixed `search_path`, revoke public/anon execution, and make no table or column changes. The FileStore must provide equivalent serialized apply/undo behavior.
- A failed transaction commits no catalog, owner-record, or history changes and must not appear in Changes as a successful, Undo-enabled operation. If the function-only migration cannot safely cover all tables used by the current owner and single-user store modes, stop and bring back the exact blocker; do not add tables/columns or another migration under this approval.
- The editions endpoint returns at most 200 summaries plus `total` for the current status/search filters and a `hasMore` indicator. Apply the existing search fields (edition name, series slug, venue) and status filter across the catalog before the 200-row limit, so a search can find an older edition. Preserve the current displayed order (year descending, name ascending) across the full filtered set before limiting. Show "Showing 200 of N" when more matching results exist; otherwise show the returned count. Do not imply that searching the first 200 can find older editions.
- Tests: each preview operation returns correct fixture counts and writes nothing; stale fingerprints are rejected without mutation; owner-only preview/apply; merge collision count semantics; apply and Undo are atomic for both stores; failed RPC commits no partial writes; filtered edition count and a matching edition older than the newest 200; exact 200/201 boundary.
- Target files: `supabase/migrations/0035_canonical_artist_atomic_changes.sql` [NEW], `src/server/entities/canonicalManage.ts`, `src/server/entities/manage.ts`, `src/server/entities/routes.ts`, `src/server/lineup/store/types.ts`, `src/server/lineup/store/fileStore.ts`, `src/server/lineup/store/supabaseStore.ts`, `src/services/lineupApi.ts`, `tests/canonicalManage.test.ts`, `tests/manage.test.ts`, `tests/canonicalRoutes.test.ts`, and focused new migration/store tests.

## Slice UX2: Consistent preview experience [UI / VISUAL, Level 1]

Depends on UX1's preview/apply and edition-count contracts.

- Artist rename, AKA add/remove, and merge show the same old → new pattern as `EditionFactsForm`; the first press requests a server preview and the second applies exactly that intent with its fingerprint. A stale preview is rejected and the UI asks for a fresh preview. Preview counts appear immediately above the apply action.
- Use the shared preview/inline-save pattern and `Callout`, `SaveStatus`, and `Button` from `src/components/ui/`. Do not use `Confirm` for these reversible operations: its contract is for actions that cannot be undone. No component split is required for this slice; if a split becomes necessary, assign its exact files in a revised target list before coding.
- Editions show "Showing 200 of N" when the filtered result has more than 200 matches, with search across the full catalog as specified in UX1.
- Reconcile the edition-facts paragraph in `ARCHITECTURE.md`: describe the implemented form and route, state migration 0034's checked-in/deployment status accurately, and remove any stale claim that conflicts with verified behavior. Do not change the documented deployment status based on code inspection alone.
- Tests/manual checks: rename, AKA and merge make no write before the apply press; the preview matches the saved operation; out-of-date previews show the refresh path; impact counts are visible; truncation and filtered search notices are correct; keyboard and narrow-screen layout preserve access to the preview and apply controls.
- Target files: `src/components/CanonicalArchive.tsx`, `src/components/CanonicalArtistEntry.tsx`, `src/components/ManageView.tsx`, `ARCHITECTURE.md`, and relevant component/API tests. Reuse existing `src/components/ui/Button.tsx`, `Callout.tsx`, and `SaveStatus.tsx`; do not edit them unless a concrete gap is found.

## Slice UX3: Changes and header tabs [UI / VISUAL + CORE / DATA, Level 3]

- Server: `GET /api/manage/canonical/changes` (owner-only) returns only canonical history operations, newest first. The `canonical` payload is inside the `manifest` JSON; the operation is also stored in the `operation` column. Add a store method that filters by canonical operation in the database/query before applying the page limit. The file store applies the same filter before limiting. Do not change `listEntityHistory` or the shared History list.
- Pagination: use a stable keyset cursor ordered by `(created_at DESC, id DESC)`, with a page size of 50 and an opaque `nextCursor` (null when complete). Return `hasMore` or an equivalent unambiguous continuation signal; the UI offers "Load more" and does not silently drop older changes. Do not expose the history manifest or member details in the list response.
- No migration is expected for the canonical filter or pagination: `operation` and `undone_at` are real columns, and the canonical payload is in `manifest`. Confirm the actual schema contract in the implementation. If the filter cannot be performed before the limit or the schema differs, stop and ask before adding a migration.
- Each entry shows its summary, time, a before/after line, and Undo while it is available. Entries already undone are struck through. Undo uses `POST /api/entities/history/:id/undo`; a success refreshes the row/list. On a 409, keep the entry unchanged, show the server's refusal reason ("Those records changed after this. Undo the later change first."), and do not imply it was undone. Link to the later change only when the server can identify that entry reliably. The summary makes clear when undo also restores the owner's associated record.
- Do not put an unconditional owner-only gate on the shared undo route: members can undo their own ordinary Manage changes. Canonical undo must reject non-owners with 403 before any mutation. Test this branch directly as well as preview/changes authorization; do not infer authorization from the UI.
- If a canonical history entry records a write that did not complete, it must not be presented as a successful, Undo-enabled change. Verify the failure-recovery/atomicity contract from UX1 applies to the Changes feed.
- UI: the scope switch becomes header tabs. Archive sections are Artists, Editions & Lineups, Lookups, Changes. Remove the second menu for archive. Tabs remain usable on narrow screens (scrollable tab row with visible focus and selected state).
- Tests: only canonical operations are returned; filtering precedes the limit; stable pagination has no duplicates or gaps with tied timestamps; undone entries are struck through; successful undo refreshes and restores prior state; 409 refusal leaves the entry active and explains why; owner-only preview/changes/canonical undo return 403 for members; ordinary member Manage undo remains available; incomplete writes are not presented as successful changes.
- Target files: `src/server/lineup/store/types.ts`, `src/server/lineup/store/fileStore.ts`, `src/server/lineup/store/supabaseStore.ts`, `src/server/entities/routes.ts`, `src/components/ManageView.tsx`, `src/components/CanonicalArchive.tsx`, `tests/canonicalManage.test.ts`, `tests/canonicalRoutes.test.ts`, `ARCHITECTURE.md`.

## Do not build

- No member-visible archive, member names, or edits to members' `logged_events` or seen text.
- No deletes; no demote-to-draft.
- No change to the shared History list or its 50-entry limit.
- No new migration without asking first.
