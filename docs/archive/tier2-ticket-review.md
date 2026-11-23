# LiveArchive Tier 2 Ticket Review

> **Archived 2026-11-23.** Its findings were written into the [ticket bank](../engineering-ticket-bank.md) on 2026-11-02.

> **Date**: 2026-11-02. **Covers**: SEC-01, PERF-01, PERF-02, REL-01, A11Y-02, A11Y-03, FEAT-03 in [engineering-ticket-bank.md](../engineering-ticket-bank.md).
> **Outcome**: the tickets in the bank were rewritten from this review. Line numbers refer to the code as of this date.

Every finding below was checked against the current code, not just the ticket text.

| Ticket | Verdict | One-line reason |
|---|---|---|
| SEC-01 cold-start listen race | **[NEEDS REVISION]** | The race the ticket describes can't happen: there is already a second check after the `await`. At most this is a cleanup. |
| PERF-01 `listSeenArtistNames` | **[NEEDS REVISION]** (small) | Worth doing, but as written it leaks names across users through the file-store `Proxy`. |
| PERF-02 weather cache | **[NEEDS REVISION]** | Saves little, the proposed key goes stale, and it bypasses the existing `cachingFetcher`. |
| REL-01 queue terminal failure | **[NEEDS REVISION]** | Misreads the code: `runJob` already catches errors and retries with backoff. As specced, it would break that retry logic. |
| A11Y-02 NoticeModal → Dialog | **[READY TO BUILD]** once the 4 required items below are in the spec | Correct direction, and AGENTS.md asks for it. |
| A11Y-03 table keyboard nav | **[NEEDS REVISION]** | Rows already get `tabIndex=0` and open on Enter. The real gap is the inner tab stops and arrow-key movement. |
| FEAT-03 setlist.fm link | **[BLOCKED]** | It's an idea from REQUIREMENTS §13 that needs a docs change first, and today's code would hand it a fallback URL the app made up. |

---

## SEC-01: Cold-start concurrency race in `ensureServer`

**What the code actually does** ([index.ts](../../worker/index.ts#L67-L87)): `ensureServer` checks `listening` again on line 70, *after* `await getDeps(env)`. Between that second check and `listening = true` on line 86, nothing yields: `createApiApp` is synchronous and `app.listen` returns synchronously. An isolate runs one thread, so two cold requests can't both reach `app.listen`. `getDeps` already memoizes its promise and resets it on failure.

**Edge cases that do exist**
- `app.listen(PORT)` reports `EADDRINUSE` and similar failures as an asynchronous `'error'` event, but `listening = true` is set anyway. The isolate would then send every request to a dead port. In workerd this is very unlikely, but nothing catches it.
- If `createApiApp` throws, `listening` stays `false` and the next request tries again. That's already the right behaviour.

**Refinements**
- Retitle it as a hardening change, not SEC. If it's built, use `serverPromise ??= (async () => {...})().catch(e => { serverPromise = null; throw e; })`. This matches the existing `getDeps` pattern and removes the double-check idiom.
- Optionally wrap `listen` in a promise that resolves on `'listening'` and rejects on `'error'`, so a failed bind resets `serverPromise`.

**Tests**
- Pull the bootstrap into a factory that takes `createApp` as an injected dependency. Fire 5 `ensureServer` calls at once and check `listen` is called exactly once.
- If the first `getDeps` rejects, the second call retries and succeeds, and `listen` is still called once.

---

## PERF-01: `listSeenArtistNames` for `stageMerge`

The problem is real. [pipeline.ts:369](../../src/server/lineup/pipeline.ts#L369) deserializes every `logged_events` row (sources, details, weather, candidates) just to read names. On Workers Free (10 ms CPU), parsing that JSON is the expensive part, not the single subrequest.

**Edge cases and failure modes**
- **Tenant leak (critical).** `scopedFileStore` returns a `Proxy` that falls through to the base store for any method it doesn't override ([fileStore.ts](../../src/server/lineup/store/fileStore.ts#L930-L938)). A new `listSeenArtistNames` added only to `FileLineupStore` would return **every member's** names in a scoped context. That breaks rule 4 without any error.
- **Supabase scoping.** The query has to go through `this.mine(this.own('logged_events')...)`, or it ignores `user_id` and RLS.
- **Silent truncation.** PostgREST caps responses at 1,000 rows by default. `listEvents` doesn't page today, and this already-known gap carries over. A new method should page with `.range()`, the same way `performances` does at line 367.
- Soft-deleted events: keep `.is('deleted_at', null)` so spellings from events in the trash don't come back.

**Refinements**
- Add it to `LineupStore` as a **required** method, so the compiler forces an implementation in both stores. Implement it in `SupabaseLineupStore` (scoped and paged), `FileLineupStore`, **and the `scopedFileStore` overrides** (`keep('event', ...)` then flatten).
- Return `string[]` taken only from `seen[].name`, matching what `yourSpellings` reads today. Don't widen it to `b2b`.

**Tests**
- Two members on the file store and on a mocked Supabase client: the scoped `listSeenArtistNames` returns only that member's names.
- Deleted events are left out.
- With more than 1,000 rows, the result is the complete set (paging works).
- `stageMerge` produces the same candidate before and after the change, using a snapshot from an existing `pipeline.test.ts` fixture.

---

## PERF-02: Weather cache

**Context**: weather is fetched only when you ask, and is stored on the event together with `sourceUrl` ([routes.ts:187](../../src/server/events/routes.ts#L187-L193)). Asking again for the same event is rare, so the cache's hit rate will be low.

**Edge cases**
- **The data isn't immutable.** Open-Meteo first serves preliminary ERA5T data and replaces it with final ERA5 data about 2–3 months later. `ARCHIVE_LAG_DAYS = 5` only keeps out *missing* data. A 1-year TTL would pin preliminary values.
- **The proposed key is incomplete.** `weather:${lat}:${lon}:${start}:${end}` leaves out the `daily=` variables and `timezone`. If a field is added later, the cache keeps serving the old shape. Floats in the key are also fragile (`51.5` vs `51.50`).
- **`cachingFetcher` hard-codes `sourceType: 'ticketmaster'`** ([responseCache.ts:59](../../src/server/lineup/responseCache.ts#L59)) and has one global 24 h TTL. Adding a second host as-is would mislabel its rows.
- **Status 200 with nothing in it**: the archive can answer 200 with every value null. `cachingFetcher` only checks the status, so it would cache that for a year.
- The geocoder must **not** be cached. The "exactly one place" ambiguity check has to run on live results.
- The cache only exists when `SOURCE_CACHE=on`.

**Refinements**
- Don't add a hand-built key. Extend `responseCache.ts` with a per-host policy: `{ 'archive-api.open-meteo.com': { sourceType: 'open-meteo', ttlMs: 30d } }`. Keep using `cacheKey(url)`, which covers every parameter. Use 30 days, not 1 year, or tie the TTL to the event's age (for example, a long TTL only when `endDate` is more than 90 days ago).
- Let the policy carry an optional `accept(body)` check, so open-meteo answers whose `daily.time` is empty or all-null aren't stored.
- Update the comment in `responseCache.ts` about which hosts' terms allow caching (Open-Meteo allows it for non-commercial use), and update ARCHITECTURE.md.
- Alternatively, defer the ticket. The value is low compared with the work.

**Tests**: a cache hit returns the same `WeatherResult`, including `sourceUrl`; an all-null body isn't stored; geocoder URLs always skip the cache; entries are stored with the right `sourceType` and TTL for each host.

---

## REL-01: Queue terminal failure handler

**What the code actually does**: `runJob` already wraps every stage in try/catch ([pipeline.ts:420-454](../../src/server/lineup/pipeline.ts#L420-L454)). Errors other than quota errors increment `attempts`, back off `2^n` minutes, and set `failed` after `MAX_ATTEMPTS = 3`. So the only errors that escape to `queue()` come from:
1. `getDeps` (Supabase or config unreachable),
2. `getJob` / the `updateJob` that sets `running` / the final `updateJob`,
3. `LOOKUP_QUEUE.send`,
4. errors that can't be caught at all: CPU limit, wall-clock limit, isolate eviction.

**Why the proposal is wrong**
- In cases 1–2 the store is the thing that's down, so writing `status: 'failed'` would fail too.
- Setting `failed` straight away throws out `runJob`'s 3-attempt backoff and turns a temporary Supabase blip into a permanent failure.
- In case 4 no catch block runs, so the stale-run reaper is the only recovery, by design.
- "Poison thrashing" doesn't happen. When Cloudflare retries (`max_retries: 3`), `runJob` sees `status: 'running'` (not yet stale) and returns early as a no-op.
- Calling `ack()` on every error would also drop the message in case 3 (the next stage was never sent). The cron's `dueJobs` covers that only because the job is `queued`. That works, but by luck.

**Refinements (re-scoped ticket)**
- Catch errors per message. Log them with `jobId` and `redactSecrets`, then call `message.retry({ delaySeconds: 60 })` instead of rethrowing, so one message's backoff doesn't depend on the batch.
- Add a `dead_letter_queue` in `wrangler.jsonc` so failures after the retries can be seen. Give it **no consumer** (or one that only logs), so there's no second path that could run a job.
- Keep the reaper as the authority on stuck rows. If anything, document why `STALE_RUN_MS` (10 min) is longer than the realistic time one stage takes.

**Tests**
- `getJob` throws → the message is retried, not acked, and the job row is unchanged.
- The `send` after a stage throws → the job ends up `queued` and `dueJobs` picks it up.
- A stage throws → `runJob` backoff still applies: `attempts` goes up and the job is not `failed` on the first error.

---

## A11Y-02: `NoticeModal` on the shared `Dialog`

**Edge cases**
- **Stacking order.** `NoticeModal` renders *alongside* the app ([App.tsx:375](../../src/App.tsx#L375-L377)), not instead of it. A deep link that opens a `Dialog` after mount (event detail, for example) is pushed onto `openDialogs` after the notice. It then takes Escape and Tab while sitting visually *under* the notice. The notice uses `z-[100]` and `Dialog` uses `z-50`, so moving it to `Dialog` without a z-override also lets the sticky header and toasts compete with it.
- **Height.** `CENTER_PANEL` has no `max-h`/`overflow-y-auto`. On mobile, `items-end` plus this long text can push the accept button off-screen.
- **Busy state.** The button becomes `disabled` while the request runs, so focus falls to `<body>`. `Dialog`'s Tab handler then finds no focusable items and swallows Tab, leaving focus stranded outside the panel.
- **Errors aren't announced.** The error `<p>` has no `role="alert"`.

**Required spec additions**
1. A `dismissible?: boolean` prop (default `true`). When it's `false`, Escape is ignored (`preventDefault`), a backdrop `onMouseDown` does nothing, and `onClose` is optional. Type it as a discriminated union so `dismissible: true` requires `onClose`.
2. Make the app tree `inert` while the notice is open (or don't render it at all), so nothing underneath can open a dialog or take focus.
3. `panelClassName` keeps `max-h-[90vh] overflow-y-auto`. Add a z-index option or a `layer` prop.
4. Use `aria-disabled` plus a guard instead of `disabled` while busy, and give the error `role="alert"`.

**Tests**: Escape and backdrop clicks don't close a non-dismissible dialog; Tab stays inside; body scroll is locked and restored; existing dismissible dialogs still close on Escape (regression); focus stays inside on a failed accept.

---

## A11Y-03: Table keyboard navigation

**What the code actually does** ([TableView.tsx:622-628](../../src/components/TableView.tsx#L622-L628)): every `<tr>` already has `tabIndex={0}` and opens on Enter. The ticket's diagnosis is partly out of date. The real cost is N row stops plus the inner buttons (the series button in `DetailsCell`, and so on), and there are no arrow keys.

**Edge cases**
- **Today-indicator rows** are mixed in between data rows. Moving to the DOM sibling would land on them. Move by index into `rows`, never by sibling.
- **Re-sorting and filtering** change indexes. Track the focused row by `event.id`, and fall back to the nearest row when it's filtered out. Otherwise `tabIndex=0` can point at nothing, and the table drops out of the tab order.
- **Inner buttons** keep `tabIndex=0`, so roving tabindex only helps if rows that aren't active also set their inner controls to `-1`. Alternatively, accept that they stay as tab stops.
- **Sticky `thead`** hides the focused row when scrolling up. Give rows `scroll-margin-top` and call `scrollIntoView({ block: 'nearest' })`.
- Arrow keys scroll the `overflow-auto` container by default, so call `preventDefault` on keys you handle.
- The mobile `<ul>` is `display:none` on desktop, so it isn't affected. Keep the handlers only on the desktop table.
- **Don't** add `role="grid"` unless cell-level navigation is built too. A half-finished grid is worse than the native table.

**Refinements**: put one `onKeyDown` on `<tbody>` (not on `document`, which also deals with the "typing in the filter bar" worry). Handle ArrowUp, ArrowDown, Home, End and Enter only when `e.target` is a row, so keys pressed on inner buttons pass through. Pull out a pure `nextRowId(rows, currentId, key)` helper so it can be unit-tested.

**Tests**: `nextRowId` skips nothing and clamps at the ends; after re-sorting, focus stays on the same event; Enter on an inner button doesn't open the row; typing in the search input never moves row focus; exactly one row has `tabIndex=0` at any time.

---

## FEAT-03: setlist.fm setlist link

**Blockers**
- **A made-up fallback URL.** [details.ts:139](../../src/server/events/details.ts#L139) does `s.url ?? 'https://www.setlist.fm'`, and the stage 2 adapter falls back to a search URL ([setlistfm.ts:83](../../src/server/lineup/adapters/setlistfm.ts#L83)). If either is saved as "Setlist on setlist.fm", the app shows a link it invented, which breaks rules 1 and 2.
- **A requirements change.** This is idea #3 in REQUIREMENTS §13. AGENTS.md requires updating REQUIREMENTS.md and ARCHITECTURE.md first, and putting the multi-step plan under `docs/`.

**Edge cases**
- `searchWindow` covers the date **±1 day**, so for a residency (night 1, 2, 3) the candidate may be the wrong night's setlist.
- The same artist can have two setlists on one day (an early and a late show, or a festival plus an afterparty). That's ambiguous, so no link.
- The setlist artist has to match one specific seen act after normalization. Seen acts get renamed, removed, or replaced when a lineup is confirmed, so a URL stored on `SeenAct` goes stale or attaches to the wrong act.
- Only the candidate that was **applied or picked** may give a link, never every candidate that was offered.
- The share page: decide explicitly whether the link appears on public share pages.

**Refinements**
- Accept a URL only if it matches `^https://www\.setlist\.fm/setlist/[^/]+/\d{4}/.+\.html$` and comes from the API response. Otherwise store nothing. Remove the fallback in both places, or make it non-persistable.
- Attach it only when `eventDate` equals the event's stored `startDate` exactly, the venue matches, there's exactly one setlist for that artist that day, and the event's scale is Concert (`scale.ts`).
- Store it separately from `SeenAct`, for example `event.setlists: Array<{ actKey, url, eventDate, venue, checkedAt }>`, joined to acts by `key` when rendering. That way it survives edits to seen acts and is dropped when its act is gone.
- Render it as `<a rel="noopener noreferrer" target="_blank">` with the date shown, using the shared `Pill` or `IconButton` if a chip is used.

**Tests**: a missing `s.url` gives no link; a ±1 day match gives no link; two same-day setlists give no link; a renamed act loses its link; the link is never set from a Gemini-read source.

---

## Cross-cutting notes
- PERF-01's paging gap also affects `listEvents` (22 call sites). Consider a separate ticket.
- Per AGENTS.md: any ticket that changes behaviour (PERF-02, REL-01, FEAT-03) updates ARCHITECTURE.md in the same change, and every ticket runs `npm run lint && npm test`.
