import React from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import type { LineupSummary, LoggedEvent } from '../services/lineupApi';
import { eventYear, placeLabel, whenLabel } from '../services/format';

interface EventListProps {
  events: LoggedEvent[];
  lineups: Record<string, LineupSummary>;
  researching: Set<string>;
  loaded: boolean;
  onOpen: (id: string) => void;
}

// What an event still needs, as a quiet hint. null = nothing to say.
function hint(e: LoggedEvent, lineup: LineupSummary | undefined, researching: boolean): { text: string; busy?: boolean; tone?: string } | null {
  if (researching) return { text: 'Looking up details', busy: true };
  if (e.details.status === 'needs_date') return { text: 'When was it?', tone: 'text-amber-300/90' };
  if (e.details.status === 'choose') return { text: `Is this it? ${e.details.candidates.length} suggestion${e.details.candidates.length === 1 ? '' : 's'}`, tone: 'text-violet-300' };
  if (lineup && !e.editionId) {
    if (lineup.status === 'queued' || lineup.status === 'running') return { text: 'Finding who played', busy: true };
    if (lineup.status === 'waiting_quota') return { text: 'Lineup lookup waiting for capacity', tone: 'text-amber-300/90' };
    if (lineup.status === 'needs_review') return { text: `Lineup ready: ${lineup.actCount} acts to review`, tone: 'text-emerald-300' };
    if (lineup.status === 'no_data') return { text: 'No lineup found yet' };
    if (lineup.status === 'failed') return { text: 'Lineup lookup failed', tone: 'text-rose-300' };
  }
  return null;
}

const EventCard: React.FC<{ event: LoggedEvent; lineup?: LineupSummary; researching: boolean; onOpen: () => void }> = ({
  event,
  lineup,
  researching,
  onOpen,
}) => {
  const when = whenLabel(event);
  const place = placeLabel(event);
  const h = hint(event, lineup, researching);
  return (
    <button
      onClick={onOpen}
      className="group flex w-full items-center gap-3 rounded-xl border border-zinc-900 bg-zinc-900/40 px-4 py-3 text-left transition-colors hover:border-zinc-800 hover:bg-zinc-900"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="truncate font-semibold text-zinc-100">{event.name}</div>
        <div className="truncate text-xs text-zinc-400">
          {when ?? <span className="text-zinc-600">Date unknown</span>}
          {place && <span> · {place}</span>}
        </div>
        {event.seen.length > 0 && (
          <div className="truncate text-xs text-zinc-300">
            <span className="text-zinc-500">Saw </span>
            {event.seen.map((s) => s.name).join(', ')}
          </div>
        )}
        {h && (
          <div className={`flex items-center gap-1 text-xs ${h.tone ?? 'text-zinc-500'}`}>
            {h.busy && <Loader2 className="h-3 w-3 animate-spin" />}
            {h.text}
          </div>
        )}
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-zinc-700 group-hover:text-zinc-400" />
    </button>
  );
};

export const EventList: React.FC<EventListProps> = ({ events, lineups, researching, loaded, onOpen }) => {
  if (loaded && events.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
        Nothing here yet. Type the last show you went to above; a name is enough, and you can add the rest later.
      </p>
    );
  }
  const groups: Array<{ label: string; events: LoggedEvent[] }> = [];
  for (const e of events) {
    const y = eventYear(e);
    const label = y ? String(y) : 'When?';
    const last = groups[groups.length - 1];
    if (last?.label === label) last.events.push(e);
    else groups.push({ label, events: [e] });
  }
  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <section key={g.label} className="space-y-2">
          <h2 className="flex items-baseline gap-2 text-sm font-bold text-zinc-300">
            {g.label}
            <span className="text-xs font-normal text-zinc-600">
              {g.events.length} event{g.events.length === 1 ? '' : 's'}
            </span>
          </h2>
          {g.events.map((e) => (
            <EventCard key={e.id} event={e} lineup={lineups[e.id]} researching={researching.has(e.id)} onOpen={() => onOpen(e.id)} />
          ))}
        </section>
      ))}
    </div>
  );
};
