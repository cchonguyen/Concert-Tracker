# Task Progress & Single-Slice Work Lock

> Rule: Mark only ONE task line at a time with the active work tag.


## Share page (spec approved 2026-10-28 after Gemini review: https://claude.ai/artifact/9kJinrnXRiu4EMPNCA8VbK)
A read-only page at `/s/<code>` outside Cloudflare Access. Only allow-listed fields; only events fully over in the link's time zone; the public route never writes. Migration 0015 (0014 is Manage's).


## Manage section (triaged 2026-10-28, revised after Gemini audit)
Contracts: SYSTEM_SPEC.md section 3. `[CORE / DATA]` slices need passing unit tests (`npm test`, Node's test runner over `tests/*.test.ts`); `[UI / VISUAL]` slices run `npm run lint`, and per AGENTS.md also `npm test`, before commit.


## Tier 3 (specs: docs/tier3-specs.md, build order row 1)

## Global Archive UX (spec: `docs/canonical-archive-ux-spec.md`)


## Audit follow-up (plan approved 2026-11-04: /mnt/project-files/audit-2026-11-04/plan.md)

- [x] **Slice 8.18** `[CORE / DATA]` : Check every relative Markdown link in the root and docs/ against the repo, fix the dead ones, and add a test that fails on a dead link. Target files: `docs/engineering-ticket-bank.md`, `tests/docsLinks.test.ts`, `.spec/PROGRESS.md` | Verify: `npm test --silent && npm run lint --silent`




- [x] **Slice 8.16** `[CORE / DATA]`: Record the archive state and the open PR list in the session handoff, and check the handoff fields with a test. Target files: `.spec/SESSION_HANDOFF.md`, `.spec/PROGRESS.md`, `tests/sessionHandoff.test.ts`, `tests/progressArchive.test.ts` | Verify: `npm test --silent && npm run lint --silent`
