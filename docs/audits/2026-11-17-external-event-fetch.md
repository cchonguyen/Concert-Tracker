# External event fetch audit (2026-11-17)

How well the app's outside lookups work today: setlist.fm, MusicBrainz, Clashfinder, Gemini, Brave Search and Ticketmaster. Written for posterity before the event fetch upgrade, so later changes can be measured against it.

Sources: the code on `main` at `7abc135`, and read-only queries against the production database (`lookup_jobs`, `logged_events.details`, `ingest_traces`, `ai_calls`, `quota_ledger`, `app_settings`, `source_stats`, `source_documents`). Data runs from 2026-10-20 to 2026-11-16. No personal fields were read. Counts are of rows and log lines, not of unique events, unless a line says otherwise.

## Summary

| Source | Stage 1 (event details) | Stage 2 (lineup) | Verdict |
| --- | --- | --- | --- |
| setlist.fm | Never called | Never called | **Off.** `SETLISTFM_API_KEY` is not set in the Worker. Every one of 102 lineup jobs logged "Not configured, skipped: setlistfm", the last on 2026-11-16 18:43Z. |
| Clashfinder | **Broken since 2026-11-10.** 132 of 171 runs failed with "Invalid JSON" | Works. 73 editions matched, 49 had no match | Stage 1 reads the event list with the default 3 MB cap; the list is now larger, so the body is cut and cannot be parsed. Stage 2 reads it with a 32 MB cap and works. |
| Brave Search | The workhorse. At least 1 match in 135 of 166 runs. Gave the date for 110 of 177 researched events | 47 searches; pages fetched and read | Healthy. 62 of 200 monthly queries used by 2026-11-16, a pace of about 115 a month. |
| Ticketmaster | 157 of 171 runs found nothing | 70 "no matching event listing"; 32 HTTP 401 until 2026-11-02 | Works, but rarely helps past events: Discovery drops them. The 401s stopped after 2026-11-02. |
| MusicBrainz | Not used | Artist ID resolution: 76 jobs, all confirmed in the end | Flaky but self-healing. 54 of 76 jobs hit a 503 or timeout at least once; retries got all of them through. None since 2026-11-10. |
| Gemini (reader) | 25 "Read with Gemini" or rung 4 calls, $0.099 | 6 lineup reads, 36 names, all verbatim, $0.033 | Accurate and cheap. 32 calls and about $0.13 in total. Earlier free-tier days ran out of quota (2026-10-21, 2026-11-02). |

The three cheapest fixes come before any new feature. Turn on setlist.fm with a key. Fix the Stage 1 Clashfinder cap. Stop Stage 2 discovery from fetching AXS pages (see Rule breach below).

## Stage 1: event details research

What research gave the events it checked (live, not deleted, with `details.checkedAt`):

| Status | Events | Meaning |
| --- | --- | --- |
| `resolved` | 117 | You picked or confirmed a candidate |
| `none` | 32 | Nothing found |
| `matched` | 22 | A source covered the date you gave |
| `choose` | 6 | Candidates offered, waiting on you |

Where the start date of a checked event came from: Brave results (`discovered`) 110, you 36, none 23, an email 6, Clashfinder 2. Ticketmaster and setlist.fm gave none. Venues: you 119, Brave pages 47, email 2, Ticketmaster 1.

A further **61 events are `pending` with only a year**. All came from one list import on 2026-11-10 and all have a venue and city. By design they are never researched without you (`yearOnlyEvents` in `src/server/events/backfillResearch.ts`); they wait in Fill gaps. Nearly all are single artists at clubs or theatres ("Artist, Venue, City, Year"), which is the case the upgrade is aimed at.

The 32 `none` events are mostly the same shape: one artist or a club night, often with a typed venue, in Seattle, Los Angeles, Vancouver or San Francisco. Several are afterparties, pool parties or pop-ups that are the person's real event, not noise.

Finder notes per run (from `details.notes`):

- Ticketmaster: 0 matches in 157 runs, 1 or more in 14.
- Brave: 1 or more in 135, 0 in 31, no failures logged.
- Clashfinder: ok in 39 runs (2026-10-20 to 2026-11-01), failed in 132 (2026-11-10 onward), always "Invalid JSON".
- setlist.fm: absent. A finder whose key is missing is skipped without a note, so Stage 1 never says it is off.

## Stage 2: lineup lookup

`lookup_jobs` with kind `lineup`: 137 jobs. 78 confirmed, 49 need review, 9 no data, 1 failed (2026-10-21). Kind `resolve_artists`: 76, all confirmed.

Log lines across all lineup jobs:

| Line | Count |
| --- | --- |
| A page was read by the reader | 117 |
| setlist.fm not configured | 102 |
| Promoter page: no lineup URL known yet | 102 |
| Clashfinder sets found | 73 |
| Ticketmaster: no matching listing | 70 |
| Clashfinder: no matching edition | 49 |
| Web search returned results | 47 |
| Page skipped (does not name the event and year) | 39 |
| A confirmed lineup was already in the database | 35 |
| Ticketmaster HTTP 401 (to 2026-11-02) | 32 |
| Page fetch refused (HTTP 403) | 24 |
| Gemini paused (daily limit, rate limit or quota) | 28 |

Pages that refused the Worker (HTTP 403): seatgeek.com 5, tixr.com 5, ra.co 4 (plus residentadvisor.net 1), concertarchives.org 2, bandsintown.com 1, stubhub.com 1, axs.com 1 and a few others. These sites block automated fetches. Their search snippets still work, so ra.co is the most common source of a Stage 1 date (9 events).

Review accuracy (`source_stats`, all scopes): Clashfinder acts accepted 5,832 and rejected 28 (99.5%). Discovered pages 349 and 163 (68%). Promoter pages 9 and 20 (31%).

### Rule breach: an AXS page was fetched

On 2026-11-14 at 00:05Z, Stage 2 discovery tried to fetch an `axs.com` event page that Brave returned (it answered 403). `addPlaces` and `detailsGemini.ts` skip AXS, but `stageDiscover` in `src/server/lineup/pipeline.ts` has no such check. AGENTS.md says "Do not scrape AXS." The guard belongs in the shared fetcher or in `stageDiscover`.

## MusicBrainz

76 `resolve_artists` jobs. 54 recorded a MusicBrainz 503 or "operation was aborted" as their last error at some point; the 1.5 s spacing and two retries (`http.ts`) got every job confirmed. No errors since 2026-11-10. The spacing lives in memory per Worker isolate, so two Worker invocations at once can each send a request in the same second. MusicBrainz is not used in Stage 1 today.

## Gemini (the reader)

From `ai_calls` (2026-11-13 to 2026-11-16; the table is new):

| Feature | Calls | Outcome | Cost | Average input |
| --- | --- | --- | --- | --- |
| `details_extract` | 25 | ok | $0.099 | 6,405 chars |
| `lineup_extract` | 6 | ok, 36 names, 36 verbatim, 0 rejected | $0.033 | 4,068 chars |
| `details_extract` | 1 | blocked, `input_too_large` (182,604 chars) | $0 | |

Average call time is about 1 second. The monthly spend counter shows 131,727 micro-dollars ($0.13) for November. Earlier, before the paid key, the free tier ran out: the daily limit was hit on 2026-10-21 and 2026-11-02, and 6 lookups failed once on Google's "model is experiencing high demand" 503.

The Worker runs `gemini-flash-lite-latest` (`wrangler.jsonc`, `GEMINI_EXTRACTION_MODEL`). `.env.example` and the code default say `gemini-3.5-flash-lite`. The `-latest` alias can change model without notice.

## Brave Search

`app_settings.brave_monthly`: 62 queries used in November by 2026-11-16 19:02Z. The cap is 200 (`braveCapFetcher`). Brave is never cached and the backfill does not use it. A Stage 1 run takes one query, or two when the renamed event finds nothing and the typed name is tried, and Stage 2 discovery takes one more.

## Telemetry gaps

- Finder results live only as free-text notes in `details.notes`. There is no per-finder row with status, duration or count, so this report had to pattern-match text.
- `ingest_traces` has 176 rows since 2026-11-13. `backfill` and `save` rows have no subrequest count. Steps hold only a status. Only 4 Stage 1 research runs are traced, while the notes show many more, so "Look again" and Fill gaps appear not to write a trace.
- A finder with no key is silent in Stage 1. That hid the missing setlist.fm key.
- There is no record of Brave calls beyond the monthly counter.
- Job logs put the Clashfinder username in URLs (only the key is redacted). It is not a secret, but it shows in the UI.

## What this means for the upgrade

1. The biggest single loss is that setlist.fm has never run. Any setlist.fm improvement does nothing until a key is set.
2. Stage 1 Clashfinder has been broken for a week by a 3 MB read cap.
3. Brave snippets carry Stage 1 today. Pages behind them often refuse the Worker (ra.co, tixr.com, seatgeek.com, concertarchives.org), which limits any plan that fetches those pages.
4. Ticketmaster seldom helps past shows. Keeping it costs one call per run and little else.
5. The reader is accurate and cheap at today's volume. The constraint is quota design and page size, not quality.
6. The 61 year-only pending events are a ready test set for single-artist lookups.
