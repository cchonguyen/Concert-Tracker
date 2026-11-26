import React from 'react';
import { Button } from './ui/Button';
import { Pill } from './ui/Pill';
import type { GenreChange, SkippedRow } from '../server/events/genreCsv';
import { changesToSave } from '../server/events/genreCsv';

// "Check before saving": the preview of an edited artist-genres CSV, shown in
// the Genres panel. Nothing is saved here; Apply is the only save. See
// docs/specs/genres-csv.md ("Preview, then Apply", "UI copy").

interface GenresCsvPreviewProps {
  changes: GenreChange[];
  skipped: SkippedRow[];
  overwrite: ReadonlySet<string>;
  onToggleOverwrite: (key: string) => void;
  busy: boolean;
  onApply: () => void;
  onCancel: () => void;
}

// The plain note for one row, as pills: no change, or the warnings that apply.
function RowNotes({ change }: { change: GenreChange }) {
  if (change.sameAsNow) return <Pill>No change</Pill>;
  return (
    <span className="flex flex-wrap gap-1">
      {change.stale && <Pill tone="warn">You changed this in the app after downloading</Pill>}
      {change.after.some((a) => a.isNew) && <Pill tone="accent">New genre, will be added as its own group</Pill>}
    </span>
  );
}

export const GenresCsvPreview: React.FC<GenresCsvPreviewProps> = ({
  changes,
  skipped,
  overwrite,
  onToggleOverwrite,
  busy,
  onApply,
  onCancel,
}) => {
  const willSave = changesToSave(changes, overwrite).length;

  return (
    <section className="space-y-3 rounded-card border border-line bg-surface-1 p-4 text-sm" aria-label="Check before saving">
      <h3 className="font-semibold text-text">Check before saving</h3>

      {changes.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-text-muted">
                <th scope="col" className="py-2 pr-3 font-normal">Artist</th>
                <th scope="col" className="py-2 pr-3 font-normal">Now</th>
                <th scope="col" className="py-2 pr-3 font-normal">New</th>
                <th scope="col" className="py-2 pr-3 font-normal">Note</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <tr key={c.key} className="border-b border-line align-top">
                  <td className="py-2 pr-3 text-text">{c.name}</td>
                  <td className="py-2 pr-3 text-text-muted">{c.before.length ? c.before.join(', ') : 'No genres'}</td>
                  <td className="py-2 pr-3 text-text">{c.after.length ? c.after.map((a) => a.style).join(', ') : 'No genres'}</td>
                  <td className="py-2 pr-3">
                    <RowNotes change={c} />
                    {c.stale && !c.sameAsNow && (
                      <label className="mt-1 flex items-center gap-1.5 text-xs text-text-muted">
                        <input
                          type="checkbox"
                          checked={overwrite.has(c.key)}
                          onChange={() => onToggleOverwrite(c.key)}
                          disabled={busy}
                        />
                        Replace anyway
                      </label>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-text-muted">None of the rows you filled in matched an act.</p>
      )}

      {skipped.length > 0 && (
        <div className="space-y-1">
          <p className="text-text">These rows were left out. Nothing was guessed.</p>
          <ul className="space-y-0.5 text-xs text-text-muted">
            {skipped.map((s) => (
              <li key={`${s.line}-${s.name}`}>
                Line {s.line}{s.name ? `, ${s.name}` : ''}: {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={onApply} disabled={busy || willSave === 0}>
          Apply ({willSave} {willSave === 1 ? 'act' : 'acts'})
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </section>
  );
};
