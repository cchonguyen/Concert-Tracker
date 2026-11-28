import React, { useCallback, useEffect, useState } from 'react';
import { canonicalApi } from '../services/lineupApi';

type NameMatch = { editionId: string; editionName: string; artistKey: string; artistName: string };

// Find gaps in Global Archive > Editions: editions whose name starts with a catalog artist who is not on the lineup.
// One tap adds that act; the server re-checks the match and records the change (docs/archive/edition-lineup-from-name-spec.md).
export const EditionNameGaps: React.FC = () => {
  const [rows, setRows] = useState<NameMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  // Hides a gap the owner does not want: that act is not offered for that edition again.
  const dismiss = async (row: NameMatch) => {
    const key = `${row.editionId}:${row.artistKey}`;
    setBusy(key);
    try {
      await canonicalApi.dismissNameMatch(row.editionId, row.artistKey);
      setRows((r) => (r ?? []).filter((x) => `${x.editionId}:${x.artistKey}` !== key));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not dismiss it.');
    } finally {
      setBusy(null);
    }
  };

  // Adds each row in turn, so two acts on one edition never race. A row the server refuses is counted, not retried.
  const addAll = async () => {
    if (!rows?.length) return;
    setBusy('all');
    setNotice(null);
    let failed = 0;
    for (const row of rows) {
      try {
        await canonicalApi.addLineupAct(row.editionId, row.artistKey);
      } catch {
        failed += 1;
      }
    }
    setNotice(failed ? `Added ${rows.length - failed} of ${rows.length}. ${failed} could not be added.` : `Added ${rows.length} to lineups.`);
    await load();
    setBusy(null);
  };

  if (rows === null && !error) return null;

  return (
    <section aria-label="Find gaps" className="space-y-2 rounded-control border border-line p-3">
      <h3 className="font-display text-base font-normal text-text">Find gaps: named in the edition, not on the lineup</h3>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      {notice && <p role="status" className="text-sm text-text-muted">{notice}</p>}
      {rows && rows.length > 1 && (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void addAll()}
          className="inline-flex min-h-11 items-center sm:min-h-9 rounded-control border border-accent px-2.5 py-1 text-xs text-accent hover:bg-accent-tint disabled:opacity-50"
        >
          {busy === 'all' ? 'Adding all…' : `Add all to lineup (${rows.length})`}
        </button>
      )}
      {rows && rows.length === 0 && <p className="text-sm text-text-muted">Nothing to add: every edition named for an artist already lists them.</p>}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-line">
          {rows.map((row) => {
            const key = `${row.editionId}:${row.artistKey}`;
            return (
              <li key={key} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-sm text-text">
                  <span className="font-medium">{row.artistName}</span>
                  <span className="text-text-muted"> in </span>
                  {row.editionName}
                </span>
                <span className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void add(row)}
                  className="inline-flex min-h-11 items-center sm:min-h-9 rounded-control border border-line-strong px-2.5 py-1 text-xs text-text hover:bg-surface-2 disabled:opacity-50"
                >
                  {busy === key ? 'Working…' : 'Add to lineup'}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void dismiss(row)}
                  className="inline-flex min-h-11 items-center sm:min-h-9 rounded-control px-2.5 py-1 text-xs text-text-muted hover:text-text disabled:opacity-50"
                >
                  Dismiss
                </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
