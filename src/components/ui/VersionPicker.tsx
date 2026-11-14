import { useState } from 'react';

// One Clashfinder version of an event, as the lookup route lists it.
export interface LineupVersion {
  slug: string;
  name: string;
  startDate?: string;
  lastEdit?: string;
  edits?: number;
  numActs?: number;
  url: string;
}

interface Props {
  // Fetched only when the person asks, so the automatic pick costs no extra call.
  load: () => Promise<LineupVersion[]>;
  // Set when the edition already has a confirmed lineup: a pick then needs a second tap.
  confirmedActs?: number;
  busy?: boolean;
  onPick: (version: LineupVersion, replaceConfirmed: boolean) => void;
}

// "Not this version?" list. Opens only when asked, so the automatic pick stays
// the one-step path. Each row names the version it would use.
export function VersionPicker({ load, confirmedActs, busy, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<LineupVersion[] | null>(null);
  // The server's own reason (for example a Clashfinder credential error), so the cause is visible.
  const [failed, setFailed] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const replacing = confirmedActs !== undefined;

  const show = async () => {
    setOpen(true);
    setFailed(null);
    setVersions(null);
    try {
      setVersions(await load());
    } catch (err) {
      setFailed(err instanceof Error && err.message ? err.message : 'Could not load the Clashfinder versions.');
    }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => void show()} className="text-xs text-zinc-400 underline-offset-2 hover:text-violet-300 hover:underline">
        Not this version?
      </button>
    );
  }

  if (failed) {
    return (
      <div className="space-y-1">
        <p className="text-xs text-amber-300/90">{failed}</p>
        <div className="flex gap-3">
          <button type="button" onClick={() => void show()} className="text-xs text-zinc-300 hover:text-violet-300">Try again</button>
          <button type="button" onClick={() => setOpen(false)} className="text-xs text-zinc-400 hover:text-violet-300">Close</button>
        </div>
      </div>
    );
  }

  if (versions === null) {
    return <p className="text-xs text-zinc-400">Loading Clashfinder versions…</p>;
  }

  if (versions.length === 0) {
    return (
      <div className="space-y-1">
        <p className="text-xs text-zinc-400">No other Clashfinder versions match this event.</p>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-zinc-400 hover:text-violet-300">Close</button>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-zinc-300">Clashfinder versions, most recently edited first</p>
        <button type="button" onClick={() => { setOpen(false); setPending(null); }} className="text-xs text-zinc-400 hover:text-violet-300">Close</button>
      </div>
      <ul className="space-y-1.5">
        {versions.map((v) => {
          const awaiting = pending === v.slug;
          return (
            <li key={v.slug} className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="min-w-0 text-zinc-200">
                {v.name}
                <span className="text-zinc-500">
                  {' '}· {v.startDate ?? 'no date'} · {v.numActs ?? 0} acts{v.lastEdit ? ` · edited ${v.lastEdit}` : ''}
                </span>
              </span>
              {awaiting ? (
                <span className="flex items-center gap-2">
                  <span className="text-zinc-400">{replacing ? `Replace the confirmed lineup (${confirmedActs} acts)?` : 'Use this version?'}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { onPick(v, replacing); setPending(null); setOpen(false); }}
                    className="rounded-md bg-violet-600 px-2 py-1 text-white hover:bg-violet-500 disabled:opacity-50"
                  >
                    Confirm
                  </button>
                  <button type="button" onClick={() => setPending(null)} className="text-zinc-400 hover:text-zinc-200">Cancel</button>
                </span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => (replacing ? setPending(v.slug) : (onPick(v, false), setOpen(false)))}
                  className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-200 hover:border-violet-400 disabled:opacity-50"
                >
                  Use this
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
