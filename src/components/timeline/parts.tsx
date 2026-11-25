import React from 'react';
import { CalendarX, ChevronRight } from 'lucide-react';
import type { LoggedEvent } from '../../services/lineupApi';
import type { TimelineAttendance } from '../../services/timeline';
import { eventTitle } from '../../services/series';
import { HintPill } from '../ui/HintPill';
import { Ledger } from '../ui/Ledger';
import { Stars } from '../ui/Stars';

// Building blocks every timeline view shares, so a change to how "upcoming"
// or "waiting to confirm" looks happens in one place.

// Went = solid, upcoming = outlined, waiting to confirm = outlined with a "?".
export const ATTENDANCE_STYLE: Record<TimelineAttendance, string> = {
  went: 'border-line bg-surface-1',
  upcoming: 'border-dashed border-accent-tint-line bg-transparent',
  confirm: 'border-dashed border-warn/60 bg-transparent',
};

export const ConfirmMark: React.FC = () => <HintPill tone="needs">Did you go?</HintPill>;

export const Rating: React.FC<{ rating?: number | null }> = ({ rating }) =>
  rating ? <Stars value={rating} size="sm" /> : null;

// One dot per day of a run, filled for the days you went.
export const DayDots: React.FC<{ all: string[]; went: string[] }> = ({ all, went }) => (
  <span className="flex gap-0.5" aria-label={`${went.length} of ${all.length} days`}>
    {all.map((d) => (
      <span key={d} className={`h-1.5 w-1.5 rounded-full ${went.includes(d) ? 'bg-accent-fill' : 'border border-line-strong'}`} />
    ))}
  </span>
);

// Events with no date at all: never placed, listed here with a way to fix them.
export const NoDateTray: React.FC<{ events: LoggedEvent[]; onOpen: (id: string) => void }> = ({ events, onOpen }) =>
  events.length ? (
    <details className="border border-line-strong bg-surface-1">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3.5 py-2 text-sm text-text sm:min-h-9">
        <CalendarX className="h-4 w-4 text-text-muted" aria-hidden="true" />
        <span>No date yet</span>
        <span className="font-mono text-xs tabular-nums text-text-muted">{events.length}</span>
      </summary>
      <Ledger bare className="border-t border-line">
        {events.map((e) => (
          <Ledger.Row key={e.id} edge="needs" onOpen={() => onOpen(e.id)} className="px-3.5 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate text-text">{eventTitle(e)}</span>
            <span className="text-xs text-text-muted group-hover:text-text">Add a date</span>
            <ChevronRight className="h-4 w-4 text-text-faint group-hover:text-text-muted" aria-hidden="true" />
          </Ledger.Row>
        ))}
      </Ledger>
    </details>
  ) : null;
