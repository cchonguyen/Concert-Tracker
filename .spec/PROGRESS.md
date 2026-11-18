# Task Progress & Single-Slice Work Lock

> Rule: Mark only ONE task line at a time with the active work tag.

## Share page (spec approved 2026-10-28 after Gemini review: https://claude.ai/artifact/9kJinrnXRiu4EMPNCA8VbK)
A read-only page at `/s/<code>` outside Cloudflare Access. Only allow-listed fields; only events fully over in the link's time zone; the public route never writes. Migration 0015 (0014 is Manage's).

## Manage section (triaged 2026-10-28, revised after Gemini audit)
Contracts: SYSTEM_SPEC.md section 3. `[CORE / DATA]` slices need passing unit tests (`npm test`, Node's test runner over `tests/*.test.ts`); `[UI / VISUAL]` slices run `npm run lint`, and per AGENTS.md also `npm test`, before commit.

## Tier 3 (specs: docs/tier3-specs.md, build order row 1)

## Global Archive UX (spec: `docs/canonical-archive-ux-spec.md`)

## Ingest and self-healing canon (plan: `docs/ingest-canon-plan.md`, approved 2026-11-13; open each issue when the slice starts)

## Canon review workflow (scope: `.spec/CANON_REVIEW_SCOPE.md`, approved by Charlie 2026-11-13; open each issue when the slice starts)

## Global Archive Series & Multi-Weekend

## Series Place, Tour Kind & Weekend Autofill

## Global Editions admin (plan: `.spec/plans/global-editions-admin.md`; spec: `docs/specs/global-editions-admin-spec.md`; approved 2026-11-17)


## Harness rollout (hub plan harness-consistency, approved by Charlie 2026-11-17)

## Edition lineup from the edition name (docs/edition-lineup-from-name-spec.md)
- [x] **Slice 20.3: Member lineup offers from linked editions** [CORE / DATA] On-the-fly: Charlie: build slice 5 of the edition lineup spec (member Fill gaps), server part Target files: src/server/canon/nameArtists.ts, src/server/entities/routes.ts, tests/nameArtists.test.ts | Issue: #494 | Verify: npm test --silent
- [ ] **Slice 20.2: Finder readout server (Stage 1.2)** [CORE / DATA] Owner-only 30-day per-finder readout over research trace finder steps; plan: docs/specs/event-fetch-stage-1-2-plan.md Target files: src/server/telemetry/finderReadout.ts, src/server/lineup/routes.ts, tests/finderReadout.test.ts, docs/architecture/02-stage-1-capture-and-details.md | Issue: #493 | Verify: npm test --silent
- [ ] **Slice 20.4: Finder readout panel (Stage 1.2)** [UI / VISUAL] Client method and Manage panel under the reader panel, owner only; plan: docs/specs/event-fetch-stage-1-2-plan.md Target files: src/services/lineupApi.ts, src/components/FinderReadoutPanel.tsx, src/App.tsx | Issue: #504 | Verify: npm run lint --silent
- [ ] **Slice 20.493: Event fetch Stage 1.2: owner finder readout server** [IN_PROGRESS] [CORE / DATA] On-the-fly: Charlie approved Stage 1 and chose Plan it with /spec for 1.2 (2026-11-18), plan PR #506 Target files: src/server/telemetry/finderReadout.ts, src/server/lineup/routes.ts, tests/finderReadout.test.ts, docs/architecture/02-stage-1-capture-and-details.md | Issue: #493 | Verify: npm test --silent
