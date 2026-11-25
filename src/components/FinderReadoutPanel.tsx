import { useEffect, useState } from 'react';
import { lineupApi, type FinderReadoutRow } from '../services/lineupApi';

const percent = (n: number | null): string => (n === null ? 'not run' : `${Math.round(n * 100)}%`);
const ms = (n: number | null): string => (n === null ? 'not recorded' : `${n.toLocaleString()} ms`);

// Owner readout of the research finders (Stage 1.2). Observability only: counts, rates and timings.
// Shows nothing when the server refuses (members never see it).
export function FinderReadoutPanel() {
  const [rows, setRows] = useState<FinderReadoutRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    lineupApi
      .finderReadout()
      .then((r) => {
        if (!cancelled) setRows(r.finders);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed || rows === null) return null;
  return (
    <section className="mt-6 space-y-3 text-sm text-text-muted" aria-label="Finders">
      <h3 className="font-semibold text-text">Finders, last 30 days</h3>
      {rows.length === 0 ? (
        <p>No research runs in the last 30 days.</p>
      ) : (
        <table className="w-full text-left">
          <thead className="text-text-muted">
            <tr>
              <th className="py-1 font-normal">Finder</th>
              <th className="py-1 font-normal">Runs</th>
              <th className="py-1 font-normal">Hits</th>
              <th className="py-1 font-normal">Empty</th>
              <th className="py-1 font-normal">Failed</th>
              <th className="py-1 font-normal">Success</th>
              <th className="py-1 font-normal">Median</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.finder} className="border-t border-line">
                <td className="py-1">{r.finder}</td>
                <td className="py-1">{r.runs}</td>
                <td className="py-1">{r.hits}</td>
                <td className="py-1">{r.empty}</td>
                <td className="py-1">{r.failures}</td>
                <td className="py-1">{percent(r.successRate)}</td>
                <td className="py-1">{ms(r.medianMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
