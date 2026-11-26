# Series cleanup: one list, one naming rule, words stored once

Status: proposed 2026-11-26, waiting on Charlie's approval. Triage: `/mnt/project-files/series-cleanup/triage.md`. The full data cleanup list: `/mnt/project-files/series-cleanup/cleanup-list.md` (kept outside the repo because it names one member's own records).

## Charlie's decisions (2026-11-26)

1. A one-night show can be a tour stop, and tours have series. One-night shows keep their series.
2. An event shows the shared series name.
3. One series per city, grouped under the brand. Brand, series and edition should not repeat the same words: each level holds only what sets it apart.
4. The cleanup list is approved in one go, not item by item.

## Problem (from the triage)

- Three unconnected stores: `logged_events.series` (free text), `user_entities` kind `series` (Manage records), `event_series` (shared).
- The event Series field autosaves after 500 ms (`SAVE_DELAY_MS`, `EventDetail.tsx`), and every save resolves a record (`entities/link.ts`), so half-typed names became records. Unused records are never removed.
- Provisional editions (`canon/match.ts`) and lineup confirms set `seriesSlug = seriesSlugFor(name)`, and `upsertEdition` creates the series when missing, named from the raw ticket title. The slug is fixed from the first title, so a differently worded title makes a new series.
- `seriesOffers` and `withPlace` (`services/series.ts`) suggest only the member's own names plus the town, never the shared list.
- Brand, series and edition each repeat the full name ("Dreamstate" / "Dreamstate SoCal" / "2024 Dreamstate SoCal").

## Model: each level stores only its own words

| Level | Stores | Example |
|---|---|---|
| Brand (`brands`) | The family name: a festival brand, or the artist for an artist's own shows | Dreamstate; Andrew Bayer |
| Series (`event_series`) | `qualifier`: what sets it apart inside the brand. Festival: a place. Tour: the tour name. Empty when the brand alone names it | SoCal; Duality Tour |
| Edition (`event_editions`) | Date, venue, city, and an optional `subtitle` for a night with its own name | 2024-11-22, Long Beach; "1000" |

Shown names are built in code, never typed twice:
- Series name = brand + qualifier ("Dreamstate SoCal"; "Andrew Bayer: Duality Tour" for a tour; "Andrew Bayer" with no qualifier).
- Edition title = series name + year for a festival ("Dreamstate SoCal 2024"), series name for a tour stop, plus the subtitle when set, plus " · Weekend N" as today.
- The stored `name` columns stay: the edition name is the captured ticket title, still read by stage 2 and matching; the series `name` is kept equal to the built name on every save, so existing readers keep working.

Naming rule (checked in code when a series is saved):
- Festival qualifier: a place word the festival uses in its own edition names (SoCal, PNW, Las Vegas). When they have none, the city, only if the brand has series in more than one city.
- Tour: brand is the artist, taken only from the edition's stored acts or the ticket title, never from a model or memory. Unknown artist stays empty and reads "Artist not known".
- Never in a qualifier: a year, weekend, "presents"/"pres", "w/ special guest", age limits, "2nd show added", a venue. Those are stripped from a new series name; a trailing number goes to the edition subtitle.
- Other spellings live in the series' other names (`aliases`), so matching finds them.

## Personal series

- New nullable `logged_events.series_slug` links an event to a shared series. When set, the event shows the shared series name.
- `logged_events.series` stays as the member's own wording. It is kept, never deleted (AGENTS.md "captured" rule), and used only when the member chooses "Use my own name" on that event.
- The Series field offers shared series first (name, brand and other names), then the member's own.
- `withPlace` no longer adds a town to an event that has a shared series; the series carries its place.
- A member's Manage series records follow: one record per shared series they use; unused records are removed (logged, undoable).

## Prevention

- The Series field saves on leaving the field or picking a suggestion, not while typing.
- Before any series is created (provisional edition, lineup confirm, member entry, owner form), code looks for an existing one by normalized name, other names, and brand plus qualifier. A match attaches; a close match (same brand, different qualifier) is offered, never attached on its own.
- A new series gets a cleaned name by the rule above. The slug stays an internal ID and is no longer used to match.

## Slices

1. **Series field saves on leave; unused records cleared.** `EventDetail.tsx`, `entities/link.ts` or `entities/manage.ts`, tests. [CORE / DATA]
2. **Match before create, cleaned names.** `canon/match.ts`, `lineup/pipeline.ts`, `lineup/learning.ts`, `lineup/text.ts` (name cleaner), `lineup/store/supabaseStore.ts`, tests. [CORE / DATA]
3. **Migration 0058 and the built names.** `0058_series_levels.sql` adds `event_series.qualifier`, `event_editions.subtitle`, `logged_events.series_slug` (all nullable, additive). Store read/write, `services/series.ts` title builder, Global Archive series form edits brand and qualifier. Held until Charlie applies 0058. [CORE / DATA]
4. **Events follow the shared series.** Event Series field with shared suggestions and "Use my own name", `eventTitle`, linking on save. [CORE / DATA]
5. **Run the approved cleanup.** A one-time owner action that applies `cleanup-list.md` through `saveSeriesLogged`, `merge_canonical_series`, `writeEdition` and the Manage merge, each with actor `system:series-cleanup` and a reason, all undoable. Then a read-only check that no series breaks the rule. [CORE / DATA]

Each slice updates ARCHITECTURE.md sections 02 and 12 where behavior changes.

## Out of scope

- Renaming slugs.
- Changing how events are typed (`scale.ts`).
- Other members' own wording: it is kept and they can switch back per event.
