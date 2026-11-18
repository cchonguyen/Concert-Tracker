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
- [x] **Slice 20.505: Member Fill gaps lineup offer** [UI / VISUAL] On-the-fly: Charlie: build slice 5 of the edition lineup spec (member Fill gaps), UI part Target files: src/services/table.ts, src/services/lineupApi.ts, src/components/FillGaps.tsx, src/services/poster.ts | Issue: #505 | Verify: npm run lint --silent
