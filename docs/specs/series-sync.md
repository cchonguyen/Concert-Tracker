# Keeping events and series in sync (auto-link and series health)

Status: proposed 2026-11-27. Charlie: "I would like to better automate this process so there's less opportunity for desync." He chose "Link automatically, undoable" for exact matches. Brands and missing series stay one-tap.

## Why things drift today

- **Events are never linked back.** The owner canon backfill (`src/server/canon/backfill.ts`, `fromEvent`) turns the owner's dated events into verified editions through `upsertOccurrence`. It never sets the event's `editionId`. The only link path is a tap on a suggestion (`POST /events/:id/details/pick`). On 2026-11-27, 299 dated events were unlinked across 5 accounts. 115 of them match exactly one verified edition by name and date. Alive, Tension Tour and the other six from the series cleanup were among them.
- **A series is made from each event name.** `place()` passes `subjectKey: seriesSlugFor(name)`, so a new series takes the event's name ("Vertigo", slug `griff`). It gets no brand or qualifier. Nothing checks a series after it is made.
- **An edition can have no series.** KCON LA 2025 came in with none, so its event (series "KCON") could not link.

## Rule 1: auto-link exact matches

An unlinked event is linked to a shared edition when all of these hold:

- The event has no `editionId`, is not deleted, and is not `missed`.
- The event has a full `YYYY-MM-DD` start date.
- Exactly one edition has status `verified` or `confirmed`, the same start date, and the same name. The name can also match the series name or one of its aliases. Names are compared with the existing normalizer.
- The venues are equal after normalization, or one side has no venue. Two different venues never link.

If no edition passes, or two or more do, nothing is linked.

**How the link is made.** It uses the same shape as the pick path:
- `ensureCaptured` runs first, so what was typed is kept as `captured`.
- `editionId` is set.
- Every field the event has where the edition holds a different value goes into `overrides`. Nothing on the event's screen changes.
- `seriesSlug` is set from `eventSeriesSlug`.
- `details.autoLinked = { editionId, at, reason }` is recorded.
- No personal field is read into a shared table. The edition is never written.

**Undo.**
- Event detail shows "Linked automatically to <edition>" with Unlink, which uses `unlinkEvent`.
- Data health lists the automatic links from the last 30 days. Each one has Unlink.
- An event that was unlinked is never auto-linked again, because `details.autoLinkDeclined` is set.

**When it runs.**
- (a) Inside the canon backfill, right after `upsertOccurrence` creates or matches the edition from that same event.
- (b) In a nightly sweep, in batches inside the subrequest budget, with a cursor in settings, like the member backfill.
- (c) When an event is saved and stage 1 finds a `same` match. That path already auto-uses a `same` match for research (`details.ts`).

## Rule 2: series health, one tap

There is a nightly read-only check, also shown on demand in Data health (owner only). It lists:

- **A series with no brand, or not built from its parts.** That means no qualifier and a name that differs from the brand. Offers, worked out in code from stored data only:
  - When every edition's lineup, together with the seen acts on events linked to it, names exactly one act, that act is offered as the brand. The old name is offered as the qualifier and alias.
  - Otherwise the series' own name is offered as its brand.
- **An edition with no series.** Offers the one series whose name or alias equals the edition name without its year. When there is none, it offers a new series named after the edition.

Each fix goes through `saveSeriesLogged` or `writeEdition` with actor `owner` and a reason. It is recorded and can be undone. Nothing is applied without a tap. This is the guess rule: who a tour belongs to is the owner's call.

## Slices

1. **Auto-link core.** New `src/server/canon/autoLink.ts` (match and link, pure plus store), the `backfill.ts` hook, the nightly sweep in `worker/index.ts`, and tests. [CORE / DATA]
2. **Undo surface.** Event detail note with Unlink, plus the "Linked automatically" list in Data health (`EventDetail.tsx`, `DataHealth.tsx`, `services/dataHealth.ts`). [UI / VISUAL]
3. **Series health.** New `src/server/entities/seriesHealth.ts` (issues and offers), owner routes, Data health section with one-tap fixes, and tests. [CORE / DATA]
4. **Members' events** (only if Charlie says yes): the sweep also walks members who accepted the current notice, through their scoped store, with the same rule. [CORE / DATA]

ARCHITECTURE.md sections 02 and 12 change with slices 1 and 3. No migration: `details` is already JSON.
