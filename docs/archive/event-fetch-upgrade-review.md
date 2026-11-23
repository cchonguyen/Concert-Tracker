# Event fetch upgrade: PRD review (2026-11-17)

> **Archived 2026-11-23.** Review of the [event fetch PRD](../specs/event-fetch-upgrade-prd.md); its points were taken into the PRD.

Review of the PRD "Concert Lookup Enrichment & Metro-Radius Resolution (Stage 1 & Stage 2)", Slices A to D, against the code on `main` at `7abc135` and the production audit in [docs/audits/2026-11-17-external-event-fetch.md](../audits/2026-11-17-external-event-fetch.md). Status: **not approved, nothing built.** Open questions for Charlie are at the end.

## The PRD's diagnosis, checked

| # | PRD claim | Holds? | Notes |
| --- | --- | --- | --- |
| 1 | Stage 1 setlist.fm asks page 1 only, with no city filter | True in code, moot in production | `setlistfmFinder` sends `artistName`, `year`, `p=1`. But `SETLISTFM_API_KEY` is not set in the Worker, so the finder has never run. |
| 2 | Stage 2 setlist.fm and Ticketmaster get "City, ST" | True | `service.ts` builds the lookup input with `cityWithRegion`; `setlistfm.ts` sends it as `cityName`, `ticketmaster.ts` as `city`. Stage 2 setlist.fm is off for the same missing key. |
| 3 | Exact city matching drops metro shows | Partly | Stage 1 setlist.fm has no city filter at all today, so nothing is dropped there; it is crowded out instead (claim 1). The drop is real in Stage 2 (`cityName`, `city`). |
| 4 | Brave dates come only from the snippet; `addPlaces` runs only on dated candidates | True | `braveFinder` makes candidates only from `findDates` on the snippet; `addPlaces` needs `c.startDate`. |
| 5 | `webQuery` adds "City, ST"; equal candidates sort by date | True | `q.city` is `cityWithRegion(...)`. Sort is source count, then start date. |

## What the PRD misses

1. **setlist.fm is off.** FR-1 and FR-2 change a finder that has never run. A free non-commercial key has to come first, and setlist.fm's terms then apply: non-commercial use only, no stored copies beyond short caching, attribution wherever its data is shown (docs/architecture/08-sources.md).
2. **Stage 1 Clashfinder is broken.** Since 2026-11-10, 132 of 171 runs failed because `clashfinderFinder` reads the event list with the 3 MB default; Stage 2 passes `LIST_MAX_BYTES` (32 MB). One line fixes it.
3. **Stage 2 discovery fetched an AXS page** (2026-11-14). `stageDiscover` has no AXS check. Not in the PRD.
4. **Venue is ignored.** Most failing events have a typed venue. setlist.fm search takes `venueName` and returns venue ids. Matching on the typed venue first, then the metro radius, is more precise than radius alone.
5. **The 61 year-only pending events** are the PRD's own use case, and nothing reaches them unless the person opens Fill gaps. The PRD does not say whether they should be researched in a batch (Brave cost: up to 61 queries, about 30% of a month).
6. **Rung 4 already exists.** The PRD's constraint "0 Gemini calls in Stage 1 auto-research" holds for `runQueuedResearch` itself, but rung 4 (Slice 11.17, `research_reader` messages) already runs the reader after it without a button press. The PRD should say whether rung 4 stays.
7. **Verification tooling does not exist.** `scripts/recall-test.ts` is the paid Gemini lineup benchmark, not a Stage 1 date recall test. The ">= 80% recall" metric needs a new fixture corpus and an offline harness.
8. **Telemetry.** No per-finder structured record exists, so the metrics in the PRD cannot be measured in production today.

## Risks

- **Subrequest budget.** FR-1 adds a MusicBrainz call (up to 3 with its two retries on 503), FR-2 an Open-Meteo call and possibly a second setlist.fm page. All of it runs twice when the typed-name retry fires. Worst case rises from 35 to about 45, above the PRD's own 40 target and close to the 50 ceiling.
- **Latency and MusicBrainz flakiness.** 54 of 76 artist-ID jobs hit a MusicBrainz 503 or timeout at least once. In the Stage 1 hot path that adds seconds (1.5 s spacing, 2 s and 4 s backoff, 15 s timeout), while the browser stops polling after about 2 minutes. The per-host spacing is per isolate, so parallel invocations can exceed 1 request a second.
- **JSON-LD pages refuse the Worker.** The PRD's named targets returned HTTP 403 in production: ra.co, tixr.com, concertarchives.org, seatgeek.com, bandsintown.com. FR-3 will often spend a page fetch for nothing. Sites that do answer (do206.com, do604.com, jambase.com, venue sites, insomniac.com) are a better bet.
- **Metro radius.** 50 km catches Inglewood, West Hollywood, Pasadena and Long Beach, but not the PRD's own San Bernardino example (about 95 km from Los Angeles), and it lets San Jose (about 68 km from San Francisco) fall outside. Open-Meteo `cityPoint` is cached only in memory per isolate.
- **Ancillary demotion.** The person's own events include afterparties, pool parties and pop-ups. Demotion applies only when the typed name lacks those words, which protects them, but a fixed English keyword list is a heuristic that will misfire ("Afters" as an event name, "Day Club" brands). The gain is limited to the order of `choose` candidates.
- **setlist.fm coverage for DJ club shows** is thin, since setlists are contributed by fans. The 80% target is unverified for this person's mostly electronic club history.
- **Brave terms.** FR-3 stores a page's JSON-LD as the quote, not the Brave snippet, which is cleaner. Brave snippets are still used as quotes today, a choice Charlie made on 2026-11-13.

## Opportunities, cheapest first

1. Fix the Stage 1 Clashfinder cap (one line, no new cost).
2. Add the AXS guard to the shared fetcher, so no path can fetch AXS.
3. Set a setlist.fm key in the Worker (no code; Charlie's account).
4. Strip the region from the city for Stage 2 adapters and the Brave query (FR-2.3, FR-4).
5. setlist.fm venue and metro matching in Stage 1 (FR-2), with page 2 only when page 1 is full and has no match.
6. JSON-LD from Brave result pages (FR-3), skipping hosts that refused before.
7. A structured per-finder trace step (status, count, milliseconds), so recall can be measured from production.
8. MusicBrainz MBID lookup for setlist.fm (FR-1), only if name matching proves to mix up artists.
9. Ancillary demotion (FR-5), last.

## Questions for Charlie

Answers from 2026-11-17, now built into [event-fetch-upgrade-prd.md](../specs/event-fetch-upgrade-prd.md):

1. setlist.fm key: added to the Worker secrets by Charlie.
2. Fix the broken items first: yes. That is Stage 0, with a check-back 2 to 3 hours after deploy.
3. Success counts as A (year-only events get dates), then B (typed-from-memory events resolve), then C (fewer wrong candidates).
4. Batch research: yes, in batches wherever possible.
5. Rung 4: Charlie asked for an explanation (PRD section 5). Keep or drop is still open.
6. Ancillary demotion: review how often the same artist plays the same city in one year first. In Charlie's history it is about 2%, so the PRD uses venue matching and a guardrail instead of a word list.
7. Radius: tunable, in miles.
