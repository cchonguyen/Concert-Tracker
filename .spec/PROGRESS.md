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
- [x] **Slice 0.1: Match split B2B acts that carry no candidate key** [CORE / DATA] On-the-fly: Charlie: Dreamstate B2B re-save still had no set times Target files: src/server/lineup/learning.ts, tests/splitActs.test.ts | Issue: #411 | Verify: npm test --silent && npm run lint --silent
- [x] **Slice 0.2: Manage deep links, Inbox badge, Edition Check Details & Supabase egress fixes** Target files: src/, tests/, worker/ | Verify: npm run typecheck --silent && npm run lint --silent && npm test --silent
- [x] **Slice 0.3: Add PR & Harness gate workflow rule** Target files: .agents/rules/pr-workflow.md | Verify: npm run lint --silent
- [ ] **Slice 0.4: Raise canon backfill subrequest budget margins** [IN_PROGRESS] Target files: src/server/canon/backfill.ts, tests/canonBackfill.test.ts | Verify: npm run typecheck --silent && npm run lint --silent && npm test --silent
