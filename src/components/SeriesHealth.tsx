import React, { useEffect, useState } from 'react';
import { canonicalApi } from '../services/lineupApi';
import type { SeriesHealthIssue } from '../server/entities/seriesHealth';
import { Equalizer } from './ui/Equalizer';
import { Ledger } from './ui/Ledger';
import { Notice } from './ui/Notice';

// Series health in Data health, owner only (docs/specs/series-sync.md, Rule 2): shared series with no brand or not
// built from their brand, and editions with no series. Each has one offer; nothing changes without a tap, and every
// fix can be undone from History.
const sectionTitle = 'text-xs font-bold uppercase tracking-wide text-text-muted';
const chip =
  'inline-flex min-h-11 sm:min-h-9 items-center gap-1 rounded-full bg-neutral-soft px-2.5 py-1 text-xs text-text hover:bg-accent-tint disabled:opacity-40';

export const SeriesHealth: React.FC = () => {
  const [issues, setIssues] = useState<SeriesHealthIssue[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    canonicalApi
      .seriesHealth()
      .then((r) => setIssues(r.issues))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  useEffect(() => {
    void load();
  }, []);

  const fix = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const { results } = await canonicalApi.fixSeriesIssue(id);
      const failed = results.find((r) => r.outcome === 'failed' || r.outcome === 'missing');
      if (failed) setError(`Step ${failed.step} did not apply${failed.note ? `: ${failed.note}` : '.'}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2">
      <h3 className={sectionTitle}>Shared series</h3>
      <p className="text-xs text-text-muted">
        Series with no brand, names not built from their brand, and editions with no series. Each fix is one tap and can be undone from
        History.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {!issues ? (
        <span role="status" aria-label="Loading series" className="inline-flex items-center text-text-muted">
          <Equalizer />
        </span>
      ) : !issues.length ? (
        <p className="text-sm text-text-muted">None. Every shared series has a brand, and every recurring edition has a series.</p>
      ) : (
        <Ledger>
          {issues.map((i) => (
            <Ledger.Row key={i.id} edge="needs" className="flex-col items-stretch gap-2 p-3">
              <p className="text-sm text-text">{i.title}</p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-text-muted">{i.offer}</span>
                <button onClick={() => void fix(i.id)} disabled={busy !== null} className={chip}>
                  {busy === i.id ? 'Fixing…' : 'Fix'}
                </button>
              </div>
            </Ledger.Row>
          ))}
        </Ledger>
      )}
    </div>
  );
};
