# Tier 3 Engineering Excellence: build specs

> **Status:** TECH-04 and FETCH-01 built (PRs #229, #233). The other tickets are not started. Written 2026-11-03; where this file and `docs/engineering-ticket-bank.md` disagree, this file wins.
> **Basis:** Every fact was checked against `origin/main` at `8ea4a71` (2026-11-03). The review behind it: [Tier 3 deep dive](https://claude.ai/artifact/UWKAnHqfgH1kM9awt4wEVa).
> **Decisions accepted by Charlie (2026-11-03):** stay on Workers Free; TECH-01 output must stay byte-identical; commit the RLS migrations as applied, and drop legacy tables only after a row count; store the Clashfinder index in Workers KV.

---

## 0. Read this first (every agent, every ticket)

**Rules that apply to every ticket**
1. Read `REQUIREMENTS.md`, `ARCHITECTURE.md`, `AGENTS.md` and `.spec/EXTERNAL_AGENT_RULES.md` before changing anything. `AGENTS.md` wins over this file if they ever disagree.
2. One ticket per branch, cut from a fresh `main`. Never build on `antigravity/tier3-tickets`: it is 20+ commits behind `main`.
3. Run `npm run lint` and `npm test` before every commit. Add tests for every new rule.
4. Update `ARCHITECTURE.md` in the same PR whenever behaviour described there changes.
5. Never apply a migration to the live database or deploy. Charlie does both himself.
6. Line numbers in this file are from `8ea4a71`. Find code by symbol name, not by line number.
7. **Migration numbers:** `main` already has 0029 and 0030. This plan reserves **0031** for TECH-03 and **0032** for SEC-03 step 4. Before you create a migration, check `supabase/migrations/` and stop if your number is taken.
8. Never commit unless the ticket says so, and stop to ask Charlie when a step says **Needs Charlie**.

**Facts the specs rely on (verified on `main`)**
- **Platform:** Workers Free allows 50 external subrequests per invocation (Supabase calls included) and 1,000 calls to Cloudflare services (KV, Queues). Each redirect hop counts as one subrequest. CPU is 10 ms per invocation. Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests), [2026-02-11 change](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/).
- **The limit error is catchable.** A fetch past the limit throws `Error: Too many subrequests.`. The danger is that every later call fails too, including the save in the error handler (the 2026-10-21 incident).
- **Shared objects:** `createDeps` (`src/server/lineup/service.ts`) builds one fetcher per deps object, and `worker/index.ts` `getDeps` caches deps once per isolate. `getSupabaseClient` (`src/server/supabase.ts`) caches one client. Concurrent requests share all of these, so per-invocation state must not live on them.
- **AsyncLocalStorage already works here:** `src/server/auth/requestScope.ts` uses it, with `nodejs_compat` on.
- **Stage 2 already runs one stage per queue message:** `runJob(deps, id, { oneStep: true })`, and the worker re-sends while the job is `queued` with no `nextAttemptAt`.
- **`htmlToText` output is the stored document body** (`promoter.ts` collect, `pipeline.ts` `stageDiscover`). `putDocument` dedupes on `(url, contentHash)`, and the extraction cache keys on document id. Changed output means new documents and new Gemini calls.
- **Job fields are columns:** `lookup_jobs.pending_extraction jsonb` and `discovery_done boolean` (0002), mapped in `supabaseStore.ts` `jobToRow`/`rowToJob`.

---

## 1. Build order

| # | Ticket | Depends on | Touches | Priority |
| --- | --- | --- | --- | --- |
| 1 | TECH-04 In-memory test dispatcher | none | `tests/` only | P2 |
| 2 | FETCH-01 Budgeted fetcher (new) | none | `http.ts`, `types.ts`, `supabase.ts`, `requestScope.ts`, `service.ts`, `worker/index.ts`, routes | P1 |
| 3 | TECH-03 Stage 2 budget | FETCH-01 | `pipeline.ts`, store, migration 0031 | P1 |
| 4 | PERF-03 Stage 1 budget | FETCH-01 | `details.ts`, `detailsGemini.ts`, `events/routes.ts` | P2 |
| 5 | REL-02A Golden text fixtures | none | `tests/fixtures/`, a new test | P1 (gates 6) |
| 6 | TECH-01 Fast HTML-to-text | REL-02A | `text.ts` | P1 |
| 7 | PERF-04 Clashfinder index in KV | FETCH-01 | new module, `clashfinder.ts`, `details.ts`, `wrangler.jsonc` | P2 |
| 8 | TECH-02 Adapter types | 3, 4, 7 merged | adapters, `details.ts`, `weather.ts`, `place.ts` | P3 |
| 9 | SEC-04 Rate limits | FETCH-01 | `worker/index.ts`, app routes, `wrangler.jsonc`, detail view message | P3 |
| 10 | REF-02 Split the event detail view | 9 merged | `src/components/EventDetail.tsx`, new `src/components/event-detail/` | P2 |
| 11 | REL-02B Live regression run | 6 | `scripts/` | P3 |
| 12 | LINEUP-05 Edition re-sync | Charlie's decision | blocked | P2 |

**Parallel lanes** (no shared files with the server work, so they can run at any time): **SEC-03** (database), **PERF-05** (front end). **PERF-02** stays deferred and is not specified here.

---

## 2. Specs

### TECH-04: In-memory request dispatcher for integration tests

**Goal:** integration tests send requests to the Express app in memory, with no TCP socket, so they pass in sandboxes that refuse loopback (`connect EPERM`).

**Files:** new `tests/helpers/testApp.ts`. The 12 files that call `listen(0)`: `accessGate`, `accessRequests`, `allRoutes`, `email`, `memberSheets`, `mergeImport`, `multiUserStore`, `prefs`, `scan`, `shareApi`, `sheets`, `vaultPeople` (all `tests/*.test.ts`).

**Steps**
1. Write `dispatch(app, { method?, url, headers?, body? }): Promise<{ status, headers, body, json<T>() }>` with no new dependency (no `supertest`). Build an `http.IncomingMessage` on a `stream.PassThrough` socket stand-in, and an `http.ServerResponse` that collects its writes. Call `app(req, res)` and resolve on the response's `finish` event.
2. Send a string body as is. Send an object as JSON with `content-type: application/json` and `content-length`. Keep header names lowercase, and support repeated `set-cookie` values.
3. Collect binary bodies as `Buffer` and expose `body` as a UTF-8 string. Check how CSV export and any streamed endpoint behave under `dispatch`.
4. Migrate `shareApi` and `sheets` first and run the suite. Then migrate the other 10.
5. Remove the `listen`/`close` helpers that are no longer used.

**Acceptance**
- `git grep "listen(0" -- tests` returns nothing.
- `npm test` passes, with the same test count as before the change.
- A new `tests/testApp.test.ts` covers status, a JSON body, a header round trip, a cookie and a 404 through the app's error middleware.

**Invariants:** no production code changes. Express routing and error middleware run unchanged.

**Out of scope:** making `dispatch` imitate `worker/index.ts`. The Worker bridge has its own tests.

---

### FETCH-01: Budgeted fetcher (new foundation ticket)

**Goal:** every invocation (one HTTP request, one queue message, one cron run) has its own subrequest budget. The budget counts external fetches and Supabase calls. When only the reserve is left it refuses further calls with a typed error, so the job's final save always has room. Redirects and response size are handled in one place.

**Files:** new `src/server/lineup/budget.ts`. Also `src/server/lineup/http.ts`, `src/server/lineup/types.ts`, `src/server/supabase.ts`, `src/server/auth/requestScope.ts`, `worker/index.ts`, `src/server/app.ts` (or wherever the Express middleware is mounted), and `ARCHITECTURE.md`.

**Design**
- `budget.ts` exports:
  - `class BudgetExhausted extends Error { used; limit }`
  - `interface Budget { limit: number; reserve: number; used: number; take(n = 1, opts?: { reserved?: boolean }): void }`. `take` is synchronous and throws `BudgetExhausted` when `used + n > limit - reserve`, unless `reserved` is set. A reserved take may use the reserve, but never more than `limit`.
  - `runWithBudget<T>(budget, fn: () => Promise<T>): Promise<T>`, using one module-level `AsyncLocalStorage<Budget>`.
  - `currentBudget(): Budget | undefined`.
  - `countingFetch: typeof fetch`, which calls `currentBudget()?.take()` and then `fetch`.
  - Defaults: `limit = 50`, `reserve = 4`. Read `SUBREQUEST_LIMIT` from env if set (for tests, and a future Paid plan).
- **Outside any budget nothing is counted** (local Node, scripts, tests that don't opt in). That keeps today's behaviour for `npm run dev`.
- **Supabase:** pass `global: { fetch: countingFetch }` to `createClient` in `getSupabaseClient` and in `requestScope.ts` (keep its `headers`). Do not create any other Supabase client without it.
- **Fetcher (`createRateLimitedFetcher`):**
  1. Call `currentBudget()?.take()` before every attempt and every redirect hop.
  2. Use `redirect: 'manual'`. Follow at most 3 hops, running `assertPublicHttpUrl` on each `Location`, resolved against the current URL. Return the final URL as `FetchResponse.url`. A fourth redirect throws `Too many redirects for <host>`.
  3. Add `maxBytes?: number` to the `Fetcher.get` init (default 3 MB = 3,145,728). Reject at once when `content-length` is larger. Otherwise read `res.body` with a reader and stop reading at the cap. Cancel the stream and return the first `maxBytes` bytes decoded as UTF-8, with `truncated: true` on `FetchResponse`. Callers may raise or lower `maxBytes`.
  4. Rate-limit waits and retries keep their current behaviour. A retry charges the budget again.
- **Where budgets start:**
  - `worker/index.ts` `queue`: wrap each message's `runJob` in `runWithBudget(new budget)`. Do the error-path `getJob`/`updateJob` with `take(1, { reserved: true })`, through `runWithBudget` on the same budget.
  - `worker/index.ts` `scheduled`: one budget around the whole cron run.
  - HTTP: an Express middleware mounted first on `/api` wraps `next()` in `runWithBudget(new budget)`. Express runs inside the Worker's fetch, so one budget per request is correct.
- **`runJob` (`pipeline.ts`):** its last `updateJob` (after the try/catch) uses the reserve: wrap it so a `BudgetExhausted` cannot stop the job being saved. TECH-03 adds the rest.

**Acceptance (new `tests/budget.test.ts`)**
- `take` throws at `limit - reserve` and a reserved take succeeds up to `limit`.
- Two `runWithBudget` calls running at the same time count separately.
- The fetcher charges 1 per attempt and 1 per redirect hop. It refuses a redirect to `127.0.0.1`. It stops after 3 hops. It returns the final URL.
- A body over `maxBytes` comes back cut to `maxBytes` with `truncated: true`. A `content-length` over the cap is refused without reading the body.
- Supabase calls made through `countingFetch` are counted (stub `fetch`).
- Outside a budget, nothing is counted and nothing throws.
- `npm test` passes unchanged otherwise.

**Invariants:** the per-host intervals in `HOST_INTERVAL_MS` stay (MusicBrainz 1.5 s, Clashfinder 1 s). URL redaction stays. AXS is never fetched.

**Docs:** add a "Subrequest budget" paragraph to `ARCHITECTURE.md`: the limit, the reserve, where budgets start, and manual redirects.

---

### TECH-03: Stage 2 pipeline budget

**Depends on:** FETCH-01.

**Goal:** a queue message never goes over 50 subrequests. When the budget runs low in the middle of a stage, the job saves its progress and carries on in the next message. It does not fail, and it does not skip work.

**Files:** `src/server/lineup/pipeline.ts`, `src/server/lineup/types.ts` (`LookupJob`), `src/server/lineup/store/supabaseStore.ts` and `fileStore.ts`, new `supabase/migrations/0031_lookup_discover_queue.sql`, `tests/pipeline.test.ts`, `ARCHITECTURE.md`.

**Steps**
1. **Migration 0031:** `alter table lookup_jobs add column if not exists discover_queue jsonb not null default '[]'::jsonb;`. Map it as `discoverQueue: string[]` in `jobToRow`/`rowToJob` and in the file store. **Needs Charlie** to apply it before deploy. Code must treat a missing column value as `[]`.
2. **Page `stageDiscover`** the way `stageExtract` already works:
   - First call (when `discoverQueue` is empty and `discoveryDone` is false): run the search, order the URLs as today (event domain first), keep the first `SEARCH_RESULTS_TO_TRY` (6), store them in `discoverQueue`, set `discoveryDone = true`, and return with `stage` still `discover`.
   - Later calls: shift URLs off `discoverQueue` and fetch them one at a time, with the current rules (HTTP 200, `pageMentionsEvent`, `putDocument`, push to `pendingExtraction`). Stop when `SEARCH_PAGES_TO_READ` (3) pages are read or the queue is empty. Track pages read in the job (count the `pendingExtraction` additions made by discover, or add `discoverRead: number` in the same migration). Then set `stage = 'extract'`.
   - Never jump to `merge` to save calls.
3. **`runResolveArtists`:** loop over the pending artists. Before each one, check that the budget can take 2 calls (one MusicBrainz fetch, one upsert) plus the 2 calls needed afterwards (`listUnresolvedArtists(1)` and the final save). If it can't, stop the loop. Keep `ARTISTS_PER_RESOLVE_RUN` as the upper bound. The existing "remaining" check re-queues the job.
4. **`runJob` catch path:** add a branch for `BudgetExhausted` before the generic error branch. Set `status = 'queued'`, leave `attempts` and `nextAttemptAt` alone, and log `Paused to stay within the request limit; continuing.`. The worker's existing re-send picks the job up.
5. **Parallel adapters:** `runAdapters` uses `Promise.allSettled`. A `BudgetExhausted` from one adapter becomes a rejected result and is logged today as "failed". Change that: if any adapter rejected with `BudgetExhausted`, rethrow it after persisting the fulfilled results, so the stage runs again next message. Adapters must be safe to re-run, since `putDocument` dedupes and claims are per job: check that re-running `stageCollect` does not duplicate claims, and add a guard if it does.

**Acceptance (`tests/pipeline.test.ts`, with a stub fetcher, the file store and `runWithBudget`)**
- A discover job with 6 URLs and a budget too small for all 3 page reads finishes over several `oneStep` calls. It reads the same 3 pages as with an unlimited budget, and no call throws past the reserve.
- A resolve run with 20 pending artists and a 50-call budget stops early, saves, and leaves the job `queued`. A second run continues.
- `BudgetExhausted` leaves `attempts` unchanged and `status = 'queued'`.
- The final `updateJob` runs even when the budget is at its reserve.
- Re-running `stageCollect` after a budget stop does not duplicate claims.
- Existing pipeline tests pass.

**Invariants:** a job's status changes only inside `runJob`. One stage per message. Quota errors still park the job. Missing data stays missing.

---

### PERF-03: Stage 1 research budget

**Depends on:** FETCH-01.

**Goal:** `POST /api/events/:id/details` never goes over the limit, and always returns a valid (possibly partial) result instead of a 500.

**Facts:** the code-based worst case is about 14 external calls plus redirects. That is 4 finders (Ticketmaster, setlist.fm, Clashfinder, Brave), repeated once with the typed name, plus up to 3 Gemini reader pages (`MAX_GEMINI_PAGES`) and up to 3 place pages (`MAX_PLACE_PAGES`), plus the route's own Supabase calls. Don't add a separate 18-call cap: the request budget from FETCH-01 is the cap.

**Files:** `src/server/events/details.ts`, `src/server/events/detailsGemini.ts`, `src/server/events/routes.ts` (the `/events/:id/details` handler), `tests/details*.test.ts`, `ARCHITECTURE.md`.

**Steps**
1. Order of cuts when the budget runs low. Finders (the structured sources, run in parallel) are never cut. Then the typed-name retry. Then the Gemini reader pages. Then `addPlaces` pages last.
2. In `addPlaces` and the Gemini reader's page loop, catch `BudgetExhausted`, stop the loop, and add one note to `details.notes`: `Stopped early to stay within limits; press Look again to try the rest.`. A finder that throws `BudgetExhausted` is treated like a failed finder, with the same note.
3. In the route, save the event using the reserve (`take(1, { reserved: true })`, through a small helper from FETCH-01), so the result is stored even when research used up the budget.
4. No new response flag. The note is enough, and the UI already shows `details.notes`.

**Acceptance**
- With stub finders and a budget of 12, `researchEvent` returns `status` `matched`, `choose` or `none` with the stop note, and never throws `BudgetExhausted`.
- With an unlimited budget, results are identical to today on the existing tests.
- The route stores the event when research hit the budget.

**Invariants:** Stage 1 never calls Gemini except on "Look again with Gemini". Results never overwrite fields you typed. An empty result is valid.

---

### REL-02A: Golden fixtures for HTML-to-text

**Goal:** lock today's `htmlToText` and `lineupWindow` output on real festival pages, so TECH-01 can prove it changed nothing.

**Files:** new `tests/fixtures/html/` (raw pages) and `tests/fixtures/html/*.expected.txt`, new `tests/htmlToTextGolden.test.ts`, a one-off script `scripts/snapshot-html-text.ts`.

**Steps**
1. Collect 6 to 8 raw HTML pages already referenced in the project, or saved by hand from public sites (no AXS). Include: a promoter page with a server-rendered lineup, a Next.js page whose lineup is only in `__NEXT_DATA__`, a page with JSON-LD events, a Wayback snapshot, a page over 1 MB with inline SVG, a page with an unclosed `<script>` and a page with `<nav>`, `<header>` and `<footer>` around the lineup. Add a synthetic page with 2,000 unclosed `<svg` openers. Keep the total under 10 MB. Note each page's source URL and fetch date in a `README.md` beside them.
2. The script runs today's `htmlToText` on each page and writes `<name>.expected.txt`. It also writes `lineupWindow(text, 40000)` (the `MAX_DOC_CHARS` that `gemini.ts` uses) to `<name>.window.expected.txt`. Commit the outputs made with the **current** code.
3. The test runs `htmlToText` and `lineupWindow` on each page and asserts byte equality with the expected files.

**Acceptance:** the test passes on `main` before TECH-01. A one-character change to `htmlToText` makes it fail.

---

### TECH-01: Fast HTML-to-text (byte-identical)

**Depends on:** REL-02A merged.

**Goal:** `htmlToText` runs in under 10 ms on a 2 MB page (today: about 68 ms in Node 22) and produces **exactly** the same output as today.

**Finding behind it:** the 8 block regexes are not the cost (3.4 ms of 68 ms on 2 MB), and an unclosed tag does not slow them down. The cost is the generic tag strip (about 16 ms) and line clean-up (about 29 ms). One quadratic case exists: thousands of unclosed openers (about 926 ms for 2,000).

**Files:** `src/server/lineup/text.ts`, a new `tests/htmlToTextPerf.test.ts`.

**Steps**
1. Replace the body of `htmlToText` with a single scanner driven by `indexOf`:
   - Jump to each `<`. Read the tag name. For the skip tags (`script`, `style`, `noscript`, `nav`, `header`, `footer`, `dialog`, `svg`), find the closer with a case-insensitive search starting after the opener.
   - **Copy today's semantics exactly**, including these quirks: the opener matches by prefix (`<nav` also matches `<navbar`, `<header` also matches `<headerx`). The closer is the first `</name>` after the opener, with no nesting. With no closer, the opener stays in the text and is removed by the generic tag strip later, so the text after it is kept. The order of the 8 passes matters where skip regions overlap. Reproduce it, or prove with fixtures that a single pass gives the same result.
   - Line-break tags (`br`, `/p`, `/li`, `/h1`-`/h6`, `/div`, `/tr`) become `\n`, and all other tags become a space, as now.
   - Push text slices to an array and `join` once. Then run `decodeEntities`, whitespace collapse and the empty-line filter in one pass over the lines.
2. JSON scripts: keep extracting `application/json` and `application/ld+json` script bodies from the **whole** input before stripping, as now, using the same scanner. Skip a body larger than 2 MB (a size guard, not a change for the fixtures; confirm that none hits it).
3. Don't cut the raw input. The 3 MB fetch cap from FETCH-01 bounds it.
4. Don't change `decodeEntities`, `collectStrings`, `lineupWindow`, `isVerbatim` or `normalizeName`.

**Acceptance**
- The REL-02A golden test passes byte for byte, unchanged.
- `tests/lineupWindow.test.ts` and all text tests pass.
- Perf test: 2 MB of plain markup runs in under 15 ms (the median of 5 runs, with a generous bound for CI). The 2,000-unclosed-openers page runs in under 50 ms.
- No new dependency (no DOM parser).

**Out of scope:** fixing the prefix quirks. If wanted later, do it in its own PR, with new expected files and Charlie's go, since it re-hashes stored pages.

---

### PERF-04: Clashfinder index in Workers KV

**Depends on:** FETCH-01. **Needs Charlie** first: create a KV namespace (Cloudflare dashboard: Storage & Databases, KV, Create, named `concert-tracker-cache`) and send the agent its id.

**Goal:** both callers of `all.json`, Stage 1 (`clashfinderFinder` in `details.ts`, while you wait) and Stage 2 (`clashfinderAdapter`), read a compact index from KV. The multi-MB download and parse then happen at most once a day.

**Files:** new `src/server/lineup/clashfinderIndex.ts`, `src/server/lineup/adapters/clashfinder.ts`, `src/server/events/details.ts`, `wrangler.jsonc` (`kv_namespaces` binding `CACHE`), the `Env` type in `worker/index.ts`, tests, `ARCHITECTURE.md`.

**Steps**
1. **Check Clashfinder's terms** on keeping its data for 24 hours. If caching isn't allowed, stop and report to Charlie. Record the finding in the `responseCache.ts` comment on which hosts may be cached.
2. `clashfinderIndex(fetcher, now)` returns `EventListEntry[]` (the same shape `parseEventList` returns). Look up in order:
   1. An isolate memo, if under 24 hours old.
   2. KV key `clashfinder:index:v1`, if under 24 hours old (store `{ fetchedAt, entries }`, with `expirationTtl` 2 days).
   3. The network: `all.json` with `timeoutMs: 10000` and `maxBytes: 10 MB`, then `parseEventList`, keeping only the fields `matchEdition` needs. Write the result to KV and the memo.
3. **Keep all years.** Users log shows from long ago, so prune fields, never editions.
4. When the fetch fails, times out, is over 10 MB (`truncated` or refused) or does not parse, use a stale KV copy if there is one. Otherwise return `[]` and let the caller add the note `Clashfinder: event list unavailable.`. Never throw out of the index.
5. Without the `CACHE` binding (local Node, tests), use the memo and the network only.
6. Replace both direct `all.json` fetches with `clashfinderIndex`. Keep the 1 request per second interval for `clashfinder.com`.
7. Don't search the raw JSON text as a shortcut: `matchEdition` uses stopwords, weekend numbers and date windows, and JSON escapes break substring matching.

**Acceptance**
- Two lookups within 24 hours make one network call (stub fetcher plus an in-memory KV stub).
- An oversize, timed-out or unparseable response returns a stale copy or `[]` with the note, and no exception.
- A 2015 edition is still found.
- `details.ts` and the adapter return the same matches as before on the existing tests.
- Record in the PR the size of the KV value against today's real `all.json`, measured by Charlie or with the keys.

**Invariants:** missing data stays missing. Clashfinder stays at 1 request per second. The job never fails because Clashfinder is down.

---

### TECH-02: Strict types for source adapters

**Depends on:** TECH-03, PERF-03 and PERF-04 merged (same files).

**Goal:** no `any` on external API data. Payloads are read as `unknown` and narrowed with small guards.

**Files:** new `src/server/guards.ts` (shared by `lineup/` and `events/`, so it lives in neither): `isRecord`, `isString`, `isNumber`, `isArray`, `str(v)` (a string or undefined), `arr(v)` (an array or `[]`). Plus `adapters/clashfinder.ts` (`read`, `parseEventData`), `events/details.ts` (Ticketmaster, setlist.fm, Brave), `events/weather.ts`, `events/place.ts`, and anything else `git grep -n "any>" -- src/server` finds.

**Steps**
1. Change `parseJson<T>` to default to `unknown`, and remove every `parseJson<any>`.
2. For each API, write a narrow reader that pulls only the fields the code uses. Don't model the whole API. Unknown or wrong-typed fields become `undefined` and the item is skipped, never thrown.
3. When a whole payload has the wrong shape (for example `_embedded.events` is not an array), the finder or adapter returns no results plus a note naming the source. A shape problem must never fail a job or a request.

**Acceptance:** `git grep -nE "<any>|: any\b" -- src/server` finds nothing in these files. A new `tests/guards.test.ts` feeds each reader `null`, `{}`, a wrong-typed field and a real sample, and gets an empty or partial result with no throw. Lint and tests pass. No new dependency (no Zod).

---

### SEC-04: Rate limits on public and research endpoints

**Depends on:** FETCH-01. **Needs Charlie:** none for the code. The binding deploys with the Worker.

**Goal:** stop a looping or scripted client from flooding outbound research, lineup lookups or access-request emails.

**Facts:** `/api/*` sits behind Cloudflare Access (Google login), and access requests already have a pending cap of 20. Rate limits per isolate in memory reset when isolates change, so they barely slow a scripted client. Use Cloudflare's rate-limit binding instead ([docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)). It counts per Cloudflare location, allows periods of only 10 or 60 seconds, and calls to it count against the 1,000 Cloudflare-services limit, not the 50.

**Files:** `wrangler.jsonc` (`ratelimits`), the `Env` type, `worker/index.ts` (pass the bindings into the app), a new `src/server/rateLimit.ts` middleware, `src/server/auth/requestRoutes.ts`, `src/server/events/routes.ts`, the detail view's research and lineup buttons, tests, `ARCHITECTURE.md`.

**Steps**
1. Add three bindings with unique `namespace_id`s:
   - `RL_ACCESS`: 3 per 60 s for `POST /api/access-requests`, keyed by the Access email (fall back to `cf-connecting-ip`).
   - `RL_RESEARCH`: 10 per 60 s, shared by `POST /api/events/:id/details` and `POST /api/events/:id/lineup`, keyed by member id (owner: `owner`).
   - `RL_WRITE`: 60 per 60 s for event create, update and delete, keyed by member id.
2. The middleware calls `limit({ key })`. When it fails, it returns 429 with `Retry-After: 60` and `{ error: 'Too many requests. Try again in a minute.' }`.
3. With no binding present (local Node, tests), allow everything. Never limit the queue consumer or cron, since they don't pass through Express routes.
4. In the detail view, show a 429 on "Look again" or "Find lineup" as an inline message ("Too many lookups; try again in a minute.") and keep the button enabled. No countdown.

**Acceptance:** the middleware is tested with a stub binding: allow, deny with 429 and `Retry-After`, and allow-all with no binding. Existing route tests pass, and no limiter runs in tests unless injected.

**Out of scope:** WAF rules, KV counters and per-hour limits.

---

### REF-02: Split the event detail view

**Depends on:** SEC-04 merged (it touches the same view). Check with Charlie whether the held detail-view leftovers (save debounce, form labels, touch targets) have landed. If they haven't, they go first.

**Goal:** `src/components/EventDetail.tsx` (1,831 lines on `main`) becomes a coordinator plus card components, with **no visible or behavioural change**.

**Facts:** saves are already field-level patches (`save(patch) → sendPatch`), so cards can't overwrite each other's fields. That makes a shared context or reducer unnecessary. `SAVE_DELAY_MS = 500` and the blur `flush()` live in `Field`. `NotesField` encrypts with the vault before saving.

**Steps (one PR per step, each behaviour-preserving)**
1. Move the shared inputs (`Field`, `ChipInput`, `DaysWent`, `NotesField`, `SAVE_DELAY_MS`) into `src/components/event-detail/` unchanged, and import them back.
2. Extract the sections in the order they appear in the current Hybrid B layout, one component per visual card, named after the card's heading as shown on screen (not the names in the old ticket). Each card receives `event`, `save: (patch: EventPatch) => void` and only the extra props it uses.
3. Keep `FlashContext` where it is. No new context.
4. While moving a card, swap any inline dropdown, tooltip, icon button or pill in it onto the shared component (`AGENTS.md`, Design system).
5. End state: the coordinator is under about 400 lines (data loading, `sendPatch`, layout). Under 400 lines, not 250: don't force it.

**Acceptance (every step):** lint and tests pass. A Playwright screenshot of the detail view (desktop and phone) is pixel-equivalent before and after, as used for the poster and event-detail PRs (`/mnt/project-files/event-detail/screens/`). Typing in a field and closing the sheet at once still saves (the blur flush). Encrypted notes still save while the vault is unlocked.

---

### REL-02B: Live extraction regression run

**Depends on:** TECH-01 merged.

**Goal:** a manual command scores the current Gemini prompt and model against stored documents with confirmed lineups, without writing anything.

**Files:** new `scripts/regression-extract.ts`, a `package.json` script `test:regression`, `ARCHITECTURE.md` (Roadmap item).

**Steps**
1. Read confirmed editions and their stored `source_documents` with a read-only query. Run the same extraction call `stageExtract` makes, with `--model` to override the model.
2. Compare names with `normalizeName` equality, the same rule the app uses for merging. Report recall, precision, the verbatim failure rate (`isVerbatim`) and billing-role accuracy per edition and in total. Print false positives and misses. With `--json <file>`, also write the report there.
3. Stop the run when the Gemini quota answers with an error. Print what finished and exit non-zero. No retry and no other model (`AGENTS.md`).
4. Run it by hand only. Not in CI, since it uses quota.

**Acceptance:** a test runs it against a stub Gemini client and the file store and checks the metrics. The run makes zero database writes (assert with a store spy).

---

### SEC-03: Reconcile row-level security with the live database (parallel lane)

**Needs Charlie** at steps 1 and 4.

**Goal:** the repo's migrations match what is live, so a fresh database gets the same security. Remove the legacy tables only when proven unused.

**Facts:** project memory records that Charlie applied `0025_function_lockdown.DRAFT.sql` and `0026_personal_and_catalog_rls.DRAFT.sql` from `/mnt/project-files/friendliness/rls-draft/` on 2026-10-29. 0026 drops the `members_all` policies and says its rollback "restores the 0024 state", so the earlier `0024_rls_public_tables.DRAFT.sql` (RLS on for 14 tables, policy `members_all`) was most likely applied too. Step 1 confirms it. The 0026 draft replaces `members_all` with own-row `attendance`/`seen_sets`, `members_read` on 10 catalog tables, `owner_read` on `quota_ledger`/`source_stats`. None of these are in the repo, and repo number 0024 is `0024_access_requests.sql`. Member lineup review reads catalog tables with a member token (`requestScope.ts`), so `authenticated` must keep `select` on them. Don't restrict them to `service_role`.

**Steps**
1. **Needs Charlie:** run this read-only query in the Supabase SQL editor and paste the result into the PR:
   ```sql
   select c.relname, c.relrowsecurity,
          (select string_agg(policyname, ', ') from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
   order by c.relname;
   select has_function_privilege('anon','public.owner_user_id()','EXECUTE') as anon_exec,
          has_function_privilege('authenticated','public.owner_user_id()','EXECUTE') as auth_exec;
   select (select count(*) from public.attendance) as attendance_rows, (select count(*) from public.seen_sets) as seen_sets_rows;
   ```
2. If the output matches the drafts, commit them **as applied**, with their headers changed from "DRAFT, NOT applied" to "Applied to live 2026-10-29":
   - `supabase/migrations/0025_function_lockdown.sql`: the 0025 draft.
   - `supabase/migrations/0026_personal_and_catalog_rls.sql`: first the `enable row level security` lines from the 0024 RLS draft, for all 14 tables (they are idempotent), then the 0026 draft body. A fresh database then gets RLS on without the superseded `members_all` policies.
   - If the live output differs from the drafts, stop and report the differences to Charlie. Don't guess.
3. Add a real-Postgres test under `tests/rls/` (run by `npm run test:rls`, with local Postgres 16 and `RLS_PG`, as set up in PR #87). An `authenticated` member can read `performances` but not write it. They can read only their own `attendance`. They can't read `quota_ledger` unless they are the owner. `anon` reads nothing.
4. **Legacy tables:** if step 1 shows `attendance_rows = 0` and `seen_sets_rows = 0`, and `git grep -n "attendance\b\|seen_sets" -- src` shows no reader, write `0032_drop_legacy_attendance.sql` (`drop table if exists public.seen_sets, public.attendance;`, without CASCADE). **Needs Charlie** to approve and apply it. If there are rows, leave the tables locked as they are and report the counts.

**Acceptance:** the migration files match the live output. `test:rls` passes. Nothing is applied to live by the agent.

---

### PERF-05: Code-split the client bundle (parallel lane)

**Goal:** the first chunk holds only what the home view, capture bar and table need. The heavy views load when opened.

**Files:** `src/App.tsx`, `vite.config.ts`, `scripts/check-demo-isolation.mjs` (run it, don't change its rules).

**Steps**
1. Run `npm run build` and record the size of each chunk in the PR (the 883 kB figure comes from the old ticket and is unverified).
2. Load with `React.lazy` the views that `App.tsx` imports statically today and that aren't the start view: `MapView`, `TimelineTab`, `ManageView`, `StatsView`, `ArtistsView`, `LogView`, and any panel used only after a click (Sheets, data import, share). Leave `CaptureBar`, the events home and `TableView` eager. Use named-export wrappers where needed (`.then(m => ({ default: m.ManageView }))`).
3. Use one shared `Suspense` fallback the size of the content area (a plain panel, no spinner animation), so the layout does not jump.
4. Import Leaflet's CSS inside `MapView`'s module so it ships with that chunk. Check that the map renders correctly in light and dark themes.
5. `manualChunks`: put `leaflet` in its own chunk. Split other vendors only if step 1 shows a large one.
6. After first paint, preload the lazy chunks on idle (`requestIdleCallback` with a `setTimeout` fallback), so tab switches feel instant.

**Acceptance:** the start chunk is under 350 kB minified, or the PR explains what blocks it. `node scripts/check-demo-isolation.mjs` passes. Every lazy view opens on desktop and phone, with Playwright screenshots. Lint and tests pass.

---

### LINEUP-05: Edition re-sync (blocked)

**Not buildable yet.** It needs Charlie's decision on amending Invariant 5 in `ARCHITECTURE.md` ("resolve once, reuse forever"). Any design must be written against the slot model from 0029 and 0030 (`slotId`, several performances per artist, the `set` field), which the old ticket predates, and must keep `logged_events.seen` unchanged. Re-check requests go through the SEC-04 research limit. Write a design note (`docs/lineup-05-design.md`) for Charlie before any code.

---

## 3. Corrections to the old ticket bank

Agents reading `docs/engineering-ticket-bank.md` should know these points were wrong there:

- **TECH-01:** the cause was not catastrophic backtracking, and `htmlToText` is not "only used for prompts", because it produces stored document bodies. A 1 MB raw cut would drop `__NEXT_DATA__` lineups. The 50,000-character unclosed-tag rule was dropped.
- **TECH-03 / PERF-03:** the limit error is catchable, not an uncatchable 1101. The 38 and 18 thresholds became one budget with a reserve. Stage 1's "45 to 55 calls" is not supported by the code. The missed offender was `runResolveArtists`.
- **PERF-04:** `all.json` is also fetched in Stage 1. The 3-year pruning was dropped because it breaks back-filling old shows.
- **SEC-03:** live RLS already exists (the 0025 and 0026 drafts, applied 2026-10-29, most likely on top of the 0024 RLS draft). Migration 0029 is taken. Blocking `authenticated` from the evidence tables would break member lineup review.
- **SEC-04:** isolate memory was replaced by Cloudflare's rate-limit binding, and the per-hour limits by per-minute ones.
- **REF-02:** the file is now 1,831 lines, and the card names follow the current layout. Saves are already field patches, so no context is needed.
- **TECH-04:** 12 files use `listen(0)`, not 13.
