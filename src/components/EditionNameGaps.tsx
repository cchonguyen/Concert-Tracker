import React, { useCallback, useEffect, useState } from 'react';
import { canonicalApi } from '../services/lineupApi';

type NameMatch = { editionId: string; editionName: string; artistKey: string; artistName: string };

// Find gaps in Global Archive > Editions: editions whose name starts with a catalog artist who is not on the lineup.
// One tap adds that act; the server re-checks the match and records the change (slice 3, docs/edition-lineup-from-name-spec.md).
export const EditionNameGaps: React.FC = () => {
  const [rows, setRows] = useState<NameMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await canonicalApi.nameMatches()).matches);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the gaps.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (row: NameMatch) => {
    const key = `${row.editionId}:${row.artistKey}`;
    setBusy(key);
    try {
      await canonicalApi.addLineupAct(row.editionId, row.artistKey);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the act.');
    } finally {
      setBusy(null);
    }
  };

  if (rows === null && !error) return null;

  return (
    <section aria-label="Find gaps" className="space-y-2 rounded-lg border border-zinc-800 p-3">
      <h3 className="text-sm font-semibold text-zinc-100">Find gaps: named in the edition, not on the lineup</h3>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      {rows && rows.length === 0 && <p className="text-sm text-zinc-400">Nothing to add: every edition named for an artist already lists them.</p>}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-zinc-800">
          {rows.map((row) => {
            const key = `${row.editionId}:${row.artistKey}`;
            return (
              <li key={key} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-sm text-zinc-200">
                  <span className="font-medium">{row.artistName}</span>
                  <span className="text-zinc-400"> in </span>
                  {row.editionName}
                </span>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void add(row)}
                  className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-100 hover:bg-zinc-800 disabled:opacity-50"
                >
                  {busy === key ? 'Adding…' : 'Add to lineup'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
