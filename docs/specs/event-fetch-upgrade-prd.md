# Event fetch upgrade: PRD and staged spec

Status: **Stage 0 approved (Charlie, 2026-11-17); Stages 1 to 5 drafted, waiting on the open questions at the end.**
Inputs: Charlie's PRD "Concert Lookup Enrichment & Metro-Radius Resolution" (2026-11-17), the production audit [docs/audits/2026-11-17-external-event-fetch.md](../audits/2026-11-17-external-event-fetch.md), and the review [docs/specs/event-fetch-upgrade-review.md](event-fetch-upgrade-review.md).

## 1. Goal

Make the outside lookups that fill in an event's date, venue and city more reliable, without new running costs and without more taps for easy events. The rules in AGENTS.md hold throughout: nothing is invented, every value carries its source and quote, the reader model only reads pages the app fetched, and no AXS page is ever fetched.

## 2. Success, in Charlie's order (2026-11-17)

| Rank | Outcome | Measured by |
| --- | --- | --- |
| A | Events saved as "Artist, Venue, City, Year" get their date. Today there are 61, all pending since the 2026-11-10 import. | Share of year-only events that reach `matched` or a `choose` list holding the right date (Charlie confirms) |
| B | Events typed from memory find their details on save | Share of new events that leave `pending` as `matched` or `choose`, not `none` |
| C | Fewer wrong candidates | Share of `choose` lists where Charlie dismisses every candidate, and rejected picks |

Baselines come from the audit (2026-10-20 to 2026-11-16): checked events were 117 `resolved`, 22 `matched`, 32 `none`, 6 `choose`; plus 61 year-only events never researched.

## 3. Constraints

- **Money:** $0 to $5 a month. Gemini spend guards ($0.50 a day, $5 a month) stay. Brave stays capped at 200 queries a month (`braveCapFetcher`).
- **Worker:** at most 50 subrequests per invocation. Each stage below states its worst case.
- **No migrations.** New telemetry goes in existing jsonb columns (`ingest_traces.steps`, `logged_events.details`) and `app_settings`.
- **No new search provider.** Do not call Brave's `/llm/context` or `/chat/completions` endpoints. Never cache Brave.
- **No hardcoded lists** of cities, suburbs, venues, artists or promoters. A distance comes from coordinates (Open-Meteo `cityPoint`, setlist.fm venue coordinates).
- **setlist.fm terms:** non-commercial use only; data is shown with attribution and a link; no copies kept beyond short caching; never written to shared editions. Charlie added the key to the Worker on 2026-11-17.
- **Your word wins:** research never overwrites a field you typed, and a year-only event never gets a date without your tap (R1.5).

## 4. Stages

Each stage is one or more slices, built one at a time on Haiku 5.5, with typecheck and tests before each pull request. A merge to `main` deploys through Cloudflare Workers Builds.

### Stage 0: fix what is broken (approved, build now)

One slice. No new cost.

| Fix | Where | Why |
| --- | --- | --- |
| 0a. Read Clashfinder's event list with the same 32 MB cap as Stage 2, and say so when it is cut off | `src/server/events/details.ts` (`clashfinderFinder`) | 132 of 171 Stage 1 runs since 2026-11-10 failed with "Invalid JSON" under the 3 MB default |
| 0b. Refuse `axs.com` in the shared fetcher, so no path can fetch it | `src/server/lineup/http.ts` | Stage 2 discovery fetched an AXS page on 2026-11-14 |
| 0c. Stage 1 notes name each finder that is off ("setlistfm: not configured") | `src/server/events/details.ts` (`researchEvent`) | The missing setlist.fm key was invisible in Stage 1 |

Subrequests: unchanged.

**Check-back, 2 to 3 hours after the deploy.** A scheduled check in this thread reads production, read-only:

1. Stage 1 notes since the deploy: `clashfinder:` lines show matches or "0 match(es)", and no "Invalid JSON".
2. Stage 1 notes show `setlistfm:` lines. A count means the new key works; "not configured" means the secret did not reach the Worker.
3. Lineup job logs since the deploy: setlist.fm ran (no "Not configured, skipped: setlistfm"), and no `axs.com` fetch appears.
4. Any new failure line that was not there before.

If there is too little traffic in that window, the check runs one "Look again" on an existing festival event and on an artist event that the owner picks. It reports pass or fail for each item.

### Stage 1: measure (before changing ranking)

| Slice | What | Subrequests |
| --- | --- | --- |
| 1.1 | Structured per-finder steps in `ingest_traces.steps` for every research run, including "Look again" and Fill gaps: finder, outcome (ok, empty, failed, off), candidate count, milliseconds. No page text, no personal fields. | +0 (the trace write already exists for queued research; +1 store write for the button paths) |
| 1.2 | A small owner-only readout (Settings, next to the AI spend panel): per finder over the last 30 days, runs, hits, failures and the success-rate rows from section 2 | 0 at research time |
| 1.3 | Offline test fixtures, written by hand, for the four failure shapes (crowded setlist.fm page, metro suburb, year-less snippet, same artist twice in a city). No recorded setlist.fm or Brave data is kept, per their terms. | 0 |

Stage 1 exists so Stages 2 to 5 can be judged on numbers instead of guesses. It runs for at most a few days before Stage 2 starts (Charlie, 2026-11-17); the numbers keep collecting alongside.

### Stage 2: single-artist shows through setlist.fm (success A and B)

| Slice | What |
| --- | --- |
| 2.1 | `haversineMiles` and `withinRadius(target, coords, miles)` in `src/server/events/place.ts`. The radius is tunable through `METRO_RADIUS_MILES` (default 50 miles, Charlie 2026-11-17; lowered only if false positives show up). |
| 2.2 | Stage 2 setlist.fm `cityName` and Ticketmaster `city` get the bare city ("Los Angeles", not "Los Angeles, CA"); both APIs index bare names (moved from Stage 0, whose slice is capped under 5 target files). Stage 1 `setlistfmFinder` gets the bare city too. It keeps a setlist when its venue name matches the venue you typed (normalized); failing that, when the venue's city is within the radius of your city (setlist.fm gives coordinates); failing that, when the bare city names match. It fetches page 2 only when page 1 was full (20) and kept nothing. With no city typed, behavior is unchanged. |
| 2.3 | Candidates and stored sources from setlist.fm show the same small source icon and name as Clashfinder and the other sources, with a tooltip and the setlist link (attribution, per its terms). Approved by Charlie 2026-11-17: simple, unintrusive, consistent. |

Subrequests: +1 Open-Meteo (cached per isolate), +1 setlist.fm page 2, doubled when the typed-name retry runs: worst case 35 to 39.

Deferred: MusicBrainz MBID lookup for setlist.fm (the PRD's FR-1). MusicBrainz failed transiently in 54 of 76 production jobs and would add seconds to every save. Build it only if Stage 1 data shows wrong artists with the same name.

### Stage 3: batch research for year-only events (success A)

| Slice | What |
| --- | --- |
| 3.1 | A batch step for events with a year, a city and no date. It runs the structured finders only (setlist.fm, Clashfinder, Ticketmaster; no Brave and no reader), under the cron's subrequest budget, a few events a run, each event at most once a day (the retry rule from `backfillResearch.ts`). Results are `choose` candidates; nothing is filled without your tap. |
| 3.2 | Fill gaps lists the batch results, so a whole set of single good candidates can be confirmed in a few taps. Each still shows its date, venue and source. |
| 3.3 | Cascade instead of parallel. Today Brave runs alongside the free finders on every research run. In production, Brave was the only source with a hit in 117 of 162 runs, and redundant in at most 21 (13%), where a free source had already answered. From this slice, Brave runs only when the free finders leave the date (or, with a full date, the venue or city) unanswered. Brave is then allowed in the batch too, because it is invoked only when it can add something (Charlie, 2026-11-17: automation is fine if it cascades efficiently). Each Brave call made by the batch is noted on the event and counted in the 200 monthly cap. |

Subrequests: per event about 7 to 9 (store 2, finders 3 or 4, Open-Meteo 1, page 2 1). That is 4 to 5 events per run under 50.

### Stage 4: web results (success B)

| Slice | What |
| --- | --- |
| 4.1 | The Brave query uses the bare city (`"Gryffin" 2026 Los Angeles`). |
| 4.2 | When a Brave result names the event but its snippet has no full date, the app fetches the page (never AXS) and reads its `schema.org` Event JSON-LD in code (`eventsFromPage` in `place.ts`): start and end date, venue, city. The quote is built from the JSON-LD fields, not the Brave snippet. One page budget of 3 is shared with `addPlaces`. |
| 4.3 | Hosts that refused the Worker (403) in the last 30 days are skipped before a fetch is spent. The list is learned from responses and kept in `app_settings`, never typed in by hand. |

Subrequests: page fetches stay at 3 in total, so the worst case is unchanged.

### Stage 5: candidate quality (success C)

| Slice | What |
| --- | --- |
| 5.1 | Ranking: a candidate whose venue matches the venue you typed ranks first, then the number of sources, then the date. |
| 5.3 | "Did you mean?" (Charlie, 2026-11-17). Each candidate gets a score computed in code from its sources: date coverage, venue match, distance, number of sources. The best one is offered first. Another candidate counts as a near match when its score reaches 50% of the best one's. In that case the event shows a small button that highlights the difference, for example another date or venue, and asks whether you meant that one. This catches a wrong year or venue typed from memory. Nothing changes without a tap. |
| 5.2 | Same-artist guardrail. When two or more candidates fall in your window in the same metro area, nothing is applied on its own even with a full date, unless exactly one matches your typed venue. The `choose` list shows date and venue for each. |

Not built: the PRD's afterparty and pop-up word list (FR-5). In Charlie's history, the same artist (or event name) appears in the same city in one year in about 2% of cases (4 of 385 name, city and year groups; 12 of 498 artist, city and year groups among acts seen, at most 3 times). Several of those are recurring series or duplicates, not afterparties. Venue matching (5.1) and the guardrail (5.2) cover the real cases without a fixed word list.

### Stage 4b: deep search for hard events (proposal, waiting on Charlie)

Rung 4 has been close to useless as built (section 5). The measured bottleneck is finding pages, not reading them. When the reader failed, it usually had no page that named the event. A person searching by hand would try a few searches, open the likely pages and read them. Deep search does the same inside the rules:

| Slice | What |
| --- | --- |
| 4b.1 | When rungs 1 to 3 found nothing usable, code builds up to 2 more Brave queries from what you typed: artist with venue and year, then venue with city and month or year. Pages from those results that name the event (never AXS, never hosts that refused before) go to the reader, at most 3 pages and 30,000 characters each, inside the spend guards. |
| 4b.2 | Also for year-only events. Results are candidates only and are never applied without a tap (R1.5). |
| 4b.3 | Its own monthly allowance inside the 200 Brave cap, for example 60, so ordinary research always has queries left. |

Cost per hard event: at most 2 Brave queries and 3 reader pages (about 1 cent). The reader still never searches by itself, never chooses URLs and never answers from memory. Gemini's grounded search is not used, because that would have the model fetch pages the app did not fetch.

## 5. Rung 4 (for reference)

Rung 4 is the one place where the reader model (Gemini) runs in Stage 1 without a button press. It was built in Slice 11.17. After the queued research (rungs 1 to 3) finishes, it runs only if the event has a full date and venue or city is still empty. It reads at most 2 pages that the web search already found, each under 30,000 characters, one queue message per page, inside the spend guards. Its result fills empty fields only when its date equals the full date you gave. A year-only event never reaches rung 4. Measured effect (2026-11-13 to 2026-11-16): automatic rung 4 ran once, on one page, and no field it read was kept. The same reader behind "Look again with Gemini" ran on 12 events (24 calls, $0.099). It gave a usable candidate on 4 events (33%), about 2.5 cents per success. Of the 8 failures, 4 had no web page to read and 2 had pages that did not name the event, so no call was made; 2 read pages that held nothing. The reader is effective when it has the right page. Rung 4's trigger (full date, missing venue or city) is narrow and skips the main failure, a missing date. Charlie's rule (2026-11-17): keep it only if it adds value; Stage 4b is the proposal to make it effective.

## 6. Out of scope

A second search provider, Brave answer endpoints, caching Brave, scraping AXS or any site that refuses the Worker, migrations, changes to Stage 2 lineup reading, Workers AI, and a duplicate-event cleanup. The duplicates found while counting go to a separate thread if Charlie wants one.

## 7. Open questions (to Charlie)

Tracked in the project thread; answers are copied here before each stage's slices are opened.
