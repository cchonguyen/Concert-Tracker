import React, { useEffect, useState } from 'react';
import { canonicalApi } from '../services/lineupApi';
import type { CleanupResult } from '../server/entities/seriesCleanup';
import { Ledger } from './ui/Ledger';

const PREVIEW_BATCH = 20;
const RUN_BATCH = 3;
const OUTCOME: Record<CleanupResult['outcome'], string> = {
  ready: 'Ready',
  done: 'Done',
  unchanged: 'Already done',
  missing: 'Not found',
  failed: 'Failed',
};

// Global Editions: the approved series cleanup (docs/archive/series-cleanup.md). Check shows every step against the
// live records and changes nothing; Run goes through them in small batches, each change logged and undoable in Changes.
export const SeriesCleanupPanel: React.FC = () => {
  const [results, setResults] = useState<CleanupResult[] | null>(null);
  const [busy, setBusy] = useState<'check' | 'run' | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // An emptied list hides the panel: one small preview on mount reads how many steps the list holds.
  const [planSize, setPlanSize] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    canonicalApi.seriesCleanupPreview(0, 1).then((r) => { if (live) setPlanSize(r.total); }, () => { if (live) setPlanSize(null); });
    return () => { live = false; };
  }, []);

  const check = async () => {
    setBusy('check');
    setError(null);
    try {
      const all: CleanupResult[] = [];
      let total = Infinity;
      for (let from = 0; from < total; from += PREVIEW_BATCH) {
        const r = await canonicalApi.seriesCleanupPreview(from, PREVIEW_BATCH);
        total = r.total;
        all.push(...r.results);
        setProgress(`Checked ${Math.min(from + PREVIEW_BATCH, total)} of ${total} steps…`);
      }
      setResults(all);
      setProgress(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check the cleanup.');
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    setBusy('run');
    setError(null);
    try {
      const all: CleanupResult[] = [];
      let total = Infinity;
      for (let from = 0; from < total; from += RUN_BATCH) {
        const r = await canonicalApi.seriesCleanupRun(from, RUN_BATCH);
        total = r.total;
        all.push(...r.results);
        setProgress(`Ran ${Math.min(from + RUN_BATCH, total)} of ${total} steps…`);
      }
      setResults(all);
      const failed = all.filter((r) => r.outcome === 'failed').length;
      setProgress(failed ? `Finished with ${failed} failed. Press Run again to retry them; done steps are skipped.` : 'Finished. Each change can be undone in Changes.');
    } catch (err) {
      setError(`${err instanceof Error ? err.message : 'The run stopped.'} Press Run again to carry on; done steps are skipped.`);
    } finally {
      setBusy(null);
    }
  };

  const counts = results?.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
  const shown = results?.filter((r) => r.outcome !== 'unchanged') ?? [];

  if (planSize === 0) return null;
  return (
    <section aria-label="Series cleanup" className="space-y-2 rounded-card border border-line bg-surface-1 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-base font-normal text-text">Series cleanup</h3>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void check()}
            className="min-h-11 rounded-control border border-line-strong px-2.5 py-1 text-xs text-text hover:bg-surface-2 disabled:opacity-50 sm:min-h-9"
          >
            {busy === 'check' ? 'Checking…' : results ? 'Check again' : 'Check'}
          </button>
          {results && (
            <button
              type="button"
              disabled={busy !== null || !counts?.ready}
              onClick={() => void run()}
              className="min-h-11 rounded-control border border-accent-tint-line bg-accent-tint px-2.5 py-1 font-mono text-xs tabular-nums text-accent hover:underline disabled:opacity-50 sm:min-h-9"
            >
              {busy === 'run' ? 'Running…' : `Run (${counts?.ready ?? 0})`}
            </button>
          )}
        </div>
      </div>
      {!results && <p className="text-xs text-text-muted">The loose-ends cleanup list from 27 November. Check shows each change first; nothing changes until you press Run.</p>}
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      {progress && <p role="status" className="text-sm text-text-muted">{progress}</p>}
      {counts && (
        <p className="font-mono text-xs tabular-nums text-text-muted">
          {Object.entries(counts)
            .map(([k, n]) => `${OUTCOME[k as CleanupResult['outcome']]} ${n}`)
            .join(' · ')}
        </p>
      )}
      {shown.length > 0 && (
        <Ledger>
          {shown.map((r) => (
            <Ledger.Row key={r.step} edge={r.outcome === 'failed' || r.outcome === 'missing' ? 'needs' : 'none'} className="flex-col items-stretch gap-0.5 px-3 py-2 text-sm">
              <span className="block text-text">
                <span className="font-mono text-xs tabular-nums text-text-muted">{r.step}. </span>
                {r.note ?? r.target}
              </span>
              <span className="block text-xs text-text-muted">{OUTCOME[r.outcome]}</span>
            </Ledger.Row>
          ))}
        </Ledger>
      )}
    </section>
  );
};
