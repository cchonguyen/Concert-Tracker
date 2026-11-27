# Keeping events and series in sync (auto-link and series health)

Status: approved 2026-11-27 (Charlie chose "Everyone's, start building": slices 1 to 4). Slice 1 built 2026-11-27. Charlie: "I would like to better automate this process so there's less opportunity for desync." He chose "Link automatically, undoable" for exact matches. Brands and missing series stay one-tap.

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

**When it runs.** Hourly, at minute 2, from the Worker cron (`runAutoLink`, `src/server/canon/autoLink.ts`). The run covers the owner and every member who isn't blocked, each through their own scoped store. It reads the verified edition headers and the shared series once per run. Per member it costs one `listEvents` and, when something links, one `putEvents`. At most 50 links per member per run. An event saved or made into an edition is linked within the hour. A hook inside the backfill or the save path was left out, because the hourly run covers both and keeps one code path.

## Rule 1b: a linked event contributes back

Charlie, 2026-11-27: "I want to avoid splitting canonical information between 'mine' and 'theirs'. If we're both entering in information and information lines up, it should be added to shared editions whenever possible."

Once per linked event, whether it was linked automatically or by a tap, the hourly run does two things (`contributeBack`, `src/server/canon/autoLink.ts`):

- Each act the person ticked under Who I Saw joins the edition's lineup as a candidate, sourced "your entry" (`recordWhoISawTicks`). Ticks never verify an act, which is the existing rule.
- The owner's own event fills only the edition's empty venue, city, state, country and end date, through `writeEdition` with actor `system:auto-link` and a reason. These are the same facts the owner backfill already trusts. A member's typed facts never fill a verified edition. They reach shared editions only through their own provisional entry.

`details.contributedAt` marks the event as done. Unlinking clears it, so a later link contributes again. No personal field is read.

## Rule 2: series health, one tap

There is a nightly read-only check, also shown on demand in Data health (owner only). It lists:

- **A series with no brand, or not built from its parts.** That means no qualifier and a name that differs from the brand. Offers, worked out in code from stored data only:
  - When every edition's lineup, together with the seen acts on events linked to it, names exactly one act, that act is offered as the brand. The old name is offered as the qualifier and alias.
  - Otherwise the series' own name is offered as its brand.
- **An edition with no series.** Offers the one series whose name or alias equals the edition name without its year. When there is none, it offers a new series named after the edition.

Each fix goes through `saveSeriesLogged` or `writeEdition` with actor `owner` and a reason. It is recorded and can be undone. Nothing is applied without a tap. This is the guess rule: who a tour belongs to is the owner's call.

## Slices

1. **Auto-link core.** New `src/server/canon/autoLink.ts` (match and link, pure plus store), the `backfill.ts` hook, the nightly sweep in `worker/index.ts`, and tests. [CORE / DATA]
2. **Contribute back** (Rule 1b). Built 2026-11-27. [CORE / DATA]
3. **Undo surface.** Event detail note with Unlink, plus the "Linked automatically" list in Data health (`EventDetail.tsx`, `DataHealth.tsx`, `services/dataHealth.ts`). [UI / VISUAL]
4. **Series health.** New `src/server/entities/seriesHealth.ts` (issues and offers), owner routes, Data health section with one-tap fixes, and tests. [CORE / DATA]
5. **Members' events.** Folded into slice 1 (Charlie chose everyone's): the run walks every member who isn't blocked. [CORE / DATA]

ARCHITECTURE.md sections 02 and 12 change with slices 1 and 3. No migration: `details` is already JSON.
