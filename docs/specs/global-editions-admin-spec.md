# Global Editions as the admin version of event details (draft spec)

Status: draft for Charlie's yes. Nothing here is built or committed yet.
Source: project thread "Scope Clashfinder in Global Editions", 2026-11-17.

## Goal

Global Editions (owner-only Global Archive) works like an upgraded admin version of the member views for event details, table and summary. It reuses the member components so there is one copy of each. Shared data only: no personal fields (companions, notes, rating, price, attendance) ever appear in it.

## Decisions (Charlie, 2026-11-17)

- Clashfinder "Find lineup" appears on festival editions only. Owner only. Reviewed acts and the slug pointer are stored.
- Festival test: a series kind wins when the edition has a series. Without a series, `scale.ts` decides.
- Brands are a table. One brand per series. Brand rename and merge are supported.
- Brands can sit under an organization (Insomniac, Goldenvoice, Tomorrowland). Hierarchy: Organization → Brand → Series → Edition → Weekend/Event. Organization and brand are both optional above the series.
- Brand rename and merge, organization link changes, and undo all go through the same undoable change log as editions.
- A migration is acceptable. Charlie applies it.

## Current state (read in code, 2026-11-17)

- `event_series.brand` is free text (migration 0045). The archive filters on it and suggests existing values.
- Organizations already exist as an entity kind (`src/server/entities/types.ts`: kind `organization`; role `hosted_by` from series to organization; migration 0014). Reuse it as the organization record. Do not add a second organizations table.
- Owner ingest already runs Clashfinder by name and year, with a version picker (`CanonicalArchive.tsx`, `GET /api/manage/canonical/versions`). Confirm writes via `writeEdition` (`src/server/canon/editions.ts`).
- The archive has its own edition rows and facts panel. Member views live in `EventDetail.tsx` and `TableView.tsx`. Shared UI is in `src/components/ui/`.

## Plan (slices, each one verified before the next starts)

1. **Brand table (migration + store).** `brands` (`id`, `name`, `aliases text[]`, `organization_id` nullable referencing the entity id, timestamps). `event_series.brand_id` nullable. Migration backfills one brand per distinct case-insensitive name and keeps `brand` text during the transition. Store functions: list, rename, merge (repoint series, move the loser's name into aliases), set organization. Owner-only routes.
2. **Change log and undo for brands.** Each rename, merge and organization change is recorded with old value, new value, who and why. Undo restores links still as they were and skips rows changed since, following the Manage undo pattern.
3. **Brands tab.** A `brands` section beside Series and Editions in `CanonicalArchive.tsx`. Each row shows organization, series count and edition count. Rename and merge use the existing Manage dialogs.
4. **Clashfinder "Find lineup" action.** Owner only, festival editions with no lineup. Runs Stage 2 for that edition only, using the series slug for that year when present. Results go through the existing review and confirm path. Update `docs/architecture/08-sources.md` line 72 in the same change.
5. **Component reuse pass.** Replace the archive's edition rows, facts panel and table with the member `TableView` and summary components, with shared-only props. Inventory of the member components is needed before this slice is final.

## Do NOT build

- Automatic Clashfinder lookups on creation or in member backfill.
- Any lookup in the save path or on a member's own event.
- Member-visible Clashfinder actions or member-visible brand editing.
- Any personal field on a shared view, table or summary.
- Changes to the Clashfinder adapter, its auth, its 32 MB cap, or Stage 1 (PR #427 owns those).
- Gemini or Brave calls. Clashfinder needs neither.
- A second organizations table.
- A brand location. Brands are location-agnostic.

## Rules that bind this work

- Shared-edition changes are recorded and undoable (`AGENTS.md`).
- Shared tables hold no personal fields.
- Festival relevance comes from code (`scale.ts`), not a hardcoded list.
- Stage 2 runs only when asked for.
- Migrations are applied by Charlie. Threads write the SQL.

## Open items to check at build time

- Whether `TableView` and the summary components can take shared-only rows without a fork.
- Whether the entities backfill (migration 0014) has run in production. Brands must not depend on it.
