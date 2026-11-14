# Brave Search as research rung 3: feasibility and spec

Status: Slices 1, 3 and 4 built (slice 12.2, issue #376); Slice 2 dropped by Charlie (snippet quote stays). Written 2026-11-14 for Charlie's decision.

## Verdict

**Do not build a Brave rung for the backfill. Build one small hardening slice instead.** Brave already runs as rung 3 in live research (`defaultFinders()` includes `braveFinder`; `worker/index.ts` research message), but it is uncapped there and it keeps search snippets in event records, which Brave's terms restrict. The backfill (the only place the 200 cap was meant for) should stay without Brave.

## What exists today

- `braveFinder` (`details.ts`): one query per research call, result kept only if its title and description name every word of the event; a date counts only if written in full in that snippet. The matched snippet words are stored as the source `quote`, with the result URL.
- `braveResults` also feeds URLs to the Gemini reader ("Look again with Gemini") and to `addPlaces`.
- `takeBrave` (cap 200 a month) is built and tested; nothing calls it. Backfill filters `discovered` out.
- Stage 2 (`lineup/search.ts`) uses Brave only to find candidate lineup URLs; pages are then fetched and stored as source documents.

## What Brave adds

| Event kind | Catalog / Ticketmaster / setlist.fm / Clashfinder | Brave adds |
| --- | --- | --- |
| Upcoming major shows | Ticketmaster covers | Nothing new |
| Past shows (TM drops most) | setlist.fm for artist shows only | A date or venue in a snippet, if a page still exists |
| Festivals | Clashfinder covers editions and lineups | Rarely anything |
| Club, DJ, small-promoter nights | Usually nothing | The only source; hit rate depends on the promoter having a page |
| Gemini reader (rung 4) | n/a | Brave is what finds the pages it reads; without Brave rung 4 has no page to read |

Honest limit: I ran no live queries (no Brave key here, no paid benchmarking). Quality is judged from the code and its tests: the every-word filter and full-date rule make false confirmations unlikely and misses likely. Snippets are short, so a hit needs the date in the title or description. Expect Brave to help mostly small and past events and to miss many; measure it from `ingest_traces` after wiring the counter, not before.

## Cost, limits and terms (read 2026-11-14, ToS "Last updated 1 Sep, 2026")

- The old free plan is gone. Pricing page: prepaid credits, "No minimums, no surprise bills", Search about $5 per 1,000 requests, with a monthly free credit (page text says both "$5" and "up to $20"; verify on the live page). A card may be asked "to prevent abuse". No hard spend cap is documented; Charlie must confirm in the dashboard that prepaid credit with no auto top-up is possible. REQUIREMENTS "never an open bill" holds only then.
- Rate limit 50 queries a second on Search; our fetcher spaces calls 1.1 seconds. No issue.
- **Storage:** ToS 3(b)(i) bars "store, cache, or create a database of Search Results" beyond transient storage. 3(b)(ii) bars derivative works, 3(b)(xii) bars redistribution. Storage rights need a custom plan. Today's snippet `quote` saved on a personal event is the grey area. Saved in a shared edition or `source_documents` it would be a clear breach.
- Training ban 3(b)(xiii) does not cover answer-time grounding; no attribution needed (optional "POWERED BY BRAVE"). Brave may amend terms at any time and terminate on 10 days' notice, so no feature may depend on it.

## Fit with the rules

- Never guess: met. Strict same-event filter and full written date.
- Gemini only reads fetched text: met when the reader gets pages fetched from Brave URLs. Snippets must not be fed to it.
- Syncs never overwrite newer edits: met. Candidates never overwrite typed fields.
- Stored-source rule: weak. A snippet is not a fetched source document. Safer: use Brave only to find a URL, fetch the page, read the date in code from the page, store the page's own quote.
- Shared tables (11.14 to 11.16): Brave-derived values must not reach edition tables, `source_documents` or any shared trace. Verify `persistOccurrence` never takes `discovered` sources (it persists catalog and structured sources only; add a test).

## Is 200 a month enough

- Steady state: about 7 members, tens of new events a month, one query each, up to two with a differing typed name. 200 is enough.
- Backfill: 217 events were pending, 202 from one bulk import. At 1 to 2 queries each the backlog alone would burn the whole month. Keep Brave out of the backfill.
- Credits would allow about 1,000 requests, so 200 is a conservative guard, not a limit imposed by Brave.

## Slices (if Charlie approves)

1. `[CORE / DATA]` Gate live Brave. In `braveFinder`/`braveResults`, call `takeBrave` first (store passed from the research message); at the cap return no results and add note "Brave allowance used this month". A 429 parks the job and stops, no fallback. Targets: `src/server/events/details.ts`, `src/server/events/backfillResearch.ts` (move the counter to its own file `src/server/events/braveBudget.ts`), `worker/index.ts`, `tests/events.test.ts`, `tests/backfillResearch.test.ts`. Tests: cap reached, month rollover, 429, backfill still excludes Brave.
2. `[CORE / DATA]` Stop keeping snippets. Store only the result URL plus a date read from a page the app fetched (reuse `addPlaces` page fetch); drop snippet text from `quote`. Targets: `details.ts`, `tests/events.test.ts`. Needs Charlie's call on the risk (see questions).
3. `[CORE / DATA]` Guard test that no `discovered` source reaches shared editions. Targets: `tests/` only.
4. Docs: 08-sources, 09 pipeline, 02, REQUIREMENTS R1.4 and cost line updated in the same change (free plan ended).

Do not touch migrations. No new env var.

## Do NOT Build

- Brave in the backfill or the cron.
- Caching or persisting Brave responses; adding `api.search.brave.com` to `CACHEABLE_HOSTS`.
- Brave AI Answers, Summarizer or LLM Context endpoints.
- Brave data in shared editions, `source_documents`, shared traces or the review queue.
- Snippets sent to Gemini; any model call on Brave text.
- Auto top-up or a paid plan with storage rights.
- A second search provider fallback.

## Needed from you

1. In the Brave dashboard confirm: is a card required, can you load prepaid credit with auto top-up off, and is there a spend limit? If not, remove the key and Brave stays off.
2. Is the snippet `quote` on your own events acceptable risk (personal, not shared), or do you want Slice 2 to remove it?
3. Is `BRAVE_SEARCH_API_KEY` set in production? If yes, Brave is already spending uncapped now and Slice 1 is urgent.
