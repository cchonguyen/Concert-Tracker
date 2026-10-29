import React from 'react';
import { CalendarX, ChevronRight, Star } from 'lucide-react';
import type { LoggedEvent } from '../../services/lineupApi';
import type { TimelineAttendance } from '../../services/timeline';
import { eventTitle } from '../../services/series';

// Building blocks every timeline view shares, so a change to how "upcoming"
// or "waiting to confirm" looks happens in one place.

// Went = solid, upcoming = outlined, waiting to confirm = outlined with a "?".
export const ATTENDANCE_STYLE: Record<TimelineAttendance, string> = {
  went: 'border-zinc-800 bg-zinc-900/70',
  upcoming: 'border-dashed border-violet-500/50 bg-transparent',
  confirm: 'border-dashed border-amber-400/60 bg-transparent',
};

export const ConfirmMark: React.FC = () => (
  <span className="rounded-full border border-amber-400/60 px-1.5 text-[10px] font-bold text-amber-300" title="Did you go?">
    ?
  </span>
);

export const Rating: React.FC<{ rating?: number | null }> = ({ rating }) =>
  rating ? (
    <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-amber-400" title={`${rating} of 5`} aria-label={`${rating} of 5`}>
      <Star className="h-3 w-3 fill-amber-400" />
      {rating}
    </span>
  ) : null;

// One dot per day of a run, filled for the days you went.
export const DayDots: React.FC<{ all: string[]; went: string[] }> = ({ all, went }) => (
  <span className="flex gap-0.5" aria-label={`${went.length} of ${all.length} days`}>
    {all.map((d) => (
      <span key={d} className={`h-1.5 w-1.5 rounded-full ${went.includes(d) ? 'bg-violet-400' : 'border border-zinc-600'}`} />
    ))}
  </span>
);

// Events with no date at all: never placed, listed here with a way to fix them.
export const NoDateTray: React.FC<{ events: LoggedEvent[]; onOpen: (id: string) => void }> = ({ events, onOpen }) =>
  events.length ? (
    <details className="rounded-xl border border-zinc-800 bg-zinc-900/40">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-zinc-300">
        <CalendarX className="h-4 w-4 text-zinc-400" />
        No date yet
        <span className="text-xs text-zinc-400">{events.length}</span>
      </summary>
      <ul className="divide-y divide-zinc-800/70 border-t border-zinc-800">
        {events.map((e) => (
          <li key={e.id}>
            <button onClick={() => onOpen(e.id)} className="group flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-900/60">
              <span className="min-w-0 flex-1 truncate">{eventTitle(e)}</span>
              <span className="text-xs text-zinc-400 group-hover:text-zinc-300">Add a date</span>
              <ChevronRight className="h-4 w-4 text-zinc-700 group-hover:text-zinc-400" />
            </button>
          </li>
        ))}
      </ul>
    </details>
  ) : null;
