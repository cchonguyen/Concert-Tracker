# Event ingest and self-healing canon: implementation plan

Status: built. Slices 11.0 to 11.22 are merged, with follow-ups 11.23 to 11.25. Personal-field encryption (section 4) is still on hold. Approved by Charlie on 2026-11-13, revised after the code review the same day (see section 7). Source: the council verdict Charlie posted on 2026-11-13, checked against the code at `9186e68` and the production database. Review packet: "Event ingest: today and planned" (Claude Doc).

Merging this file accepts the slices in section 5. Each slice opens its own GitHub issue (labels `slice`, `status:backlog`, the project label) before it starts. Implementers: read sections 3 and 6 before any slice.

## 1. Corrections to the verdict

The decisions stand. Six facts in the verdict were wrong or incomplete; the plan uses the production facts.

| # | Verdict says | Production shows (2026-11-13) | Effect on the plan |
| --- | --- | --- | --- |
| C1 | 43 failed `lookup_jobs` came from the 20-a-day Gemini free tier | 42 are `resolve_artists` jobs that failed on MusicBrainz 503s; 1 is a Gemini 503 ("model overloaded"). None is a quota failure. | Slice 11.7: a MusicBrainz 503 parks the job and retries; it never fails it. |
| C2 | 1,833 ticket emails can seed editions | 1,833 rows from 3 users: 207 `added` (became events), 199 `new` (not yet ticked), 958 `skipped`, 466 `unreadable`, 3 `flag` | Only `added` rows (and future ticks) seed editions. |
| C3 | `notes` and `rating` use the opt-in vault | Only `notes`, and only once a member turns the vault on. 0 rows have notes or a rating. | Personal-field privacy is held (section 4). |
| C4 | `logged_events.edition_id` must stop pointing at a mutable slug | It already references `event_editions.id` (text, never changed). The slug is `event_editions.key`, used for matching. | No foreign-key change. Matching stops using `key` (slice 11.10). |
| C5 | Simplify the 9 guards to 3 | The kill switch and breaker are what stop runaway spend on a provider outage. | Keep all guards; run them in two database calls (slice 11.4). |
| C6 | Persist every dated occurrence as `verified` | setlist.fm data is user-contributed; Ticketmaster's terms limit how long its content may be kept | Persist only what each source's terms allow (slice 11.1); the review queue corrects mistakes. |

Already built: `daysAttended` on `logged_events` and `performances.days` cover single-day attendance at a multi-day festival.

## 2. Rule changes (slice 11.0, before any code)

`AGENTS.md` says behavior described in `REQUIREMENTS.md` or `ARCHITECTURE.md` changes there first.

1. Stage 1 may call the AI reader without a button press, only as rung 4: at most 2 pages, each under 30,000 characters, inside the spend guards, never during the save.
2. A member's own entry may create a `provisional` shared edition (name, date, venue, city only; never personal fields). Today a member's events are private, and the first sign-in notice says so: the notice version goes up and members accept it again before phase 2 ships.
3. Ticket email imports that became events are a `verified` source for an edition's name, date, venue and city.
4. A linked event shows the edition's value unless the person overrode that field. What they first typed is kept as `captured` and never deleted.
5. Every change to a shared edition is recorded (old value, new value, who or what, why) and can be undone.
6. Shared tables, traces, logs and the review queue never hold personal fields (companions, notes, rating, price, attendance).

## 3. Target shape

### Editions (occurrences)

- `event_editions.status`: `draft` (owner only, unchanged), `provisional`, `verified`. Existing `confirmed` rows become `verified`; code that reads `confirmed` reads `verified`.
- New nullable columns: `venue_id`, `subject_key` (shared artist key for a headline show, series slug for a festival), `has_lineup`.
- Partial unique index on `(start_date, venue_id, subject_key)` where all three are set.
- `edition_external_ids (edition_id, source, external_id)`, unique on `(source, external_id)`.
- `canonical_venues (id, name, city, region, country)` and `venue_aliases (venue_id, alias_normalized, source, external_id)`.
- `edition_changes (id, edition_id, at, actor, reason, before jsonb, after jsonb, undone_at)`: append-only. Every edition write goes through one function, `writeEdition` in `src/server/canon/editions.ts`, which writes the row and its change in one database call.
- `merge_editions(keep_id, drop_id)`: one Postgres function that moves events, performances, external IDs and claims, records the merge in `edition_changes`, and deletes the dropped row.

### Matching order (`src/server/canon/match.ts`)

1. An external ID already stored: same edition.
2. Same date, same shared venue (by alias or venue external ID), same subject key: same edition.
3. Same date and city, different venue names: no merge; a `review_queue` row (`kind = merge_suggestion`) asks the owner, and the merge saves the alias.

### Personal events (inheritance)

- `logged_events.captured` (jsonb): name, dates, venue, city, region, country as first typed or imported. Written once.
- `logged_events.overrides` (jsonb): fields the person changed while linked.
- The store resolves every read: override, then edition, then captured. Browser code, stats, CSV and the share page see resolved fields and do not change.
- Sheets sync and list import write to `captured` (unlinked) or `overrides` (linked), never to resolved values, and keep the three-way merge rule (a stale copy never overwrites a newer edit).
- Editing a linked field writes the override and a `review_queue` row (`kind = override`). Unlinking (`edition_id = null`) falls back to captured.

### Research ladder (stage 1, queue-driven)

Research messages share the existing `LOOKUP_QUEUE` with a `type` field (`research`, or the current lineup job message). No new queue and no new binding.

| Rung | Source | Runs in | Subrequests, worst case |
| --- | --- | --- | --- |
| 0 | Parse in code, full text first | Save request | 0 |
| 1 | Shared catalog: external IDs, then date, venue and subject | Research message 1 | 2 |
| 2 | Ticketmaster, setlist.fm, Clashfinder in parallel; persist dated occurrences the terms allow | Research message 1 | 3 to 6 |
| 3 | Brave plus schema.org and OpenGraph read in code | Research message 1 | up to 13 |
| 4 | AI reader, 1 to 2 pages under 30,000 characters, `gemini-3.5-flash-lite` | One message per page | up to 4 for the fetch + 3 |

Message 1 worst case: 26 subrequests including the event read and the writes. No Brave AI Answers rung.

### Stage 2 gates

- Clashfinder returns 5 or more acts: no promoter or Wayback page goes to the AI.
- The AI reads a lineup page only when structured sources gave fewer than 2 acts and the lineup window is under 30,000 characters. Larger pages are skipped with a note, never cut up.

### Review queue and traces

- `review_queue (id, kind, edition_id, event_id, payload jsonb, status, created_at, resolved_at, resolved_by)`. Kinds: `override`, `merge_suggestion`, `provisional`, `formatting`, `failed_lookup`. One table, one owner inbox.
- `ingest_traces (id, trigger, event_id, edition_id, job_id, steps jsonb, subrequests, ai_cost_micros, created_at)`. Steps collect in memory and are written in one insert at the end of each message.

## 4. Held: personal-field privacy

Not part of this plan. Charlie's direction (2026-11-13): keep personal fields stored like event data, accept that the administrator can see them, and make sure they are not out in the open, with a defensible record that they were kept safe. A short proposal will be agreed separately. Candidates to weigh:

- Row level security on every personal table (enabled for 14 tables in migration 0039; confirm coverage of `logged_events`, `email_imports`, `user_entities`).
- Personal fields kept out of every shared table, trace, log and export to others (rule change 6 above, enforced by a test).
- The owner's app screens never show another member's personal fields.
- Supabase dashboard access limited to the owner, with two-factor sign-in, and the service key held only in the Worker.
- An access note in the privacy notice describing the above.

## 5. Slices

Every slice is under 5 files, has its own issue, and runs `npm run lint --silent` and `npm test --silent` before commit. `[CORE / DATA]` slices add tests. Migrations are written by the slice and applied by Charlie.

### Phase 0: rules, terms, quick wins, reader

- **11.0** `[DOCS]` Rule changes from section 2; fix the stale "read in windows" line. Targets: `REQUIREMENTS.md`, `AGENTS.md`, `docs/architecture/02-stage-1-capture-and-details.md`, `docs/architecture/09-lookup-pipeline.md`.
- **11.1** `[DOCS]` Read the Ticketmaster Discovery, setlist.fm and Clashfinder API terms; record per source what may be stored, for how long, and the attribution it needs. This decides what 11.14 and 11.16 may persist. Targets: `docs/architecture/08-sources.md`.
- **11.2** `[CORE / DATA]` Parser keeps the full text; ` in ` no longer splits on its own (only ` at `, `@` and a comma mark a place); it lists up to two readings for research. Targets: `src/server/events/parse.ts`, `tests/events.test.ts`.
- **11.3** `[UI / VISUAL]` Picker rows show name, weekday and date, venue, city and region, and a source count. Targets: `src/components/CheckDetails.tsx`, `src/services/checkDetails.ts`.
- **11.4** `[CORE / DATA]` `reader_preflight` and `reader_settle` database functions run every guard and every ledger and log write; one AI call drops from about 16 subrequests to 3. Kill switch and breaker stay. Targets: `supabase/migrations/0040_reader_rpcs.sql` [NEW], `src/server/reader/guard.ts`, `src/server/reader/callLog.ts`, `src/server/lineup/store/supabaseStore.ts`.
- **11.5** `[CORE / DATA]` Input ceiling and window default to 30,000 characters; default model stays `gemini-3.5-flash-lite`; mark Slice 10.17 won't-do. Targets: `src/server/reader/config.ts`, `tests/readerConfig.test.ts`, `docs/archive/ai-reader-spec.md`.
- **11.6** `[CORE / DATA]` Stage 2 gates (section 3). Targets: `src/server/lineup/pipeline.ts`, `tests/pipeline.test.ts`.
- **11.7** `[CORE / DATA]` A MusicBrainz 503 parks `resolve_artists` with a retry time; the 42 failed jobs are re-queued once. Targets: `src/server/lineup/pipeline.ts`, `src/server/lineup/musicbrainz.ts`, `tests/musicbrainzRetry.test.ts` [NEW].

### Phase 1: shared occurrences, history, inheritance

- **11.8** `[CORE / DATA]` Migrations: edition states, new edition columns, `canonical_venues`, `venue_aliases`, `edition_external_ids`, `edition_changes`, `review_queue`, `logged_events.captured` (filled from current fields) and `overrides`; then `merge_editions`. Targets: `supabase/migrations/0041_shared_occurrences.sql` [NEW], `supabase/migrations/0042_merge_editions.sql` [NEW], `src/server/lineup/types.ts`.
- **11.9** `[CORE / DATA]` Store methods for venues, external IDs, edition changes, review queue and merge, in both stores. Targets: `src/server/lineup/store/types.ts`, `src/server/lineup/store/supabaseStore.ts`, `src/server/lineup/store/fileStore.ts`, `tests/canonStore.test.ts` [NEW].
- **11.10** `[CORE / DATA]` `writeEdition` (row plus change in one call) and undo of a change; the three existing `upsertEdition` callers (`learning.ts:336`, `canonicalIngest.ts:227`, `canonicalIngest.ts:294`) move onto it. Targets: `src/server/canon/editions.ts` [NEW], `src/server/lineup/learning.ts`, `src/server/lineup/canonicalIngest.ts`, `tests/editionChanges.test.ts` [NEW].
- **11.11** `[CORE / DATA]` `match.ts` and `upsertOccurrence` with the verified and provisional rules; the pipeline's cache check uses it instead of `key`. Targets: `src/server/canon/match.ts` [NEW], `src/server/lineup/pipeline.ts`, `tests/canonMatch.test.ts` [NEW].
- **11.12** `[CORE / DATA]` Inheritance on read; linked edits write the override and a review row; unlink falls back; Sheets and list import write captured or overrides. Targets: `src/server/events/inherit.ts` [NEW], `src/server/events/service.ts`, `src/server/events/routes.ts`, `tests/inherit.test.ts` [NEW].
- **11.13** `[CORE / DATA]` Tapping a suggestion links the edition and stores the typed line as captured, instead of copying facts. Targets: `src/server/events/service.ts`, `tests/eventFromEdition.test.ts`.
- **11.14** `[CORE / DATA]` Backfill through `upsertOccurrence`: the owner's dated events and the 207 `added` email imports become `verified` editions, 20 per cron run, idempotent, with a count report; the 52 existing editions get `venue_id` and `subject_key`. Targets: `src/server/canon/backfill.ts` [NEW], `worker/index.ts`, `tests/canonBackfill.test.ts` [NEW].

### Phase 2: queue ingest and picker

- **11.15** `[CORE / DATA]` `POST /api/events` enqueues a `research` message on `LOOKUP_QUEUE` and returns; the consumer runs rungs 1 to 3 and saves; the browser shows "Looking up event details" and picks up the result. Targets: `src/server/events/routes.ts`, `worker/index.ts`, `src/server/events/details.ts`, `src/App.tsx`.
- **11.16** `[CORE / DATA]` Rung 1 runs first in `researchEvent`; rung 2 persists dated occurrences as allowed by 11.1 (one result page per source). Targets: `src/server/events/details.ts`, `tests/events.test.ts`.
- **11.17** `[CORE / DATA]` Rung 4 in its own queue message when date, venue or city is still empty. Targets: `src/server/events/detailsGemini.ts`, `worker/index.ts`, `tests/detailsGemini.test.ts`.
- **11.18** `[UI / VISUAL]` Over 5 choices: group by city, city and month chips, a search box. Targets: `src/components/CheckDetails.tsx`, `src/services/pickerGroups.ts` [NEW], `tests/pickerGroups.test.ts` [NEW].
- **11.19** `[CORE / DATA]` Pending research backfill: cron researches pending events 5 a minute at rungs 1 and 2, Brave capped at 200 queries a month; year-only events go to a "Confirm dates" list in Fill gaps. Targets: `worker/index.ts`, `src/server/events/backfillResearch.ts` [NEW], `src/components/FillGaps.tsx`, `tests/backfillResearch.test.ts` [NEW].

### Phase 3: traces and the owner inbox

- **11.20** `[CORE / DATA]` `ingest_traces` and the trace writer; save, research, backfill and lookup messages each write one row. Targets: `supabase/migrations/0043_ingest_traces.sql` [NEW], `src/server/telemetry/trace.ts` [NEW], `src/server/lineup/store/supabaseStore.ts`, `tests/trace.test.ts` [NEW].
- **11.21** `[CORE / DATA]` Owner routes for the review queue (list, promote an override to the edition, verify a provisional edition, merge, dismiss), all through `writeEdition`; owner edits of an imported title or venue add a `formatting` row. Targets: `src/server/canon/reviewRoutes.ts` [NEW], `src/server/lineup/routes.ts`, `src/server/lineup/canonicalIngest.ts`, `tests/reviewRoutes.test.ts` [NEW].
- **11.22** `[UI / VISUAL]` Owner inbox in the Global archive: the review queue by kind, recent traces, one-tap actions with undo. Targets: `src/components/AdminInbox.tsx` [NEW], `src/components/ManageView.tsx`.

### Later (not slices yet)

- Provenance drawer on the event view, once the inbox shows which traces matter.
- Runs and night-2 attendee claims, once multi-night editions exist in the catalog.
- Personal-field privacy (section 4).

## 6. Things Charlie does

| When | Step |
| --- | --- |
| Before 11.4 deploys | Apply migration 0040 in the Supabase SQL editor |
| With 11.5 | In Cloudflare, set `GEMINI_EXTRACTION_MODEL` to `gemini-3.5-flash-lite` (or delete it) and set `GEMINI_API_KEY` to the paid key |
| Before 11.9 deploys | Apply migrations 0041 and 0042 |
| Before phase 2 ships | Approve the new member notice text (rule change 2) |
| Before 11.20 deploys | Apply migration 0043 |

Migration numbers start at 0040: 0031 and 0032 are reserved and 0036 is kept empty.

## 7. Revisions after review (2026-11-13)

- Edition change history moved into phase 1 (11.10): inheritance makes a bad edition edit reach every linked event, so every edit must be recorded and undoable before inheritance ships.
- Source terms checked before persisting API data (11.1).
- Flags, formatting diffs, merge suggestions and failed lookups share one `review_queue` table and one inbox.
- Parser and picker rows moved to phase 0: no new tables, and they fix what people hit first.
- Personal-field encryption removed and held (section 4).
- Provenance drawer and night-2 attendees deferred.

## 8. Risks

- **Inheritance touches every read.** Resolving in the store keeps browser code unchanged; 11.12 tests Sheets sync and list import against it.
- **Provisional editions can spread one person's typo.** The review queue, `merge_editions` and edition undo are the cleanup path; provisional editions show "not verified" in the picker.
- **One queue lane.** `LOOKUP_QUEUE` runs one message at a time (`max_concurrency: 1`), so research waits behind a lineup step. Each step is short; if waits grow, raise concurrency or add a second queue.
- **Subrequests.** Each phase 2 pull request states its worst-case count.
