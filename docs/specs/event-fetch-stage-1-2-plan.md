# Event fetch upgrade, Stage 1.2: owner-only finder readout

Source: `docs/specs/event-fetch-upgrade-prd.md`, Stage 1 row 1.2.

## Goal

Give the owner a small readout of how each research finder performed over the last 30 days: runs, hits, failures and success rate. It reads the structured finder steps that Slice 1.1 already stores in research traces. It adds no research-time subrequests and holds no page text or personal fields.

## Slices (server first)

1. **Slice 20.2 (#493), CORE / DATA, server.** `src/server/telemetry/finderReadout.ts` (pure aggregation), `GET /api/lineup/finder-readout` in `src/server/lineup/routes.ts`, `tests/finderReadout.test.ts`, and the architecture note in `docs/architecture/02-stage-1-capture-and-details.md`. Verify: `npm test --silent`.
2. **Slice 20.4 (#504), UI / VISUAL, client.** `src/services/lineupApi.ts` client method, `src/components/FinderReadoutPanel.tsx`, rendered from `src/App.tsx` under the reader panel on Manage. Verify: `npm run lint --silent`.

## Acceptance checks

- Owner only: a member calling the endpoint gets 403; the panel is not rendered for members.
- Window: only traces from the last 30 days count; a step at day 31 is excluded, one at day 29 is included.
- Success rate per finder = hits / (hits + empty + failed). Outcome `off` is not a run and is excluded from the denominator. A finder with a zero denominator shows no rate (the UI says "no runs"), never 0% or 100%.
- No page text and no personal fields appear in the response.
- `npm run lint --silent` and `npm test --silent` pass.

## Risks

- Trace volume: aggregating 30 days of `ingest_traces.steps` could read many rows. Select only the steps column, filter by date in the query, and cap rows read; report when the cap truncated the window.
- Median on empty runs: median milliseconds over zero runs is undefined. Return null, not 0, and have the UI show "no data". Even-length sets use the mean of the two middle values.
- Slice numbering: `.spec/PROGRESS.md` already has a finished Slice 20.4 (#494, member lineup offers). The new Slice 20.4 (#504) reuses that number as requested. Renumber one of them if the harness keys on the number.
