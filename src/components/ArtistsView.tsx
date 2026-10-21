import React, { useMemo, useState } from 'react';
import type { LoggedEvent } from '../services/lineupApi';
import { whenLabel } from '../services/format';
import { eventTitle } from '../services/series';

interface ArtistsViewProps {
  events: LoggedEvent[];
  onOpenEvent: (id: string) => void;
}

// Everyone you've seen, from the acts you marked on each event.
export const ArtistsView: React.FC<ArtistsViewProps> = ({ events, onOpenEvent }) => {
  const [filter, setFilter] = useState('');
  const artists = useMemo(() => {
    const map = new Map<string, { name: string; events: LoggedEvent[] }>();
    for (const e of events) {
      for (const s of e.seen) {
        const entry = map.get(s.key) ?? { name: s.name, events: [] };
        entry.events.push(e);
        map.set(s.key, entry);
      }
    }
    return [...map.values()].sort((a, b) => b.events.length - a.events.length || a.name.localeCompare(b.name));
  }, [events]);
  const shown = artists.filter((a) => a.name.toLowerCase().includes(filter.trim().toLowerCase()));

  if (!artists.length) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
        Nobody yet. Open an event and add who you saw, or find its lineup and tick them.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={`Search ${artists.length} artists`}
        className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm placeholder-zinc-600 focus:border-violet-500 focus:outline-none"
      />
      <ul className="divide-y divide-zinc-900 rounded-xl border border-zinc-900">
        {shown.map((a) => (
          <li key={a.name} className="flex items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="font-semibold text-zinc-100">{a.name}</div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 pt-0.5 text-xs text-zinc-400">
                {a.events.map((e) => (
                  <button key={e.id} onClick={() => onOpenEvent(e.id)} className="hover:text-violet-300 hover:underline">
                    {eventTitle(e)}
                    {whenLabel(e) ? `, ${whenLabel(e)}` : ''}
                  </button>
                ))}
              </div>
            </div>
            <span className="shrink-0 rounded-full bg-zinc-900 px-2 py-0.5 text-xs font-semibold text-zinc-300">×{a.events.length}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};
