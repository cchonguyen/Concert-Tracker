# LiveArchive architecture

This is the source of truth for how LiveArchive finds lineups and stores what you have seen. Anyone changing the app, person or AI agent, should read it first and keep it current. The rules an agent must follow are summarized in [AGENTS.md](AGENTS.md).

## Goal

You enter an event you went to (name, year, and any hints). The app finds who performed, with a citation for every act, lets you confirm the lineup and tick the sets you saw, and stores the result so the same edition never has to be looked up again. When an API has no capacity, the lookup waits in a queue. It never guesses.

## Invariants

These are enforced in code. A change that breaks one is a bug, even if the output looks more complete.

1. **No claim without evidence.** Every act in a lineup carries at least one source URL and the text it was found in (`PerformerClaim.quotedSpan`). Facts (dates, venue) carry their source too.
2. **Gemini is a reader, never a memory.** Gemini only extracts names from text the app fetched and stored. A name is kept only if its quoted span occurs in the stored page and the name occurs in the span (`isVerbatim` in `src/server/lineup/text.ts`).
3. **Confidence is computed, never asked for.** It comes from which sources agree and how often each source has been right in your reviews (`src/server/lineup/merge.ts`). No model is asked for a confidence score, a URL it did not find, or a date it was not shown.
4. **Empty is a valid answer.** If no source lists a lineup, the lookup ends as `no_data` and you enter acts by hand. There are no default dates, cities, venues, stages, ratings or setlists anywhere.
5. **Resolve once, reuse forever.** An edition (series + year) is confirmed once; later lookups read it from the database with zero network calls.
6. **Quota is a resource, not an error path.** The app tracks its own Gemini budget and parks a job with a retry time when capacity runs out. There is no fallback model cascade and no heuristic substitute.
7. **The lineup is a fact about the world; what you saw is a fact about you.** Canonical editions and your attendance are stored separately. "Artists I've seen" counts only sets you ticked.
8. **No hardcoded knowledge.** No lists of festivals, venues or artists in code. Fix a data source or add an adapter instead.

## Sources

Each source is an adapter in `src/server/lineup/adapters/` implementing `SourceAdapter.collect()`. An adapter returns stored documents, performer claims, fact claims and documents that need extraction. Adapters that are not configured are skipped and reported in the job log.

| Adapter | What it gives | Access | Evidence |
| --- | --- | --- | --- |
| `clashfinder` | Acts per edition with stage, day and set times; past years stay archived | Free account. Every call is signed with `authUsername` + `authPublicKey` (SHA-256 of username, private key and parameters) | `crowd` |
| `promoter` | Official lineup page text (Insomniac, Goldenvoice, ...); for past editions the Wayback Machine snapshot closest to the event dates | Public pages; no key | `billed` (after Gemini extraction) |
| `ticketmaster` | Canonical name, dates, venue and attractions for upcoming or recent events | Free Discovery API key, 5,000 calls/day | `billed` |
| `setlistfm` | Post-show setlists that upgrade an act to "performed" | Free non-commercial key | `performed` |
| MusicBrainz (`musicbrainz.ts`) | Stable artist IDs only, resolved in the background after you confirm | No key, 1 request/second | n/a |
| Web search (`search.ts`) | Candidate lineup URLs when every source came back empty: Brave Search API when `BRAVE_SEARCH_API_KEY` is set, otherwise Gemini grounded search (needs a billed Gemini project) | Brave free plan, or Gemini quota | Pages are fetched and extracted like any other; snippets are never evidence |

AXS is deliberately excluded: it has no public discovery API, and scraping it breaks its terms.

Clashfinder's event list is keyed by slug; the readable title is `desc` and `startDate` is Unix seconds. One edition often has several slugs (`edc2026`, `edclv2026`, a livestream clash), so the adapter takes the most-edited public clash whose title contains every word of the event name (or whose slug starts with them) and whose start date is in the year. Private clashes and fantasy or predicted lineups are skipped because they are guesses.

Promoters overwrite their lineup page for the next edition, so a past event never reads the live page unless you gave that URL yourself and no snapshot exists. The Clashfinder hash format could not be verified when the adapter was written; it is configurable through `CLASHFINDER_HASH_FORMAT`, and `CLASHFINDER_PUBLIC_KEY` accepts a ready-made key.

Job logs and errors are shown in the UI and stored, so credentials are redacted from them (`redactSecrets` and `redactUrl` in `http.ts`).

All HTTP goes through `createRateLimitedFetcher()` (`src/server/lineup/http.ts`), which spaces requests per host (MusicBrainz 1.1 s, Clashfinder 1 s, setlist.fm 0.6 s) and sends a User-Agent with `CONTACT_EMAIL`.

## Lookup pipeline

A lookup is a `LookupJob` that moves through stages, saving after each one (`src/server/lineup/pipeline.ts`).

1. **Create.** Input is plain fields: event name and year are required; dates, venue, city, lineup URL and notes are optional. The edition key is `series-slug/year`. If a confirmed edition exists, the job is ready for review immediately (`candidate.cached = true`).
2. **collect.** First wave (Clashfinder, promoter, Ticketmaster) runs in parallel. The second wave (setlist.fm) runs with dates and city filled in from the first. Every response is stored as a `SourceDocument`; every act as a `PerformerClaim`. A failing adapter is logged and does not stop the others.
3. **extract.** Each unstructured document (promoter or archived page) gets one Gemini call. The prompt includes one confirmed example from the same website when one exists. Names failing the verbatim check are dropped and counted in the log. Progress is saved per page, so a quota pause resumes where it stopped.
4. **discover.** Only when there are no claims at all: one web search (`"<event>" <year> lineup`). Up to 6 results are fetched; a page is kept only if its own text names every word of the event and the year, which drops other editions and unrelated pages. At most 3 kept pages go to extract. Brave is used when `BRAVE_SEARCH_API_KEY` is set and a Brave 429 parks the job until its reset; otherwise Gemini grounded search, which has no free-tier quota and is off in `wrangler.jsonc`.
5. **merge.** Claims are grouped by normalized name after applying learned aliases and the blocklist, then scored. Status becomes `needs_review`, or `no_data` if nothing was found.
6. **Review and confirm.** You accept, rename, reject (with a reason) or add acts, and tick what you saw. Confirmation writes the canonical edition, your attendance and the learning data, then queues MusicBrainz ID resolution.

Job statuses: `queued`, `running`, `waiting_quota`, `needs_review`, `no_data`, `confirmed`, `failed` (after 3 errors with backoff).

## Quota and the queue

- `QuotaLedger` (`src/server/lineup/quota.ts`) counts Gemini calls per model per Pacific day, against `GEMINI_DAILY_LIMIT` and `GEMINI_PER_MINUTE`. It refuses a call before it is made when the budget is spent.
- A Gemini 429 is parsed: a per-day quota parks the job until midnight Pacific; otherwise the job waits for the `retryDelay` Google returns (60 s if none).
- Parked jobs keep everything collected so far. Under Node, the worker (`LookupWorker` in `service.ts`) checks for due jobs every 20 seconds, one at a time. On Cloudflare a Cron Trigger sends due jobs to a Queue every minute and the queue consumer runs them one at a time (see Hosting). "Try now" in the UI retries immediately, past an earlier 429 pause but not past your own daily budget.

## Learning loops

Review is where the system improves (`src/server/lineup/learning.ts`). Nothing retrains a model; every decision becomes data the next lookup reads.

| Your action | What is stored | Effect on the next lookup |
| --- | --- | --- |
| Rename an act | `artist_aliases`: old spelling to your spelling, plus a `renamed` correction | Variants merge in code, no AI call |
| Reject as "not an act" | `extraction_blocklist` per site, plus a `rejected` correction | After 2 rejections on a site, that string is dropped before review |
| Reject as "wrong event" | `rejected` correction, source penalized | Source reliability drops |
| Reject as "cancelled" | Performance kept with status `cancelled` | Sources are not penalized for billing it |
| Accept | `source_stats` accepted count per source, per series and globally | Reliability rises; confidence uses measured accuracy (Beta prior, weight 10) |
| Add a missed act | `added` correction | Shows which sources miss acts |
| Confirm a Gemini-read page | `extraction_examples`: an excerpt plus the confirmed names, up to 3 per site | The next read of that site includes a worked example |
| Confirm with a lineup URL | `event_series.lineup_url` | Next year's lookup knows where to look |

Cached editions are not counted again in source stats. Every claim records its extractor and version (`gemini:<model>` plus `extract@1`), so claims from a bad model or prompt version can be found and re-checked later from the stored documents.

## Data model

Defined in [`supabase/migrations/0002_source_first_lineups.sql`](supabase/migrations/0002_source_first_lineups.sql). The local file store (`store/fileStore.ts`) implements the same `LineupStore` interface for development.

| Layer | Tables |
| --- | --- |
| Canonical | `event_series`, `event_editions` (unique `key`), `canonical_artists` (normalized key, optional MBID), `performances` (per edition and artist, with status, confidence and sources) |
| Evidence | `source_documents` (URL, hash, stored body), `performer_claims` (quoted span, extractor, version) |
| Operations | `lookup_jobs`, `quota_ledger` |
| Learning | `artist_aliases`, `extraction_blocklist`, `source_stats`, `corrections`, `extraction_examples` |
| Personal | `attendance`, `seen_sets` |

Store selection: Supabase when `SUPABASE_URL` is set and the migration has been applied; otherwise a JSON store under `DATA_DIR` (default `./data`). Set `LINEUP_STORE=file` to force the local store. The local store does not survive a redeploy, so use Supabase for real data. On Cloudflare the server refuses to start without Supabase.

The browser archive (`src/services/storage.ts`, localStorage) still powers the Archive, Telemetry and Sheets views. A confirmed edition is written there with only the sets you saw (`src/services/archive.ts`). Moving those views onto the server tables is the next step.

## API

| Method and path | Purpose |
| --- | --- |
| `GET /api/lineup/status` | Store kind, which sources are configured, Gemini model and today's usage |
| `POST /api/lookups` | Start a lookup; returns the job (already `needs_review` on a cache hit) |
| `GET /api/lookups`, `GET /api/lookups/:id` | Job list and detail with log and candidate lineup |
| `POST /api/lookups/:id/run` | Retry now |
| `POST /api/lookups/:id/confirm` | Save the reviewed lineup, attendance and learning data |
| `GET /api/editions` | Confirmed and draft editions |

## Hosting

The `/api` routes live in `src/server/app.ts` and take a `JobRunner` that starts a job without waiting for it. Two hosts wire them up:

| | Node (`server.ts`, `npm run dev`) | Cloudflare Worker (`worker/index.ts`, `wrangler.jsonc`) |
| --- | --- | --- |
| Frontend | Vite middleware in dev, `dist/` in production | Workers static assets from `dist/`, SPA fallback; only `/api/*` runs the Worker |
| API | Express | The same Express app, through `handleAsNodeRequest` from `cloudflare:node` (`nodejs_compat`) |
| Starting a job | `LookupWorker.kick` runs it in-process | A message on the `concert-tracker-lookups` Queue |
| Due and parked jobs | `setInterval` every 20 s | Cron Trigger every minute sends due jobs to the Queue |
| Store | Supabase, or the file store | Supabase only |
| Config | `.env` | `vars` in `wrangler.jsonc` plus `wrangler secret put` |

The queue consumer runs one message at a time (`max_concurrency: 1`), so the per-host spacing in `http.ts` still holds; the spacing lives in memory, so it is per isolate rather than global. Duplicate queue messages are harmless because `runJob` skips a job that is no longer `queued` or `waiting_quota`. A consumer killed mid-run (for example by the CPU limit on the Workers Free plan) leaves the job `running`; it does not resume on its own.

## Configuration

See [`.env.example`](.env.example). Each source is optional; the app reports which ones are off and works with whatever is configured.

## Testing

`npm test` runs the node test suite in `tests/`: verbatim checks, merging and scoring, each adapter against recorded responses, quota parsing, and the full pipeline including quota parking, review learning and the cache. `npm run lint` typechecks. Add a test with every new adapter or rule.

## Roadmap

- Move the Archive, Telemetry and Sheets views onto `attendance` and `seen_sets`, then retire the localStorage store.
- A weekly refresh job for editions that are upcoming or ended in the last 14 days, to pick up cancellations and additions.
- A regression command that re-runs extraction over stored documents and compares against confirmed lineups when the model or prompt changes.
- Per-series source priority editing in the UI (`event_series.source_priority` is already read by the merge step).
