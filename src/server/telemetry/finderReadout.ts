import type { IngestTraceRow } from '../lineup/store/types';

// Owner readout of the research finders (Stage 1.2, docs/specs/event-fetch-upgrade-prd.md).
// Built only from `finder` steps that Stage 1.1 writes into ingest_traces. Counts, outcomes and
// milliseconds only: no page text, no names, no personal fields.

export type FinderOutcome = 'ok' | 'empty' | 'failed' | 'off';

export interface FinderReadoutRow {
  finder: string;
  runs: number; // research runs where the finder was on and ran at least once
  hits: number; // runs where it returned at least one candidate
  empty: number; // runs where it ran and found nothing
  failures: number; // runs where it threw
  successRate: number | null; // hits / runs; null when it never ran
  medianMs: number | null; // median time of the finder calls, null when none
}

const DAY_MS = 86_400_000;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// Only research traces count; saves and backfills have their own finder notes.
export function finderReadout(rows: IngestTraceRow[], now: Date, days = 30): FinderReadoutRow[] {
  const since = now.getTime() - days * DAY_MS;
  const byFinder = new Map<string, { runs: number; hits: number; empty: number; failures: number; ms: number[] }>();
  for (const row of rows) {
    if (row.trigger !== 'research') continue;
    if (new Date(row.createdAt).getTime() < since) continue;
    // One run may call a finder twice (the typed-name retry), so collapse each run to one outcome per finder.
    const perRun = new Map<string, { outcomes: FinderOutcome[]; ms: number[] }>();
    for (const step of row.steps) {
      if (step.name !== 'finder' || !step.detail || typeof step.detail.finder !== 'string') continue;
      const outcome = step.detail.outcome as FinderOutcome;
      const entry = perRun.get(step.detail.finder) ?? { outcomes: [], ms: [] };
      entry.outcomes.push(outcome);
      if (typeof step.detail.ms === 'number') entry.ms.push(step.detail.ms);
      perRun.set(step.detail.finder, entry);
    }
    for (const [finder, { outcomes, ms }] of perRun) {
      if (outcomes.every((o) => o === 'off')) continue;
      const agg = byFinder.get(finder) ?? { runs: 0, hits: 0, empty: 0, failures: 0, ms: [] };
      agg.runs++;
      if (outcomes.includes('ok')) agg.hits++;
      else if (outcomes.includes('failed')) agg.failures++;
      else agg.empty++;
      agg.ms.push(...ms);
      byFinder.set(finder, agg);
    }
  }
  return [...byFinder.entries()]
    .map(([finder, a]) => ({
      finder,
      runs: a.runs,
      hits: a.hits,
      empty: a.empty,
      failures: a.failures,
      successRate: a.runs ? Math.round((a.hits / a.runs) * 1000) / 1000 : null,
      medianMs: median(a.ms),
    }))
    .sort((a, b) => b.runs - a.runs || a.finder.localeCompare(b.finder));
}
