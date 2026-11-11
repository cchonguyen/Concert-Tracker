# Task Progress & Single-Slice Work Lock

> Rule: Mark only ONE task line at a time with the active work tag.

## Canonical edition suggestions (plan: /mnt/project-files/canonical-autocomplete/plan.md)
Contracts: SYSTEM_SPEC.md section 3 ("Canonical edition suggestions"). Order: 9.1, 9.2, 9.3, 9.4, 9.5.

- [ ] **Slice 9.1** [IN_PROGRESS] `[CORE / DATA]` : Add the confirmed-edition suggestion search (`suggestEditions` in both stores and `GET /api/editions/suggest?q=`), excluding the caller's live-event editions. Target files: `src/server/lineup/store/types.ts`, `src/server/lineup/store/fileStore.ts`, `src/server/lineup/store/supabaseStore.ts`, `src/server/lineup/routes.ts`, `tests/editionSuggest.test.ts` [NEW], `.spec/PROGRESS.md` | Verify: `npm test --silent && npm run lint --silent`
- [ ] **Slice 9.2** `[UI / VISUAL]` : Show up to 5 debounced edition suggestions under the capture bar in the shared Popover, with keyboard and tap, where Enter with no pick still saves the typed line. Target files: `src/components/CaptureBar.tsx`, `src/services/lineupApi.ts`, `.spec/PROGRESS.md` | Verify: `npm test --silent && npm run lint --silent`
- [ ] **Slice 9.3** `[CORE / DATA]` : Accept `editionId` on `POST /api/events` and build the event with `newEventFromEdition` (copied facts sourced 'edition', edition linked, status matched, no personal fields), and add R1.15 and the matching architecture text. Target files: `src/server/events/service.ts`, `src/server/events/routes.ts`, `src/server/events/types.ts`, `tests/eventFromEdition.test.ts` [NEW], `REQUIREMENTS.md`, `docs/architecture/02-stage-1-capture-and-details.md`, `docs/architecture/13-api.md`, `.spec/PROGRESS.md` | Verify: `npm test --silent && npm run lint --silent`
- [ ] **Slice 9.4** `[UI / VISUAL]` : Save from a tapped suggestion with `editionId`, skip the automatic research call, open the event with its lineup, add the "I saw everyone" one-tap, and label field sources "from the canonical edition". Target files: `src/components/CaptureBar.tsx`, `src/App.tsx`, `src/components/LineupReview.tsx`, `src/components/EventDetail.tsx`, `.spec/PROGRESS.md` | Verify: `npm test --silent && npm run lint --silent`
- [ ] **Slice 9.5** `[CORE / DATA]` : Look up weather once, server-side, after a save from an edition, storing it only when Open-Meteo places the city exactly. Target files: `src/server/events/routes.ts`, `tests/eventFromEdition.test.ts`, `.spec/PROGRESS.md` | Verify: `npm test --silent && npm run lint --silent`


## Share page (spec approved 2026-10-28 after Gemini review: https://claude.ai/artifact/9kJinrnXRiu4EMPNCA8VbK)
A read-only page at `/s/<code>` outside Cloudflare Access. Only allow-listed fields; only events fully over in the link's time zone; the public route never writes. Migration 0015 (0014 is Manage's).


## Manage section (triaged 2026-10-28, revised after Gemini audit)
Contracts: SYSTEM_SPEC.md section 3. `[CORE / DATA]` slices need passing unit tests (`npm test`, Node's test runner over `tests/*.test.ts`); `[UI / VISUAL]` slices run `npm run lint`, and per AGENTS.md also `npm test`, before commit.


## Tier 3 (specs: docs/tier3-specs.md, build order row 1)

## Global Archive UX (spec: `docs/canonical-archive-ux-spec.md`)


## Audit follow-up (plan approved 2026-11-04: /mnt/project-files/audit-2026-11-04/plan.md)

- [x] **Slice 8.23** `[CORE / DATA]` : In the open ticket bank, mark each file path that a ticket names but the repo does not have as "(planned, not yet created)", so a reader can tell planned files from dead links. Change no ticket meaning. Target files: `docs/engineering-ticket-bank.md`, `tests/docsLinks.test.ts`, `.spec/PROGRESS.md` | Verify: `npm test --silent && npm run lint --silent`

- [x] **Slice 8.18** `[CORE / DATA]` : Check every relative Markdown link in the root and docs/ against the repo, fix the dead ones, and add a test that fails on a dead link. Target files: `docs/engineering-ticket-bank.md`, `tests/docsLinks.test.ts`, `.spec/PROGRESS.md` | Verify: `npm test --silent && npm run lint --silent`
- [x] **Slice 8.22** `[CORE / DATA]` : Delete bun.lock (lockfile v2, unreadable by the bun 1.2.15 that Cloudflare Workers Builds uses), keep package-lock.json as the only lockfile, and add a test that fails if bun.lock comes back. Target files: `bun.lock`, `tests/lockfile.test.ts` [NEW], `.spec/PROGRESS.md` | Verify: `npm test --silent && npm run lint --silent`
- [x] **Slice 8.21** `[CORE / DATA]` : Add a test that every ticket in the closed archive carries a Closed line, so a moved ticket cannot lose its verdict. Target files: `tests/docsLinks.test.ts`, `.spec/PROGRESS.md` | Verify: `npm test --silent && npm run lint --silent`
- [x] **Slice 8.20** `[CORE / DATA]` : Audit the 13 unchecked open tickets (SEC-03, PERF-03, REL-01, REF-03, A11Y-03, LINEUP-02, LINEUP-03, LINEUP-04, PERF-04, TECH-01, TECH-02, TECH-03, TECH-04) against the code, move any found DONE or OBSOLETE to docs/archive/engineering-ticket-bank-closed.md, and add the verdict under each one that stays open. Target files: `docs/engineering-ticket-bank.md`, `docs/archive/engineering-ticket-bank-closed.md`, `tests/docsLinks.test.ts`, `.spec/PROGRESS.md` | Verify: `npm test --silent && npm run lint --silent`
- [x] **Slice 8.19** `[CORE / DATA]` : Move the six tickets verified DONE or OBSOLETE (SEC-01, SEC-02, REF-01, REF-04, LINEUP-01, TECH-05) to docs/archive/engineering-ticket-bank-closed.md, keep every other ticket in the open file, and add a test that the two files share no ticket ID. Target files: `docs/engineering-ticket-bank.md`, `docs/archive/engineering-ticket-bank-closed.md` [NEW], `tests/docsLinks.test.ts`, `.spec/PROGRESS.md` | Verify: `npm test --silent && npm run lint --silent`




- [x] **Slice 8.16** `[CORE / DATA]`: Record the archive state and the open PR list in the session handoff, and check the handoff fields with a test. Target files: `.spec/SESSION_HANDOFF.md`, `.spec/PROGRESS.md`, `tests/sessionHandoff.test.ts`, `tests/progressArchive.test.ts` | Verify: `npm test --silent && npm run lint --silent`
