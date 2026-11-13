# Event ingest and self-healing canon: phased plan

Status: proposed 2026-11-13 for Charlie's approval. Source: the council verdict Charlie posted on 2026-11-13 ("Council Verdict & Locked Architecture"), checked against the code at `9186e68` and the production database the same day. Review packet: "Event ingest: today and planned" (Claude Doc).

Nothing here is built. Merging this file accepts the slices in section 5. Each slice still needs its own GitHub issue before it starts.

## 1. Corrections to the verdict

The decisions stand. Six facts in the verdict are wrong or incomplete, and two of them change the plan.

| # | Verdict says | Production shows (2026-11-13) | Effect on the plan |
| --- | --- | --- | --- |
| C1 | 43 failed `lookup_jobs` came from the 20-a-day Gemini free tier | 42 are `resolve_artists` jobs that failed on MusicBrainz 503s; 1 is a Gemini 503 ("model overloaded"). None is a quota failure. | Add slice 11.4: a MusicBrainz 503 retries later and never fails the job. |
| C2 | 1,833 ticket emails can seed editions | 1,833 rows from 3 users: 207 `added` (became events), 199 `new` (not yet ticked), 958 `skipped`, 466 `unreadable`, 3 `flag` | Only `added` rows (and future ticks) seed editions. Skipped and unreadable rows are parking, resale, newsletters and failures. |
| C3 | `notes` and `rating` use the opt-in vault | Only `notes` are vault-encrypted, and only once a member turns the vault on. 0 rows have notes or a rating today. Person names in `user_entities` are plain text unless the vault is on. | Slice 11.6 covers `rating` too, and 11.7 lists person records as a follow-up. |
| C4 | `logged_events.edition_id` must stop pointing at a mutable slug | It already references `event_editions.id` (text, never changed). The slug lives in `event_editions.key`, which the pipeline uses to match. | No foreign-key change. The work is to stop matching on `key` (slice 11.10). |
| C5 | Simplify the 9 guards to 3 (size, spend, calls per job) | The kill switch and the breaker are what stop runaway spend on a provider outage. | Keep all guards. Collapse them into two database calls (slice 11.1). |
| C6 | "Persist every dated occurrence" as `verified` | setlist.fm data is user-contributed and sometimes wrong | Keep `verified` for structured APIs as decided; the flag inbox (11.23) is the correction path. |

Also already built: `attended_dates` exists as `daysAttended` on `logged_events`, and `performances.days` holds a festival act's days. Single-day festival attendance needs no new column.

## 2. Rule changes this plan needs

`AGENTS.md` says behavior described in `REQUIREMENTS.md` or `ARCHITECTURE.md` changes there first. Slice 11.0 makes these changes before any code:

1. Stage 1 may call the AI reader without a button press, only as rung 4: at most 2 pages, each under 30,000 characters, inside the spend guards, never during the save.
2. A member's own entry may create a `provisional` shared edition (name, date, venue, city only; never personal fields). **This changes what members share.** Today a member's events are private (row level security, `own_rows`), and the first sign-in notice was written for that. The notice version goes up and members accept it again.
3. Ticket email imports that became events are a `verified` source for an edition's name, date, venue and city.
4. "Seen by attendees" (2 or more members ticked the act on the same edition) is a source for a shared performance, below `billed`.
5. A linked event shows the edition's value unless the person overrode that field. What they first typed is kept as `captured` and never deleted.
6. Personal fields (`ticket_price`, `companions`, `rating`, `notes`) are stored encrypted with a Worker-held key. The Worker, and so its owner, can still read them; the aim is that nobody browsing the database can.

## 3. Target shape

### Editions (occurrences)

- `event_editions.status`: `draft` (owner-only, unchanged), `provisional`, `verified`. Existing `confirmed` rows become `verified`.
- New nullable columns: `venue_id` (shared venue), `subject_key` (shared artist key for a headline show, series slug for a festival), `run_id`, `has_lineup`.
- Unique on `(start_date, venue_id, subject_key)` where all three are set.
- `edition_external_ids (edition_id, source, external_id)`, unique on `(source, external_id)`: Ticketmaster event ID, setlist.fm setlist ID, Clashfinder slug.
- `canonical_venues (id, name, city, region, country)` and `venue_aliases (venue_id, alias_normalized | source + external_id)`.
- `merge_editions(keep_id, drop_id)`: one Postgres function that moves events, performances, external IDs and claims, writes a manifest for undo, and deletes the dropped row.

### Matching order (one function, `src/server/canon/match.ts`)

1. An external ID already stored: same edition.
2. Same date, same shared venue (by alias or venue external ID), same subject key: same edition.
3. Same date and city, different venue names: no merge; an `admin_flags` row asks the owner, and the merge saves the alias.

### Personal events (inheritance)

- `logged_events.captured` (jsonb): name, dates, venue, city, region, country as first typed or imported. Written once.
- `logged_events.overrides` (jsonb): fields the person changed while linked.
- The store resolves every read: override, then edition, then captured. Browser code, stats, CSV, Sheets and the share page see resolved fields and do not change.
- Editing a linked field writes the override and an `admin_flags` row. Unlinking (`edition_id = null`) falls back to captured.

### Research ladder (stage 1, queue-driven)

| Rung | Source | Runs in | Subrequests |
| --- | --- | --- | --- |
| 0 | Parse in code, full text first | Save request | 0 |
| 1 | Shared catalog: external IDs, then date, venue and subject | Research message 1 | 2 |
| 2 | Ticketmaster, setlist.fm, Clashfinder in parallel; persist every dated occurrence | Research message 1 | 3 to 6 |
| 3 | Brave plus schema.org and OpenGraph read in code | Research message 1 | up to 13 |
| 4 | AI metadata reader, 1 to 2 pages under 30,000 characters, `gemini-3.5-flash-lite` | One message per page | 1 fetch (up to 4) + 3 |

Message 1 worst case is 26 subrequests including the event read and writes. No Brave AI Answers rung.

### Stage 2 gates

- Clashfinder returns 5 or more acts: no promoter or Wayback page goes to the AI.
- The AI reads a lineup page only when structured sources gave fewer than 2 acts and the page's lineup window is under 30,000 characters. Larger pages are skipped with a note, never cut up.

## 4. Things Charlie does

| When | Step |
| --- | --- |
| Before 11.1 deploys | Apply migration 0040 in the Supabase SQL editor |
| With 11.2 | In Cloudflare, set `GEMINI_EXTRACTION_MODEL` to `gemini-3.5-flash-lite` (or delete it) and set `GEMINI_API_KEY` to the paid key |
| Before 11.6 deploys | Add the Worker secret `PERSONAL_DATA_PEPPER` and keep a copy outside Cloudflare; losing it loses the encrypted fields |
| Before 11.7 | Apply migration 0041 |
| Before 11.8 | Apply migrations 0042 and 0043 |
| Before phase 2 ships | Approve the new member notice text (rule change 2) |
| Phase 3 | Apply migration 0044 |

Migration numbers start at 0040: 0031 and 0032 are reserved and 0036 is kept empty.

## 5. Slices

Every slice is under 5 files, has its own issue, and runs `npm run lint --silent` and `npm test --silent` before commit. `[CORE / DATA]` slices add tests.

### Phase 0: rules, reader, privacy

- **11.0** `[DOCS]` Rule changes from section 2 in `REQUIREMENTS.md`, `AGENTS.md`, `docs/architecture/02`, `09`, `10`, `12`; fix the stale "read in windows" line in `09`. Targets: those files.
- **11.1** `[CORE / DATA]` Two database functions, `reader_preflight` and `reader_settle`, run every guard and every ledger and log write; one AI call drops from about 16 subrequests to 3. Kill switch and breaker stay. Targets: `supabase/migrations/0040_reader_rpcs.sql` [NEW], `src/server/reader/guard.ts`, `src/server/reader/callLog.ts`, `src/server/lineup/store/supabaseStore.ts`, `tests/readerGuard.test.ts`.
- **11.2** `[CORE / DATA]` Input ceiling and window default to 30,000 characters; default model stays `gemini-3.5-flash-lite`. Retire Slice 10.17 (Hydrogen dropped); 10.15 and 10.16 stay parked. Targets: `src/server/reader/config.ts`, `tests/readerConfig.test.ts`, `.spec/PROGRESS.md`, `docs/ai-reader-spec.md`.
- **11.3** `[CORE / DATA]` Stage 2 gates from section 3. Targets: `src/server/lineup/pipeline.ts`, `tests/pipeline.test.ts`.
- **11.4** `[CORE / DATA]` A MusicBrainz 503 parks `resolve_artists` with a retry time instead of failing it; the 42 failed jobs are re-queued once. Targets: `src/server/lineup/pipeline.ts`, `src/server/lineup/musicbrainz.ts`, `tests/musicbrainzRetry.test.ts` [NEW].
- **11.5** `[CORE / DATA]` `fieldCrypto.ts`: AES-256-GCM, key by HKDF from `PERSONAL_DATA_PEPPER` and `user_id`, values `v1:<iv>:<ciphertext>`. Targets: `src/server/privacy/fieldCrypto.ts` [NEW], `tests/fieldCrypto.test.ts` [NEW].
- **11.6** `[CORE / DATA]` The Supabase store encrypts `ticket_price`, `companions`, `rating` and `notes` on write and decrypts on read; a note already in vault format passes through untouched. Text columns for the ciphertext come from migration 0041. Targets: `supabase/migrations/0041_personal_fields_encrypted.sql` [NEW], `src/server/lineup/store/supabaseStore.ts`, `tests/personalFieldsEncrypted.test.ts` [NEW].
- **11.7** `[CORE / DATA]` One-time backfill (cron, batched) encrypts the 113 prices and 90 companion lists, checks every row decrypts, then clears the plain columns. Follow-up issue only: plain person names in `user_entities`. Targets: `src/server/privacy/backfill.ts` [NEW], `worker/index.ts`, `tests/personalBackfill.test.ts` [NEW].

### Phase 1: shared occurrences and inheritance

- **11.8** `[CORE / DATA]` Migrations: edition states, new edition columns, `canonical_venues`, `venue_aliases`, `edition_external_ids`, `logged_events.captured` and `overrides` (filled from current fields), `admin_flags`; `merge_editions` function. Targets: `supabase/migrations/0042_shared_occurrences.sql` [NEW], `supabase/migrations/0043_merge_editions.sql` [NEW], `src/server/lineup/types.ts`.
- **11.9** `[CORE / DATA]` Store methods for venues, external IDs, flags and merge, in both stores. Targets: `src/server/lineup/store/types.ts`, `supabaseStore.ts`, `fileStore.ts`, `tests/canonStore.test.ts` [NEW].
- **11.10** `[CORE / DATA]` `match.ts` (section 3 order) and `upsertOccurrence` with the verified and provisional rules. The pipeline's cache check uses it in place of `key`. Targets: `src/server/canon/match.ts` [NEW], `src/server/lineup/pipeline.ts`, `tests/canonMatch.test.ts` [NEW].
- **11.11** `[CORE / DATA]` Inheritance: the store resolves override, edition, captured on read; `PATCH` on a linked field writes the override and a flag; unlink falls back. Targets: `src/server/events/inherit.ts` [NEW], `src/server/events/service.ts`, `src/server/events/routes.ts`, `tests/inherit.test.ts` [NEW].
- **11.12** `[CORE / DATA]` Tapping a suggestion links the edition and stores the typed line as captured, instead of copying facts. Targets: `src/server/events/service.ts`, `tests/eventFromEdition.test.ts`.
- **11.13** `[CORE / DATA]` Backfill: the owner's dated events and the 207 `added` email imports become `verified` editions through `upsertOccurrence`, 20 per cron run, idempotent, with a count report. The 52 existing editions get `venue_id` and `subject_key`. Targets: `src/server/canon/backfill.ts` [NEW], `worker/index.ts`, `tests/canonBackfill.test.ts` [NEW].

### Phase 2: queue ingest, parser, picker

- **11.14** `[CORE / DATA]` `POST /api/events` enqueues a research message and returns; the consumer runs rungs 1 to 3 and saves; the browser shows "Looking up event details" and picks up the result. Targets: `src/server/events/routes.ts`, `worker/index.ts`, `src/server/events/details.ts`, `src/App.tsx`.
- **11.15** `[CORE / DATA]` Rung 1 runs first in `researchEvent`; rung 2 persists every dated occurrence it returns (one result page per source). Targets: `src/server/events/details.ts`, `tests/events.test.ts`.
- **11.16** `[CORE / DATA]` Rung 4 in its own queue message when date, venue or city is still empty. Targets: `src/server/events/detailsGemini.ts`, `worker/index.ts`, `tests/detailsGemini.test.ts`.
- **11.17** `[CORE / DATA]` Parser keeps the full text; ` in ` no longer splits on its own; it lists up to two readings for research, and a split stands only when a source confirms it. Targets: `src/server/events/parse.ts`, `tests/events.test.ts`.
- **11.18** `[UI / VISUAL]` Picker rows show name, weekday and date, venue, city, region and a badge ("Known in catalog" or "2 sources"). Targets: `src/components/CheckDetails.tsx`, `src/services/checkDetails.ts`.
- **11.19** `[UI / VISUAL]` Over 5 choices: group by run and city, city and month chips, a search box. Targets: `src/components/CheckDetails.tsx`, `src/services/pickerGroups.ts` [NEW], `tests/pickerGroups.test.ts` [NEW].
- **11.20** `[CORE / DATA]` Pending backfill: cron researches pending events 5 a minute at rungs 1 and 2, Brave capped at 200 queries a month; year-only events go to a "Confirm dates" list in Fill gaps. Targets: `worker/index.ts`, `src/server/events/backfillResearch.ts` [NEW], `src/components/FillGaps.tsx`, `tests/backfillResearch.test.ts` [NEW].

### Phase 3: telemetry, flags, formatting

- **11.21** `[CORE / DATA]` `ingest_traces` (one row per run, steps batched in memory, one insert) and `formatting_diffs` tables. Targets: `supabase/migrations/0044_ingest_traces.sql` [NEW], `src/server/telemetry/trace.ts` [NEW], `src/server/lineup/store/supabaseStore.ts`, `tests/trace.test.ts` [NEW].
- **11.22** `[CORE / DATA]` Owner routes: list flags, promote a flag to the edition (one click, undoable), dismiss; promoting a provisional edition to verified. Targets: `src/server/canon/flagRoutes.ts` [NEW], `src/server/lineup/routes.ts`, `tests/flagRoutes.test.ts` [NEW].
- **11.23** `[UI / VISUAL]` Admin inbox in the Global archive: flags, formatting diffs, failed and multi-choice lookups, recent ingests. Targets: `src/components/AdminInbox.tsx` [NEW], `src/components/ManageView.tsx`.
- **11.24** `[CORE / DATA]` Owner edits of an imported title or venue log a `(seller, field, raw, cleaned)` diff. Targets: `src/server/lineup/canonicalIngest.ts`, `tests/formattingDiffs.test.ts` [NEW].
- **11.25** `[UI / VISUAL]` Provenance drawer on the event and edition views (owner only). Targets: `src/components/ProvenanceDrawer.tsx` [NEW], `src/components/EventDetail.tsx`.

### Phase 4: night 2 attendees (after runs exist)

- **11.26** `[CORE / DATA]` Runs from setlist.fm tours and Ticketmaster attractions; night 1's lineup offered on night 2 as hints; 2 or more attendee ticks write a "seen by attendees" claim. Targets: `src/server/canon/runs.ts` [NEW], `src/server/lineup/learning.ts`, `tests/attendeeClaims.test.ts` [NEW].

## 6. Risks

- **Inheritance touches every read.** Resolving in the store keeps browser code unchanged, but the Sheets sync and CSV import must write to `captured` or `overrides`, never to resolved values. Slice 11.11 tests both.
- **Provisional editions spread one person's typo.** The flag inbox and `merge_editions` with undo are the cleanup path; provisional editions show a "not verified" badge in the picker.
- **Encryption key loss is unrecoverable** for those four fields. Charlie keeps an offline copy.
- **Subrequests.** Each phase 2 slice states its worst-case count in its pull request.
