# Session Handoff

- **Last Active Platform:** Claude Code (cloud session)
- **Active Branch / State:** `claude/tier3-fetch-01-handoff` (cut from origin/main 4aee37b). Docs only. PR open, not merged. Main includes TECH-04 (PR #229, merged by Charlie) and FETCH-01 (PR #233, merged by Charlie).
- **Done this session:**
  - TECH-04 (slice 3): `tests/helpers/testApp.ts` `dispatch()` in memory, 18 test files moved off `listen(0)`. Merged as #229.
  - FETCH-01 (slice 4): `src/server/lineup/budget.ts` per-invocation subrequest budget (limit 50, `SUBREQUEST_LIMIT` override, reserve 4). Fetcher uses manual redirects (max 3 hops, public-URL check per hop) and a 3 MB body cap with `truncated`. Budgets start in the queue handler, the cron run and an `/api` middleware. Merged as #233.
- **Verification Status:** Verified via finish-slice.mjs (Slice 8.10)
  - TECH-04: `git grep "listen(0" -- tests` empty; `npm test` 733 pass; lint exit 0.
  - FETCH-01 (on commit 8d11a07): `npm test` 743 pass, 0 fail; `npm run lint` exit 0.
  - FETCH-01 `pr-check` (CI) was red on 8d11a07. Cause: `pr-scope-check.mjs --strict` flags `src/server/auth/requestScope.ts` as a Red tripwire (auth file). Lint and tests were green. PR #233 was merged while the check was still red. Not resolved.
- **Open gaps:**
  - FETCH-01: cold-start store probes in `getDeps` (once per isolate) run before the per-message budgets, so they are not counted against the budget. Fixing that changes the handler shape.
  - FETCH-01: the Red tripwire on `src/server/auth/requestScope.ts` on main needs Charlie's decision: accept it, or move the Supabase `countingFetch` wiring out of that file.
- **Immediate Next Step:** Charlie decides on the `requestScope.ts` tripwire and picks the next slice from `docs/tier3-specs.md` build order (TECH-03 needs migration 0031, which Charlie applies; REL-02A has no dependencies). Do not start a slice until he picks one.
