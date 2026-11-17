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
- [x] **Slice 0.4: Raise canon backfill subrequest budget margins** Target files: src/server/canon/backfill.ts, tests/canonBackfill.test.ts | Verify: npm run typecheck --silent && npm run lint --silent && npm test --silent

## Global Archive Series & Multi-Weekend
- [x] **Slice 1.1: Design spec, requirements & architecture docs** Target files: docs/specs/global-archive-series-weekends.md, REQUIREMENTS.md, docs/architecture/02-stage-1-capture-and-details.md, docs/architecture/12-data-model.md, docs/architecture/13-api.md | Verify: npm run lint --silent
- [x] **Slice 1.2: Migration 0045, store types, nullable seriesSlug & egress queries** [CORE / DATA] Target files: supabase/migrations/, src/server/lineup/types.ts, src/server/lineup/store/types.ts, src/server/lineup/store/supabaseStore.ts, src/server/lineup/store/fileStore.ts, src/server/lineup/pipeline.ts, src/server/lineup/learning.ts, src/server/entities/canonicalManage.ts, tests/ | Verify: npm run typecheck --silent && npm run lint --silent && npm test --silent
- [x] **Slice 1.3: Canonical ingest, edition merge, series APIs & egress routes** [CORE / DATA] Target files: src/server/canon/editions.ts, src/server/canon/match.ts, src/server/canon/dedupeProvisional.ts, src/server/lineup/canonicalIngest.ts, src/server/entities/canonicalManage.ts, src/server/entities/routes.ts, src/server/lineup/routes.ts, tests/ | Verify: npm run typecheck --silent && npm run lint --silent && npm test --silent
- [x] **Slice 1.4: Capture weekend parse, inheritance, Option 3B & events egress** [CORE / DATA] Target files: src/server/events/parse.ts, src/server/events/types.ts, src/server/events/inherit.ts, src/server/events/service.ts, src/server/events/details.ts, src/server/events/routes.ts, tests/ | Verify: npm run typecheck --silent && npm run lint --silent && npm test --silent
- [x] **Slice 1.5: Global Archive series/merge/weekends UI & soft-prompts** [UI / VISUAL] Target files: src/services/, src/components/, tests/ | Verify: npm run typecheck --silent && npm run lint --silent && npm test --silent
- [x] **Slice 1.6: Fix edition merge self-clash, surface 409 conflict details & queue backfill clashes** [CORE / DATA] Target files: src/server/lineup/store/types.ts, src/server/lineup/store/supabaseStore.ts, src/server/lineup/store/fileStore.ts, src/server/lineup/canonicalIngest.ts, src/server/entities/routes.ts, src/server/canon/reviewRoutes.ts, src/server/lineup/routes.ts, src/server/canon/backfill.ts, tests/ | Verify: npm run typecheck --silent && npm run lint --silent && npm test --silent
- [x] **Slice 1.7: Auto-merge matching 0-lineup edition into populated verified edition** [CORE / DATA] Target files: src/server/canon/dedupeProvisional.ts, src/server/canon/match.ts, src/server/canon/backfill.ts, src/server/lineup/canonicalIngest.ts, docs/architecture/12-data-model.md, tests/ | Verify: npm run typecheck --silent && npm run lint --silent && npm test --silent
- [x] **Slice 1.8: Stagger cron backfills and tune canon backfill FIXED_COST** [CORE / DATA] On-the-fly: Drain remaining canon_backfill items under SUBREQUEST_LIMIT=50 and cut idle 1-minute research polling Target files: src/server/canon/backfill.ts, worker/index.ts, docs/architecture/16-hosting.md, tests/ | Issue: #421 | Verify: npm run typecheck --silent && npm run lint --silent && npm test --silent

## Series Place, Tour Kind & Weekend Autofill
- [x] **Slice 2.1: Spec, requirements & architecture docs for series kind/place, inheritance & weekend autofill** Target files: docs/specs/global-archive-series-weekends.md, REQUIREMENTS.md, docs/architecture/02-stage-1-capture-and-details.md, docs/architecture/12-data-model.md, docs/architecture/13-api.md, .spec/SYSTEM_SPEC.md, .spec/DECISIONS.md | Verify: npm run lint --silent
- [x] **Slice 2.2: Migration 0046, series kind/place store/API & Edition/Event inheritance** [CORE / DATA] Target files: supabase/migrations/, src/server/lineup/types.ts, src/server/lineup/store/types.ts, src/server/lineup/store/supabaseStore.ts, src/server/lineup/store/fileStore.ts, src/server/entities/canonicalManage.ts, src/server/entities/routes.ts, src/server/canon/editions.ts, src/server/canon/match.ts, src/server/events/types.ts, src/server/events/inherit.ts, src/server/events/scale.ts, src/server/events/service.ts, src/server/events/routes.ts, tests/ | Verify: npm run typecheck --silent && npm run lint --silent && npm test --silent
- [x] **Slice 2.3: Multi-weekend extraction in research & Gemini reader** [CORE / DATA] Target files: src/server/events/details.ts, src/server/events/detailsGemini.ts, src/server/lineup/gemini.ts, src/server/reader/geminiAdapter.ts, src/server/entities/routes.ts, tests/ | Verify: npm run typecheck --silent && npm run lint --silent && npm test --silent
- [x] **Slice 2.4: Global Archive series/edition place autofill & weekend draft/research UI** [UI / VISUAL] Target files: src/services/, src/components/, tests/ | Verify: npm run typecheck --silent && npm run lint --silent && npm test --silent
- [x] **Slice 2.5: Event fetch Stage 0 fixes** [CORE / DATA] On-the-fly: Charlie approved Stage 0 of the event fetch upgrade in the project thread on 2026-11-17 Target files: src/server/events/details.ts, src/server/lineup/http.ts, tests/, docs/architecture/ | Issue: #425 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 2.6: Record why an email import is unreadable** [CORE / DATA] On-the-fly: Charlie: 466 unreadable email rows store no reason Target files: src/server/events/email/types.ts, src/server/events/email/imports.ts, tests/email.test.ts | Issue: #432 | Verify: npm run lint --silent && npm test --silent

## Global Editions admin (plan: `.spec/plans/global-editions-admin.md`; spec: `docs/specs/global-editions-admin-spec.md`; approved 2026-11-17)
- [x] **Slice 2.7: Brand store, history table and undo** [CORE / DATA] Target files: supabase/migrations/0048_brand_history.sql, src/server/brands/plan.ts, src/server/brands/store.ts, tests/brandsPlan.test.ts, tests/brandsStore.test.ts, docs/architecture/12-data-model.md | Issue: #438 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 2.8: Owner brand routes** [CORE / DATA] Target files: src/server/brands/routes.ts, src/server/entities/routes.ts, tests/brandsRoutes.test.ts | Issue: #439 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 2.9: Brands tab in Global Editions** [UI / VISUAL] Target files: src/components/CanonicalArchive.tsx, src/components/ManageView.tsx, src/services/manageNav.ts, src/services/brandsApi.ts, tests/brandsTab.test.ts | Issue: #440 | Verify: npm run typecheck --silent && npm run lint --silent
- [x] **Slice 2.10: Clashfinder Find lineup on festival editions** [CORE / DATA] Target files: src/server/lineup/routes.ts, src/server/lineup/canonicalIngest.ts, src/components/CanonicalArchive.tsx, docs/architecture/08-sources.md, tests/canonicalFindLineup.test.ts | Issue: #441 | Verify: npm run typecheck --silent && npm run lint --silent && npm test --silent
- [x] **Slice 2.12: Global Editions follow-ups (brand counts, API doc rows, Find lineup series slug)** [CORE / DATA] Target files: src/server/brands/plan.ts, src/server/brands/store.ts, src/server/brands/routes.ts, src/components/CanonicalArchive.tsx, src/server/lineup/routes.ts, src/server/lineup/canonicalIngest.ts, docs/architecture/13-api.md, tests/brandsStore.test.ts, src/services/brandsApi.ts, tests/brandsPlan.test.ts, tests/brandsRoutes.test.ts, tests/canonicalFindLineup.test.ts | Issue: #450 | Verify: npm run typecheck --silent && npm run lint --silent && npm test --silent


## Harness rollout (hub plan harness-consistency, approved by Charlie 2026-11-17)
- [x] **Slice 2.11: Switch to the shared harness gate and telemetry workflows** Target files: .github/workflows/harness-slice-gate.yml, .github/workflows/harness-telemetry.yml | Issue: #448 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 2.13: Find lineup: look up editions that have no acts** [CORE / DATA] On-the-fly: Charlie: Find lineup returned empty results for six editions (issue #452) Target files: src/server/lineup/pipeline.ts, tests/canonMatch.test.ts, tests/eventFromEdition.test.ts, tests/events.test.ts, docs/architecture/09-lookup-pipeline.md | Issue: #452 | Verify: npm test --silent && npm run lint --silent
