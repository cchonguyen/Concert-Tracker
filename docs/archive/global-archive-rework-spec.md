# Global Archive rework spec

> **Archived 2026-11-23.** Built as Slices 8.1 to 8.10.

Status: approved by Charlie 2026-11-03. Build one slice at a time; do not start a slice until the previous one is verified (lint, tests, typecheck).
Base: the original canonical-curation draft (Manage scope switcher, section menu with Editions & Lineups, shared record views) and `/mnt/project-files/canonical-curation/review.md` decisions. AGENTS.md rules apply unchanged.

## Problem

- Ingest shows nothing after submit: no queue, no progress. Job status lives only in `CanonicalArchive` component state, so leaving the panel loses it, and nothing lists catalog lookups.
- Global archive is a separate panel (`src/components/CanonicalArchive.tsx`) rendered under My records' section menu, search and filters, which do not apply to it.
- Catalog artists and editions cannot be edited, and their detail views are much thinner than `ManageEntry`.

## Decisions carried over

- Owner only. Members never see the archive (`isOwner`, 403 on routes).
- Catalog writes go to `canonical_artists`, `artist_aliases`, `event_editions`, `performances`; never to any member's `logged_events` or `seen` text.
- Admin curation is a source (`user` source type, extractor `admin_curation`, optional weblink).
- Community counts only, never member names (`canonical_community_counts()`, migration 0033).
- Re-confirming an edition merges, with a diff shown first. Only confirmed editions feed member suggestions.
- Quota errors park the job; no fallback.

## Slice GA1: Visible ingest queue [CORE / DATA]

- Server: `GET /api/manage/canonical/lookups` (owner only) returns recent jobs with no `eventId`, newest first, with status and error. Add a store method or filter `listJobs`.
- Diagnose the silent submit: confirm the ingest request reaches `POST /api/manage/canonical/ingest` (router mount path in `src/server/lineup/routes.ts` vs client path in `src/services/lineupApi.ts`), and that any error is shown. Fix the cause.
- UI: a "Lookups" list at the top of the archive: name, year, status in words (queued, fetching, waiting for quota, ready to review, no lineup found, failed), with Review (opens `LineupReview` mode canonical) and Retry (`POST /api/lookups/:id/run`). Polls while any job is active. Submit shows the new job at once.
- Tests: route is owner only; only event-less jobs are listed; ingest error surfaces.
- Target files: `src/server/lineup/routes.ts`, `src/server/lineup/store/*` (if a method is needed), `src/services/lineupApi.ts`, `src/components/CanonicalArchive.tsx`, `tests/canonicalRoutes.test.ts`, `ARCHITECTURE.md`.

## Slice GA2: One shared Manage layout [UI / VISUAL]

- The scope switch (My records | Global archive) sits above the section menu and changes what the menu, search and filters act on.
- Archive sections: Artists, Editions & Lineups, Lookups. Sections with no catalog meaning (Venues, Places, People, Series labels, Data health, History for personal records) are hidden in archive scope, not shown inert.
- The search box filters the active archive section. Filters that do not apply are hidden.
- Retire the stacked panel layout of `CanonicalArchive` in favor of section bodies rendered by `ManageView`.
- Target files: `src/components/ManageView.tsx`, `src/components/CanonicalArchive.tsx` (split into section components if cleaner), shared UI from `src/components/ui/`.

## Slice GA3: Catalog artists as records [CORE / DATA]

- Artist list rows and detail match `ManageEntry` design: name, AKAs, MusicBrainz ID, origin badges, editions billed, community count, appearances.
- Edits: rename, merge, add and remove AKA, each writing a manifest so Undo works, mirroring `src/server/entities/manage.ts` (reuse its helpers; do not fork them). A rename keeps the old name as an AKA. Merge chooses the target's MBID, else the source's; aliases and edition links move to the target.
- Members' `seen` text is never rewritten. The owner's own records follow only through existing `user_entities` operations when the owner also has that artist.
- Routes (owner only): `PATCH /api/manage/canonical/artists/:key`, `POST /api/manage/canonical/artists/:key/merge`, `POST/DELETE /api/manage/canonical/artists/:key/aliases`, undo through history.
- Tests: rename, merge, alias, undo, owner only, no `logged_events` writes.
- Target files: `src/server/entities/canonicalManage.ts`, `src/server/entities/routes.ts`, store methods for canonical artists, `src/services/lineupApi.ts`, `src/components/ManageEntry.tsx` or a sibling `CanonicalArtistEntry.tsx`, `tests/canonicalManage.test.ts`, `ARCHITECTURE.md`.

## Slice GA4: Editions as records [CORE / DATA]

- Edition detail: series, year, dates, venue, city, status, sources with links, acts with billing role, stage, day, set times, B2B, each with its quote or "admin curated" badge. Missing data says so.
- Edit: "Edit lineup" reopens `LineupReview` in canonical mode from the saved edition; confirming shows the merge diff before saving (existing confirm preview). Edition facts (name, dates, venue) editable with a source note; blanks stay blank.
- Delete or demote to draft is out of scope.
- Tests: reopen and reconfirm keeps stored acts, diff shown, facts need source note.
- Target files: `src/components/CanonicalArchive.tsx` (or `CanonicalEditionEntry.tsx`), `src/components/LineupReview.tsx`, `src/server/lineup/canonicalIngest.ts`, `src/server/entities/routes.ts`, `tests/canonicalConfirm.test.ts`, `ARCHITECTURE.md`.

## Do not build

- No new migration unless a slice proves it needs one (next free is 0034).
- No member-visible archive, no member names, no edits to members' logs.
- No hardcoded festival or artist lists.
