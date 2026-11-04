# Closed engineering tickets (archived 2026-11-04)

Moved from docs/engineering-ticket-bank.md. Each ticket was checked against the code on 2026-11-04 and is DONE or OBSOLETE; the evidence is noted in the line under each heading.

### [SEC-01] Single-Promise Worker Server Bootstrap
- **Closed**: DONE (verified 2026-11-04)
- **Classification**: Hardening / Cleanup (not a live bug; see [tier2-ticket-review.md](../tier2-ticket-review.md#sec-01-cold-start-concurrency-race-in-ensureserver))
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
