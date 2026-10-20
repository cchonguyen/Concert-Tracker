import React, { useMemo, useState } from 'react';
import { CalendarDays, Loader2, MapPin, Plus } from 'lucide-react';
import { parseEventInput } from '../server/events/parse';
import { eventsApi, LoggedEvent } from '../services/lineupApi';
import { whenLabel } from '../services/format';

interface CaptureBarProps {
  onCaptured: (event: LoggedEvent) => void;
}

// Stage 1: one line in, saved at once. The preview shows how the line will be
// split, so nothing surprising is stored.
export const CaptureBar: React.FC<CaptureBarProps> = ({ onCaptured }) => {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(() => (text.trim() ? parseEventInput(text) : null), [text]);
  const when = parsed && whenLabel(parsed);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      onCaptured(await eventsApi.create(text));
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <label className="block text-sm font-semibold text-zinc-300" htmlFor="capture">
        What did you go to?
      </label>
      <div className="flex gap-2">
        <input
          id="capture"
          autoFocus
          autoComplete="off"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Porter Robinson at the Greek, Oct 5 2024"
          className="min-w-0 flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-base text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!text.trim() || saving}
          className="inline-flex items-center gap-1.5 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          <span className="hidden sm:inline">Add</span>
        </button>
      </div>
      {parsed && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-zinc-800 px-2.5 py-1 font-semibold text-zinc-100">{parsed.name || '…'}</span>
          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 ${when ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500'}`}>
            <CalendarDays className="h-3 w-3" /> {when ?? 'no date yet (that’s fine)'}
          </span>
          {(parsed.venue || parsed.city) && (
            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2.5 py-1 text-zinc-200">
              <MapPin className="h-3 w-3" /> {[parsed.venue, parsed.city].filter(Boolean).join(', ')}
            </span>
          )}
        </div>
      )}
      {error && <p className="text-sm text-rose-300">{error}</p>}
    </form>
  );
};
