# LiveArchive architecture

This is the source of truth for how LiveArchive captures events, finds lineups and stores what you have seen. Anyone changing the app, person or AI agent, should read it first and keep it current. What the app is for, and the principles behind it, are in [REQUIREMENTS.md](REQUIREMENTS.md); the rules an agent must follow are summarized in [AGENTS.md](AGENTS.md).

## Goal

You type one line about an event you went to. It is saved at once (stage 1), and the app looks up its date and place from structured sources, suggesting rather than overwriting. Later, whenever you like, you ask it to find who played (stage 2): it finds the lineup with a citation for every act, lets you confirm it and tick who you saw, and stores the result so the same edition never has to be looked up again. When an API has no capacity, the lookup waits in a queue. It never guesses.

## Two stages

| | Stage 1: the event | Stage 2: the lineup |
| --- | --- | --- |
| Started by | Typing a line and pressing Add, or ticking shows found in your ticket emails | "Find who played" on a saved event |
| Code | `src/server/events/` | `src/server/lineup/` |
| Sources | Ticketmaster, setlist.fm, Clashfinder, Brave web search and the event markup on the pages it found, your ticket emails (all read in code) | Clashfinder, promoter pages, Ticketmaster, setlist.fm, web search |
| Gemini | Never | Reads fetched pages |
| Runs | Inside the request, a few seconds | A background job (queue), can wait for quota |
| Stores | `logged_events` (your log) | Canonical edition, evidence, learning data; links the event to the edition |

Stage 2 never changes the event's date or place, and stage 1 never waits on stage 2.

## Invariants

These are enforced in code. A change that breaks one is a bug, even if the output looks more complete.

1. **No claim without evidence.** Every act in a lineup carries at least one source URL and the text it was found in (`PerformerClaim.quotedSpan`). Facts (dates, venue) carry their source too.
2. **Gemini is a reader, never a memory.** Gemini only extracts names from text the app fetched and stored. A name is kept only if its quoted span occurs in the stored page and the name occurs in the span (`isVerbatim` in `src/server/lineup/text.ts`).
3. **Confidence is computed, never asked for.** It comes from which sources agree and how often each source has been right in your reviews (`src/server/lineup/merge.ts`). No model is asked for a confidence score, a URL it did not find, or a date it was not shown.
4. **Empty is a valid answer.** If no source lists a lineup, the lookup ends as `no_data` and you enter acts by hand. There are no default dates, cities, venues, stages, ratings or setlists anywhere.
5. **Resolve once, reuse forever.** An edition (series plus date, or year when the date is unknown) is confirmed once; later lookups read it from the database with zero network calls.
6. **Quota is a resource, not an error path.** The app tracks its own Gemini budget and parks a job with a retry time when capacity runs out. There is no fallback model cascade and no heuristic substitute.
7. **The lineup is a fact about the world; what you saw is a fact about you.** Canonical editions and your event log are stored separately. "Artists" counts only acts you marked as seen.
8. **No hardcoded knowledge.** No lists of festivals, venues or artists in code. Fix a data source or add an adapter instead.
9. **Your word wins.** Stage 1 suggestions never overwrite a field you typed. Every event field records its source (`LoggedEvent.sources`): you, or a source URL.

## Stage 1: capture and details

1. **Parse** (`src/server/events/parse.ts`, shared with the browser for the live preview). The line is split in code: a date (`2024-10-05`, `10/5/24`, `Oct 5 2024`, `May 16-18, 2025`, `5 Oct 2024`, `October 2024`, or a bare year), then a place after ` at ` / `@` (venue, then city after a comma or ` in `) or after ` in ` (city). Whatever is left is the name. A year right after "the" is part of a name (The 1975), impossible dates are not dates, and nothing is filled in that you did not type.
2. **Save** (`POST /api/events`). The event is stored with what was parsed, each field sourced as `user`, details status `pending`.
3. **Research** (`POST /api/events/:id/details`, called by the browser right after saving; also "Look again"). Without a year, only the finders that can search all years run (web search and setlist.fm, `withoutYear`); a web result must then also name the venue (or city) you gave, and whatever they find is offered as `choose`, never applied (nothing found: `needs_date`). If the event was renamed after saving and the current name finds nothing, the name parsed from what you first typed is searched once. Each configured finder in `src/server/events/details.ts` searches a window around what you gave (the date ±1 day, the month, or the year):
   - Ticketmaster: listings whose name has every word you typed; a festival listed per day is grouped by name and venue into one start and end date.
   - setlist.fm: shows by an artist of exactly that name on the date (or in the year), with venue and city.
   - Clashfinder: the edition matched in its event list (same rule as the lineup adapter), giving the start date.
   - Brave web search (`braveFinder`, when `BRAVE_SEARCH_API_KEY` is set): one query (`"<name>" <date or month or year> <venue> <city>`). A result counts only if its title and description name every word of the event; every full date written there (`findDates` in `parse.ts`) inside the window becomes a candidate whose source keeps the quoted words. These snippets only confirm stage 1 dates; they are never lineup evidence.
   Candidates on the same start date are merged, each field keeping the source that gave it. A failing finder is noted and the others still count. Cities are written `City, ST` in the US and Canada (`cityLabel` in `src/server/events/place.ts`, from the region a source gives) and as the city elsewhere.
4. **Place from pages.** Search snippets give dates, not places. For the candidates that will be applied or shown, if a venue or city is missing, the pages that gave the date are fetched (at most 3 per research, never AXS) and their schema.org Event markup (`application/ld+json`) is read in code (`placeFromPage`): an event whose name or a performer has every word of yours, on a day the candidate covers, gives `location.name` as the venue and `addressLocality` plus `addressRegion` as the city. Several matching events at different places give nothing. The page is added as its own source for those fields, with the venue and city as the quote; it does not count as another date confirmation.
5. **Decide.** No candidates: `none`. If you gave a full date and one candidate covers it (or one covering candidate has more sources than any other): `matched`. The date is shown as confirmed with each source and quote, and the candidate fills only empty fields. Otherwise `choose`: up to 5 candidates wait for your pick (`POST /api/events/:id/details/pick`), which fills date and place from the candidate (the name stays yours), or for "None of these". Research never replaces a filled field; where the confirmed candidate differs from a saved field, the event view offers "Use … from <source>" under it, which takes just that field (`{ candidateId, fields }`).
6. **Edit** (`PATCH /api/events/:id`). Any field you change becomes a `user` source. In the event view, "Last day" shows the start date until you change it (so the date picker opens on the right month) and is stored only when it differs; venue and city suggest what you have entered on other events (picking a venue you always gave the same city for fills an empty city), and city also suggests places from the Open-Meteo geocoding API as you type (`GET /api/places/cities`, `citySuggestions`). Seen acts, companions, days attended, rating, ticket price and notes are edited the same way.

## Stage 1 from email

Ticket confirmation emails are a stage 1 source for back-filling past shows. They propose events; you decide which ones you went to. Code: `src/server/events/email/` and `src/server/events/importRoutes.ts`.

1. **Feed.** Something with access to your mail posts raw messages to `POST /api/imports/email` (`{ emails: [{ id, link?, from, sentAt, subject, html?, text? }] }`, at most 100 per call, `Authorization: Bearer <IMPORT_TOKEN>`). Today that is Claude, reading Gmail through this project's connector and searching ticket senders. The feeder only copies messages; it interprets nothing. Without `IMPORT_TOKEN` the route answers 503.
2. **Read** (`readEmails`). Each message goes to the reader for its sender's domain (`EmailReader` in `email/types.ts`; one file per seller: Ticketmaster, Tixr, DICE, Resident Advisor, Eventbrite (including its 2013 and 2015–2018 layouts), AXS, Front Gate). The HTML is turned into the lines you see when you open the email (`htmlToLines`), and the reader copies the name, date, venue, city, order number, ticket count and total from fixed positions in the seller's layout, each value with the words it came from. No Gemini. Mail a reader does not recognise (ads, reminders) is ignored; a message whose subject announces tickets but whose body does not fit the layout is kept as `unreadable`, so you can open it and type it in. Once a newer reader reads that same message into a show, the unreadable row is no longer listed (`reviewList`). Add a seller by adding a reader with a test, never by loosening an existing one. A ticket a friend transferred to you (AXS "You Received Tickets") is read like an order. Sellers that name the ticket after the show ("DJ_Dave - Artist Presale", "2025 EDC Las Vegas - 3-Day GA Experience Pass") give the part before the last " - " when that part names a ticket type (`withoutTicketType`); the quote keeps the full line.
3. **Dates** (`email/dates.ts`). Sellers often leave out the year ("Sat Aug 29, 10:00 PM"). The year is then the only one, from two days before the email was sent to a year after, in which that day falls on the weekday given. No weekday and no year: no date, and the words are shown as written. A weekday that disagrees with a stated year means no date. A night that ends before noon the next day is one event on its first day.
4. **Group** (`mergeImports`). Messages about one show become one row (`EmailImport`), keyed by normalized name plus start date, else seller plus order number. A message whose order number is already on a row for the same date joins that row even under another name (a Front Gate receipt says "Second Show Added!", its tickets "(Saturday)"). A later message fills only empty fields. Refund, cancellation and transfer messages add a flag to the row with the same seller and name whose latest order came before them (a club night sold under one name every month gets only its own refund); one that arrives before its order is kept aside (status `flag`, never listed) until the order is read. A row whose date and name (equal, or one containing the other) match an event already in your log is linked to it and not offered again.
5. **Review** (`ImportReview`, opened from "N events found in your email" on the Events view). Rows are grouped by year and start unticked, because a ticket is not proof you went. Shows still ahead are listed apart and come back once their date has passed. "Add" turns the ticked rows into events (`POST /api/imports/add`); "I didn't go" marks them skipped (`POST /api/imports/skip`, undoable).
6. **Save** (`eventFromImport`). The event gets the name, dates, venue and city from the row, each field sourced as `email` with the message link and the quoted words; details status `resolved` when dated, else `needs_date`. Personal fields (seen acts, rating, ticket price, companions, notes) stay empty, even though the email states a total.

## Importing a list

A list of past events you kept elsewhere (a Notion database export, a spreadsheet, this app's own CSV export) is your own record, so its fields count as typed by you, personal ones included. Code: `src/services/listImport.ts` and `src/components/ListImport.tsx`, opened from "Import a list" in the Table view. It runs in the browser and writes only through the existing routes; no model is involved and nothing is stored until you press Import.

1. **Read** (`readList`). Columns are mapped by header words (`Event`/`Name`, `Date`, `End date`, `Year`, `Venue`, `City`, `Country`, `Artist`/`Saw`, `Attendee`/`Went with`, `Rating`, `Ticket price`, `Notes`); others are listed as not imported. Dates are read only when full and unambiguous (`2024-05-17`, `May 17, 2024`, `17 May 2024`, and ranges joined by `→`, `–` or ` to `); anything else stays unread and is flagged. A row with no date takes the year written in its name, as capture does. `City ST` is written `City, ST`. List cells split on `;` when present, else `,`. Rows with the same name and date are combined into one.
2. **Flag, never fix.** Each row lists what looks wrong: a date it could not read, a name whose year differs from its date, a `?` between letters (a character the export lost, such as `K?D`), no date. The value stays as the file has it.
3. **Match** (`findMatches`), against your log and the open email review rows (status `new` or `skipped`, not yet linked). The same event is the email rule: the same start date and the same name or one containing the other; without dates, the same name and year. It is folded in by default. Another name on overlapping days ("EDC 2022" and "EDC Las Vegas") is offered as a possible match and the row waits until you choose same event, new event, or don't import.
4. **Merge** (`fillPatch`). Folding into an event fills only its empty fields and appends acts and people it does not list; nothing already there changes. A matching email row is first added through `POST /api/imports/add` (restored first if you had skipped it), so the event keeps the email's fields and links, then filled from the list.
5. **Save** (`runImport`). A new row is saved with `POST /api/events` (its name as the line) and then `PATCH /api/events/:id` with every field from the file, clearing whatever the capture parse read out of the name. Details research is not started; it can be run from the event. "Went with" names you mark as yourself are left out.

## Sources

Each source is an adapter in `src/server/lineup/adapters/` implementing `SourceAdapter.collect()`. An adapter returns stored documents, performer claims, fact claims and documents that need extraction. Adapters that are not configured are skipped and reported in the job log.

| Adapter | What it gives | Access | Evidence |
| --- | --- | --- | --- |
| `clashfinder` | Acts per edition with stage, day and set times; past years stay archived | Free account. Every call is signed with `authUsername` + `authPublicKey` (SHA-256 of username, private key and parameters) | `crowd` |
| `promoter` | Official lineup page text (Insomniac, Goldenvoice, ...); for past editions the Wayback Machine snapshot closest to the event dates | Public pages; no key | `billed` (after Gemini extraction) |
| `ticketmaster` | Canonical name, dates, venue and attractions for upcoming or recent events | Free Discovery API key, 5,000 calls/day | `billed` |
| `setlistfm` | Post-show setlists that upgrade an act to "performed" | Free non-commercial key | `performed` |
| MusicBrainz (`musicbrainz.ts`) | Stable artist IDs only, resolved in the background after you confirm | No key, 1 request/second | n/a |
| Web search (`search.ts`) | Stage 2: candidate lineup URLs when every source came back empty (stage 1 date checks are in `events/details.ts`): Brave Search API when `BRAVE_SEARCH_API_KEY` is set, otherwise Gemini grounded search (needs a billed Gemini project) | Brave free plan, or Gemini quota | Pages are fetched and extracted like any other; snippets are never evidence |

AXS is deliberately excluded as a lineup source: it has no public discovery API, and scraping it breaks its terms. Your own AXS ticket emails are read like any other seller's (stage 1 from email); nothing is fetched from AXS.

Clashfinder's event list is keyed by slug; the readable title is `desc` and `startDate` is Unix seconds. One edition often has several slugs (`edc2026`, `edclv2026`, a livestream clash), so the adapter takes the most-edited public clash whose title contains every word of the event name (or whose slug starts with them) and whose start date is in the year. Private clashes and fantasy or predicted lineups are skipped because they are guesses.

Promoters overwrite their lineup page for the next edition, so a past event never reads the live page unless you gave that URL yourself and no snapshot exists. The Clashfinder hash format could not be verified when the adapter was written; it is configurable through `CLASHFINDER_HASH_FORMAT`, and `CLASHFINDER_PUBLIC_KEY` accepts a ready-made key.

Job logs and errors are shown in the UI and stored, so credentials are redacted from them (`redactSecrets` and `redactUrl` in `http.ts`).

All HTTP goes through `createRateLimitedFetcher()` (`src/server/lineup/http.ts`), which spaces requests per host (MusicBrainz 1.1 s, Clashfinder 1 s, setlist.fm 0.6 s) and sends a User-Agent with `CONTACT_EMAIL`.

## Lookup pipeline

A lookup is a `LookupJob` that moves through stages, saving after each one (`src/server/lineup/pipeline.ts`).

1. **Create.** From the app, a lookup starts on a saved event (`POST /api/events/:id/lineup`): its name, year, dates, venue and city become the input, an optional lineup URL can be added, and the job keeps the event's id (`LookupJob.eventId`). Event name and year are required. The edition key is `series-slug/<start date>` when the date is known (an artist plays many nights a year, each with its own openers), otherwise `series-slug/year`. If a confirmed edition exists under that key, or under the year key with the same start date (editions confirmed before dates were part of the key), the job is ready for review immediately (`candidate.cached = true`).
2. **collect.** First wave (Clashfinder, promoter, Ticketmaster) runs in parallel. The second wave (setlist.fm) runs with dates and city filled in from the first. Every response is stored as a `SourceDocument`; every act as a `PerformerClaim`. A failing adapter is logged and does not stop the others.
3. **extract.** Each unstructured document (promoter or archived page) gets one Gemini call. The prompt includes one confirmed example from the same website when one exists. Names failing the verbatim check are dropped and counted in the log. Progress is saved per page, so a quota pause resumes where it stopped.
4. **discover.** Only when there are no claims at all: one web search (`"<event>" <year> lineup`). Up to 6 results are fetched; a page is kept only if its own text names every word of the event and the year, which drops other editions and unrelated pages. At most 3 kept pages go to extract. A result on the event's own domain (its host contains the event name run together, e.g. `sunsoaked.insomniac.com`) is read first and treated as a `promoter` source (also when an earlier run stored it as `discovered`); others are `discovered`. Confirming a lookup with such a page saves it as the series lineup URL, so the next lookup reads it directly. Aggregator pages can list other events' artists verbatim, so when two or more `discovered` pages were read, an act backed by only one of them is flagged for review (`merge.ts`). Brave is used when `BRAVE_SEARCH_API_KEY` is set and a Brave 429 parks the job until its reset; otherwise Gemini grounded search, which has no free-tier quota and is off in `wrangler.jsonc`.
5. **merge.** Claims are grouped by normalized name after applying learned aliases and the blocklist, then scored. Status becomes `needs_review`, or `no_data` if nothing was found.
6. **Review and confirm.** You accept, rename, reject (with a reason) or add acts, and tick who you saw; acts already marked as seen on the event start ticked. Confirmation writes the canonical edition (its facts default to the event's, with gaps filled from what the sources cited) and the learning data, links the event to the edition, and sets the event's seen acts to what you ticked plus any act you had added by hand that the lineup does not list (`mergeSeen` in `learning.ts`). It then queues MusicBrainz ID resolution.

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
| Confirm with a lineup URL, or with an accepted promoter page | `event_series.lineup_url` | Next year's lookup knows where to look |

Cached editions are not counted again in source stats. Every claim records its extractor and version (`gemini:<model>` plus `extract@4`; every page, the event's own site included, is told to keep only acts billed for that event and year and leave out other events, dates, cities and editions it lists), so claims from a bad model or prompt version can be found and re-checked later from the stored documents.

## Data model

Defined in [`supabase/migrations/0002_source_first_lineups.sql`](supabase/migrations/0002_source_first_lineups.sql) and [`0003_event_log.sql`](supabase/migrations/0003_event_log.sql); both must be applied (the server checks one table from each at start). [`0004_email_imports.sql`](supabase/migrations/0004_email_imports.sql) is needed only for email import; without it the rest of the app works and the import routes fail. The local file store (`store/fileStore.ts`) implements the same `LineupStore` interface for development.

| Layer | Tables |
| --- | --- |
| Canonical | `event_series`, `event_editions` (unique `key`), `canonical_artists` (normalized key, optional MBID), `performances` (per edition and artist, with status, confidence and sources) |
| Evidence | `source_documents` (URL, hash, stored body), `performer_claims` (quoted span, extractor, version) |
| Operations | `lookup_jobs`, `quota_ledger` |
| Learning | `artist_aliases`, `extraction_blocklist`, `source_stats`, `corrections`, `extraction_examples` |
| Personal | `logged_events` (one row per event you went to: fields, field sources, details research, lineup job and edition links, seen acts, companions, days, rating, price, notes). `attendance` and `seen_sets` from 0002 are no longer written; [`0003_event_log.sql`](supabase/migrations/0003_event_log.sql) copies them into `logged_events`. |
| Import | `email_imports` (one row per show found in your ticket emails: status, read fields with their quotes and message links, flags, the event it became). Proposals only; never read as part of your log. |

Store selection: Supabase when `SUPABASE_URL` is set and the migration has been applied; otherwise a JSON store under `DATA_DIR` (default `./data`). Set `LINEUP_STORE=file` to force the local store. The local store does not survive a redeploy, so use Supabase for real data. On Cloudflare the server refuses to start without Supabase.

The browser keeps nothing: every view reads the server. The interface is one page (`src/App.tsx`): the capture line and a summary of your log (`CaptureBar`, `EventsHome`, worked out in `src/services/home.ts`), an event panel for details, seen acts, the lineup and your notes (`EventDetail`, `LineupReview`), the Table view (`TableView`), and the Artists view (`ArtistsView`). The Table view filters, sorts and summarizes the same event list in the browser (`src/services/table.ts`), keeps its filters in the address (`?view=table&...`), and holds the CSV export, built from the rows it shows (`src/services/format.ts`). Apart from "Import a list" (see Importing a list) it reads nothing beyond `GET /api/events` and writes nothing. The Stats view (`StatsView`, worked out in `src/services/stats.ts`) is read-only over the same list too; its bars and rankings open the Table with matching filters.

## API

| Method and path | Purpose |
| --- | --- |
| `GET /api/events` | Your events, newest first, plus a summary of each one's lineup lookup |
| `POST /api/events` | Save one typed line as an event (`{ text }`) |
| `GET /api/events/:id` | The event with its lineup job and confirmed edition |
| `PATCH /api/events/:id`, `DELETE /api/events/:id` | Edit or delete an event |
| `POST /api/events/:id/details` | Run stage 1 research |
| `POST /api/events/:id/details/pick` | Pick a suggestion (`{ candidateId }`) or dismiss them (`{}`) |
| `POST /api/events/:id/lineup` | Start stage 2 for the event (`{ lineupUrl? }`) |
| `POST /api/imports/email` | Read ticket emails into review rows (needs `IMPORT_TOKEN`); returns counts read, unreadable, ignored and changed |
| `GET /api/imports` | Review rows from your email, newest first |
| `POST /api/imports/add` | Add the ticked rows as events (`{ ids }`); rows already in your log or still ahead are not added |
| `POST /api/imports/skip` | Mark rows as not attended (`{ ids }`), or put them back (`{ ids, restore: true }`) |
| `GET /api/places/cities?q=` | City suggestions as `City, ST` (Open-Meteo geocoding, cached in memory) |
| `GET /api/lineup/status` | Store kind, which sources are configured, Gemini model and today's usage |
| `POST /api/lookups` | Start a lookup without an event (kept for scripts); returns the job (already `needs_review` on a cache hit) |
| `GET /api/lookups`, `GET /api/lookups/:id` | Job list and detail with log and candidate lineup |
| `POST /api/lookups/:id/run` | Retry now |
| `POST /api/lookups/:id/confirm` | Save the reviewed lineup and learning data, and the event's seen acts |
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

Workers Builds (the GitHub-connected build) deploys pull requests with `wrangler preview`, which reads the `previews` block in `wrangler.jsonc`. Previews get the plain settings but no secrets, so their API answers "not configured" and they never touch the Supabase data or start jobs.

The queue consumer runs one message at a time (`max_concurrency: 1`), so the per-host spacing in `http.ts` still holds; the spacing lives in memory, so it is per isolate rather than global. Duplicate queue messages are harmless because `runJob` skips a job that is no longer `queued` or `waiting_quota`. A consumer killed mid-run (for example by the CPU limit on the Workers Free plan) leaves the job `running`; it does not resume on its own.

## Configuration

See [`.env.example`](.env.example). Each source is optional; the app reports which ones are off and works with whatever is configured. `IMPORT_TOKEN` turns on posting ticket emails; it is a secret (`wrangler secret put IMPORT_TOKEN` on Cloudflare).

## Testing

`npm test` runs the node test suite in `tests/`: capture parsing, stage 1 research and its rules (`events.test.ts`), email readers, the year rule, grouping and the import routes (`email.test.ts`), list import reading, matching and merging (`listImport.test.ts`), verbatim checks, merging and scoring, each adapter against recorded responses, quota parsing, and the full pipeline including quota parking, review learning and the cache. `npm run lint` typechecks. Add a test with every new adapter or rule.

## Roadmap

- Stage 2 strategies per kind of event: for single-artist shows, openers from the venue's or promoter's event page and setlist.fm on that date; for festivals, today's pipeline.
- Ideas ranked in REQUIREMENTS.md section 13 (artist pages, back-fill mode, setlists, share card).
- A weekly refresh job for editions that are upcoming or ended in the last 14 days, to pick up cancellations and additions.
- A regression command that re-runs extraction over stored documents and compares against confirmed lineups when the model or prompt changes.
- In the Table view: bulk edit of personal fields, merging spellings of venues, cities and companions, and sheet sync. Each writes through the existing event routes; none changes capture or lookup.
- Per-series source priority editing in the UI (`event_series.source_priority` is already read by the merge step).
