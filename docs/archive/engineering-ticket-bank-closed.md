# Closed engineering tickets (archived 2026-11-04)

Moved from docs/engineering-ticket-bank.md. Each ticket was checked against the code on 2026-11-04 and is DONE or OBSOLETE; the evidence is noted in the line under each heading.

### [SEC-01] Single-Promise Worker Server Bootstrap
- **Closed**: DONE (verified 2026-11-04)
- **Classification**: Hardening / Cleanup (not a live bug; see [tier2-ticket-review.md](tier2-ticket-review.md#sec-01-cold-start-concurrency-race-in-ensureserver))
- **Priority**: P3 (Low)
- **Files**: [`worker/index.ts`](../../worker/index.ts)
- **Problem**:
  The concurrent-`listen` race this ticket first described can't happen. `ensureServer` checks `listening` again after `await getDeps(env)`, and between that check and `listening = true` nothing yields (`createApiApp` and `app.listen` are synchronous). An isolate runs on one thread, so two cold requests can't both call `app.listen`.
  What is still loose:
  - `listening = true` is set even if `listen` later reports a failure through an asynchronous `'error'` event (for example `EADDRINUSE`). Every later request would then be sent to a port nothing is listening on.
  - The double-check idiom is easy to break in an edit. One `await` added between the second check and the assignment would bring the race back.
- **Implementation Strategy**:
  1. Replace `let listening = false` with `let serverPromise: Promise<void> | null = null`, the same pattern `getDeps` already uses.
  2. Build the app inside `serverPromise ??= (async () => { ... })().catch((err) => { serverPromise = null; throw err; })`.
  3. Wrap `listen` so it resolves on `'listening'` and rejects on `'error'`. A failed bind then resets `serverPromise`, and the next request tries again.
  4. Move the bootstrap into a small factory that takes `createApp` and `getDeps` as parameters, so it can be tested without workerd.
- **Invariants**: A failed startup is retried on the next request; `/api/health` still answers without starting the server; startup errors still return 503.
- **Test Plan**:
  - 5 `ensureServer` calls at once → `listen` called exactly once, and all 5 resolve.
  - First `getDeps` rejects → the second call retries and succeeds, and `listen` is called once.
  - `listen` emits `'error'` → the call rejects and the next call retries.

---

### [SEC-02] Cache Web Crypto `CryptoKey` in Access Token Verification
- **Closed**: DONE (verified 2026-11-04)
- **Classification**: Performance / Security Optimization
- **Priority**: P2 (Medium)
- **Files**: [`src/server/share/access.ts`](../../src/server/share/access.ts)
- **Problem**:
  In `readAccessClaims`, JWK objects fetched from `${config.teamDomain}/cdn-cgi/access/certs` are cached in `keyCache`. However, on every single incoming authenticated request, `crypto.subtle.importKey('jwk', jwk, ...)` is called. Importing RSA public keys repeatedly consumes CPU cycles and creates garbage collection pressure in Cloudflare V8 isolates.
- **Implementation Strategy**:
  1. Expand the cached type to hold both the JWK and the imported `CryptoKey`:
     ```ts
     interface CachedKey {
       jwk: Jwk;
       cryptoKey?: CryptoKey;
     }
     ```
  2. Lazily import or eagerly import `CryptoKey` once upon caching JWKs.
  3. Reuse `cached.cryptoKey` directly in `crypto.subtle.verify`.
- **Invariants**: Cache TTL (1 hour) and forced refresh when unknown `kid` is encountered must remain identical.
- **Test Plan**: Run `tests/shareRoute.test.ts` and `tests/accessRequests.test.ts`; verify verification passes with zero regressions.

---

### [REF-01] Resolve `MenuButton` Naming Collision with Shared Design System
- **Closed**: OBSOLETE. The app header menu is now AppHeaderMenu.tsx; the shared dropdown stays in ui/MenuButton.tsx.
- **Classification**: Refactor / Design System
- **Priority**: P1 (High)
- **Files**: `src/components/MenuButton.tsx` (removed; the shared one is below), [`src/components/ui/MenuButton.tsx`](../../src/components/ui/MenuButton.tsx), [`src/App.tsx`](../../src/App.tsx)
- **Problem**:
  There are two conflicting `MenuButton.tsx` files in the codebase:
  1. `src/components/MenuButton.tsx`: The application header menu (Theme, Import/Export, Sheets, Share, Members, Logout).
  2. `src/components/ui/MenuButton.tsx`: The generic design-system dropdown selector component (`<MenuButton<T> ... />`).
  In `src/App.tsx`, `import { MenuButton } from './components/MenuButton'` imports the app header menu. This creates naming collisions, breaks IDE auto-imports, and violates the rule that shared UI components live in `src/components/ui/`.
- **Implementation Strategy**:
  1. Rename `src/components/MenuButton.tsx` to `src/components/AppHeaderMenu.tsx` (exporting `AppHeaderMenu`).
  2. Update `src/App.tsx` and all call sites to import `AppHeaderMenu`.
  3. Ensure `src/components/ui/MenuButton.tsx` remains the authoritative generic dropdown component.
- **Invariants**: Visual look and mobile bottom-sheet behavior must remain 100% identical.
- **Test Plan**: `npm run lint` and `npm test` pass; verify header dropdown opens properly on desktop and mobile.

---

### [REF-04] Align `package.json` Naming and Project Metadata
- **Closed**: DONE (verified 2026-11-04)
- **Classification**: Project Hygiene
- **Priority**: P3 (Low)
- **Files**: [`package.json`](../../package.json)
- **Problem**:
  `package.json` still has `"name": "react-example"` from the initial template scaffolding.
- **Implementation Strategy**:
  1. Update `package.json` `"name"` to `"livearchive"`.
  2. Add description `"Personal concert tracking and lineup archive"`.
- **Invariants**: No dependency version changes.
- **Test Plan**: `npm run build` and `npm test` execute cleanly.

---

### [LINEUP-01] Decouple Web Discovery from Zero Claims ("Starvation Bug")
- **Closed**: DONE (verified 2026-11-04)
- **Classification**: Bug / Pipeline Robustness
- **Priority**: P1 (High)
- **Files**: [`src/server/lineup/pipeline.ts`](../../src/server/lineup/pipeline.ts)
- **Problem**:
  In `stageExtract`, transition to `stageDiscover` only triggers if `claims.length === 0`. If Ticketmaster returns a stub listing with only 1 or 2 headliners for a 100-act festival, `claims.length > 0`, so web search and promoter discovery never run. The festival is merged with an incomplete 2-artist lineup.
- **Implementation Strategy**:
  1. Define a stub lineup heuristic: an event is considered a stub if `claims.length === 0`, OR if `claims.length < 5` and the event is a multi-day festival (e.g., `job.input.endDate && job.input.endDate !== job.input.startDate`).
  2. In `stageExtract`, allow transitioning to `discover` when claims are sparse:
     ```typescript
     const isSparseFestival = (job.input.endDate && job.input.endDate !== job.input.startDate) && claims.length < 5;
     const needsDiscovery = (claims.length === 0 || isSparseFestival) && canDiscover;
     job.stage = needsDiscovery ? 'discover' : 'merge';
     ```
  3. Ensure existing claims from the first wave are preserved and merged alongside newly discovered claims in `stageMerge`.
- **Invariants**: Discovered claims still require verbatim verification; snippets are never claims.
- **Test Plan**: Unit test in `tests/pipeline.test.ts` where Ticketmaster returns 1 performer for a 3-day festival → assert `job.stage === 'discover'` and search is invoked.

---

### [TECH-05] Modernize Vite Config to Native Mode
- **Closed**: DONE (verified 2026-11-04)
- **Classification**: Cleanup / Build Tooling
- **Priority**: P3 (Low)
- **Files**: [`vite.config.ts`](../../vite.config.ts)
- **Problem**:
  Vite 8 logs a deprecation warning on every build:
  `Your Vite config uses features that are unsupported by configLoader: 'native'... __dirname (vite.config.ts:8:65). Use import.meta.dirname instead.`
- **Implementation Strategy**:
  Replace `__dirname` with `import.meta.dirname` in [`vite.config.ts`](../../vite.config.ts#L8).
- **Test Plan**: Run `npm run build`; assert zero deprecation warnings.

---

### [REL-01] Per-Message Queue Error Handling & Dead-Letter Visibility
- **Closed**: DONE (verified 2026-11-04 by code audit; the ticket's tests were not re-run).
- **Classification**: Reliability / Observability (revised after [tier2-ticket-review.md](tier2-ticket-review.md))
- **Priority**: P2 (Medium)
- **Files**: [`worker/index.ts`](../../worker/index.ts), [`wrangler.jsonc`](../../wrangler.jsonc), [`ARCHITECTURE.md`](../../ARCHITECTURE.md)
- **Problem**:
  `runJob` already catches every stage error: errors other than quota errors increment `attempts`, back off `2^n` minutes, and set `failed` after `MAX_ATTEMPTS = 3` (`pipeline.ts` 420–454). So the only errors that reach `queue()` are:
  1. `getDeps` failing (Supabase or config unreachable);
  2. `getJob`, the `updateJob` that sets `running`, or the final `updateJob` failing;
  3. `LOOKUP_QUEUE.send` failing after a stage finished;
  4. errors no catch block can see (CPU or wall-clock limit, isolate eviction).
  In cases 1–2 the store is down, so writing `status: 'failed'` would fail too. Marking `failed` on the first error would also throw away `runJob`'s backoff and make a temporary outage permanent. Case 4 can only be recovered by the stale-run reaper, by design. Cloudflare's retries (`max_retries: 3`) are already harmless: `runJob` sees `running` (not yet stale) and does nothing. The real gaps are that a whole batch is retried together and that failures after the retries vanish without a trace.
- **Implementation Strategy**:
  1. Wrap each message in try/catch. On error, log `jobId` and `redactSecrets(message)`, then call `message.retry({ delaySeconds: 60 })`. **Don't** `ack()` and **don't** write `failed`.
  2. Leave the success path as it is (`send` the next stage, then `ack()`).
  3. Add a `dead_letter_queue` to the consumer in `wrangler.jsonc`. Give it no consumer, or one that only logs, so there's never a second path that runs a job.
  4. Keep the stale-run reaper (`STALE_RUN_MS`) as the authority on stuck `running` rows. Document in ARCHITECTURE.md why it's longer than one stage's realistic run time.
- **Invariants**: A job's status changes only inside `runJob`; quota errors still park the job (no retry with another model); one stage per invocation; `max_concurrency: 1` is unchanged.
- **Test Plan**:
  - `getJob` throws → `message.retry` called, not `ack`, and the job row is unchanged.
  - The `send` after a stage throws → the job is left `queued` and `dueJobs` picks it up on the next cron.
  - A stage throws → `attempts` goes up, `nextAttemptAt` is set, and the job is **not** `failed` on the first error.

---

### [LINEUP-02] Clashfinder Weekend & Date-Window Matching Disambiguation
- **Closed**: DONE (verified 2026-11-04 by code audit; the ticket's tests were not re-run).
- **Classification**: Matching Correctness
- **Priority**: P1 (High)
- **Files**: [`src/server/lineup/adapters/clashfinder.ts`](../../src/server/lineup/adapters/clashfinder.ts)
- **Problem**:
  `matchEdition` selects candidate clashes based on edit count without verifying weekend or specific event dates. For festivals with multiple weekends (e.g. Coachella W1 vs W2, Tomorrowland), Weekend 2 attendees are silently given Weekend 1 timetables. Additionally, strict word matching (`wanted.every(...)`) rejects valid clashes if the user's event title includes extraneous descriptor tokens like "Festival" or "Weekend 1".
- **Implementation Strategy**:
  1. Extract weekend tokens from event names (e.g. `w1`, `w2`, `weekend 1`, `wknd 2`) via `weekendFromName`.
  2. When candidate entries have `startDate`:
     - Compare entry `startDate` with `ctx.input.startDate`. A clash whose start date matches the event's start date within ±2 days receives a heavy score bonus (`+500,000`).
     - If the event specifies Weekend N, penalize clashes that explicitly declare a different weekend in their title or slug.
  3. Relax title matching: strip generic festival stop-words (`music`, `festival`, `arts`, `annual`) from the comparison so `"Portola Music Festival"` matches a Clashfinder entry titled `"Portola 2023"`.
- **Invariants**: Speculative and fantasy clashes remain rejected (`SPECULATIVE.test(name)`).
- **Test Plan**:
  - Add test in `tests/adapters.test.ts` with mock editions for `coachella2024w1` (900 edits, April 12) and `coachella2024w2` (300 edits, April 19).
  - Searching for Coachella with `startDate: '2024-04-19'` must pick `coachella2024w2`.

---

### [LINEUP-03] Content-Aware Lineup Windowing & Navigation Stripping
- **Closed**: DONE (verified 2026-11-04 by code audit; the ticket's tests were not re-run).
- **Audit note**: the code uses 2–40 characters for the artist-like line window; this ticket says 2–35.
- **Classification**: Extraction Reliability
- **Priority**: P2 (Medium)
- **Files**: [`src/server/lineup/text.ts`](../../src/server/lineup/text.ts), [`src/server/lineup/gemini.ts`](../../src/server/lineup/gemini.ts)
- **Problem**:
  `lineupWindow` searches for `/line[- ]?up|artists|performers/i` and takes a 40,000 character substring. In practice, site navigation headers trigger this match within the first 200 characters, taking the top 40,000 characters of hero copy, ticket tiers, and FAQs, while silently truncating alphabetical lineups at the bottom of the page.
- **Implementation Strategy**:
  1. Improve boilerplate reduction in `htmlToText`: strip `<nav>`, `<header>`, `<footer>`, `<dialog>`, and inline SVG blocks before plain-text extraction.
  2. Implement block-density windowing:
     - Search for clusters where line length is short and artist-like (e.g. blocks of lines with 2–35 characters).
     - If the document exceeds `MAX_DOC_CHARS` (40k), start the window at the highest-density roster block rather than the first keyword occurrence.
- **Invariants**: `isVerbatim` check must still pass against the raw stored document.
- **Test Plan**: Test against a synthetic HTML page with a 10kb navigation/FAQ header and a 50kb roster → verify names from the end of the alphabet (e.g. "Zedd") are preserved in the extraction window.

### [TECH-04] In-Memory Express Request Dispatcher for Integration Tests

- **Closed**: built in Tier 3 Slice 3 (PR #229) as `tests/helpers/testApp.ts`.
- **Audit 2026-11-04**: OPEN (partial). tests/helpers/testApp.ts exists and dispatches in memory; migrating tests/shareApi.test.ts and tests/sheets.test.ts is not confirmed.
- **Classification**: Engineering Excellence & Test Speed
- **Priority**: P2 (Medium)
- **Files**: `tests/helpers/testApp.ts`, integration test files
- **Problem**:
  13 test files currently spin up a real HTTP server with `app.listen(0)` and make real TCP requests to `127.0.0.1`. This introduces port-binding race conditions, slows down the test suite by several seconds, and causes `connect EPERM` failures in isolated sandboxes.
- **Implementation Strategy**:
  1. Create a lightweight test helper `dispatch(app, requestInit)` that passes a `Request` through Express middleware in memory via Node's `http.IncomingMessage` / `http.ServerResponse` mocks without opening real OS network sockets.
  2. Migrate `tests/shareApi.test.ts` and `tests/sheets.test.ts` onto this in-memory caller.
- **Test Plan**: Run all migrated test files in a restricted sandbox without loopback permissions → assert 100% pass rate in < 200 ms.

---

