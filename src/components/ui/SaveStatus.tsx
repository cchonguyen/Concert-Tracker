import { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { saveLabel, type SaveTrack } from '../../services/saveStatus';

interface Props<P> {
  track: SaveTrack<P>;
  onRetry: () => void;
  hint?: boolean; // The "Changes save as you go" line, for the first few opens.
}

// Shows whether edits are saved. It is a polite live region, so a screen reader hears each change without interrupting.
// The age ("2 min ago") is redrawn every 30 seconds.
export function SaveStatus<P>({ track, onRetry, hint = false }: Props<P>) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const label = saveLabel(track, now);
  const failed = track.failed.length > 0 && track.inFlight === 0;
  const saving = track.inFlight > 0;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span role="status" aria-live="polite" className={`inline-flex items-center gap-1 ${failed ? 'text-rose-300' : 'text-zinc-400'}`}>
        {saving && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
        {!saving && !failed && label && <Check className="h-3 w-3 text-emerald-300" aria-hidden="true" />}
        {failed ? (
          <button type="button" onClick={onRetry} className="underline underline-offset-2 hover:text-rose-200">
            {label}
          </button>
        ) : (
          label
        )}
      </span>
      {hint && <span className="text-text-muted max-sm:hidden">{label ? '· ' : ''}Changes save as you go</span>}
    </div>
  );
}
