import React, { useMemo } from 'react';
import { CalendarHeart, Check, ChevronRight, Loader2, Mail, Table2 } from 'lucide-react';
import type { LineupSummary, LoggedEvent } from '../services/lineupApi';
import { dateConfirmations, placeLabel, whenLabel } from '../services/format';
import { homeSummary } from '../services/home';

interface EventsHomeProps {
  events: LoggedEvent[];
  lineups: Record<string, LineupSummary>;
  researching: Set<string>;
  justAdded: string[]; // ids captured since the page loaded, newest first
  toReview: number; // email rows waiting for review
  emailCheck: boolean; // Check email is set up, so the review list is worth opening when empty
  loaded: boolean;
  onOpen: (id: string) => void;
  onReviewEmail: () => void;
  onOpenTable: (query: string) => void;
}

// What an event still needs, as a quiet hint. null = nothing to say.
function hint(e: LoggedEvent, lineup: LineupSummary | undefined, researching: boolean): { text: string; busy?: boolean; tone?: string } | null {
  if (researching) return { text: 'Looking up details', busy: true };
  if (e.details.status === 'needs_date') return { text: 'When was it?', tone: 'text-amber-300/90' };
  if (e.details.status === 'choose')
    return {
      text: e.startDate ? 'Sources give a different date' : `Is this it? ${e.details.candidates.length} suggestion${e.details.candidates.length === 1 ? '' : 's'}`,
      tone: 'text-violet-300',
    };
  if (lineup && !e.editionId) {
    if (lineup.status === 'queued' || lineup.status === 'running') return { text: 'Finding who played', busy: true };
    if (lineup.status === 'waiting_quota') return { text: 'Lineup lookup waiting for capacity', tone: 'text-amber-300/90' };
    if (lineup.status === 'needs_review') return { text: `Lineup ready: ${lineup.actCount} acts to review`, tone: 'text-emerald-300' };
    if (lineup.status === 'no_data') return { text: 'No lineup found yet' };
    if (lineup.status === 'failed') return { text: 'Lineup lookup failed', tone: 'text-rose-300' };
  }
  return null;
}

const Row: React.FC<{ event: LoggedEvent; lineup?: LineupSummary; researching: boolean; onOpen: () => void }> = ({
  event,
  lineup,
  researching,
  onOpen,
}) => {
  const h = hint(event, lineup, researching);
  const place = placeLabel(event);
  const seen = event.seen.map((s) => s.name).join(', ');
  return (
    <li>
      <button onClick={onOpen} className="group flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-900/60">
        <span className="w-24 shrink-0 text-xs text-zinc-500">
          {whenLabel(event) ?? 'Date unknown'}
          {dateConfirmations(event).length > 0 && <Check className="ml-1 inline h-3 w-3 text-emerald-400" aria-label="Date confirmed" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-zinc-100">{event.name}</span>
          <span className="block truncate text-xs text-zinc-500">
            {[place, seen && `saw ${seen}`].filter(Boolean).join(' · ')}
            {h && (
              <span className={`${place || seen ? 'ml-1' : ''} inline-flex items-center gap-1 ${h.tone ?? ''}`}>
                {h.busy && <Loader2 className="h-3 w-3 animate-spin" />}
                {h.text}
              </span>
            )}
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-zinc-700 group-hover:text-zinc-400" />
      </button>
    </li>
  );
};

const Section: React.FC<{ title: string; icon?: React.ReactNode; children: React.ReactNode }> = ({ title, icon, children }) => (
  <section className="space-y-2">
    <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-zinc-500">
      {icon}
      {title}
    </h2>
    <ul className="divide-y divide-zinc-900 rounded-xl border border-zinc-900 bg-zinc-900/30">{children}</ul>
  </section>
);

export const EventsHome: React.FC<EventsHomeProps> = ({
  events,
  lineups,
  researching,
  justAdded,
  toReview,
  emailCheck,
  loaded,
  onOpen,
  onReviewEmail,
  onOpenTable,
}) => {
  const today = new Date().toISOString().slice(0, 10);
  const s = useMemo(() => homeSummary(events, lineups, today), [events, lineups, today]);
  const added = justAdded.map((id) => events.find((e) => e.id === id)).filter((e): e is LoggedEvent => Boolean(e));
  const addedIds = new Set(added.map((e) => e.id));
  const recent = s.recent.filter((e) => !addedIds.has(e.id));
  const yearsAgo = (e: LoggedEvent) => {
    const n = Number(today.slice(0, 4)) - Number(e.startDate!.slice(0, 4));
    return n === 1 ? 'a year ago' : `${n} years ago`;
  };
  const row = (e: LoggedEvent) => (
    <Row key={e.id} event={e} lineup={lineups[e.id]} researching={researching.has(e.id)} onOpen={() => onOpen(e.id)} />
  );

  if (loaded && events.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
        Nothing here yet. Type the last show you went to above; a name is enough, and you can add the rest later.
      </p>
    );
  }

  const tasks = [
    toReview > 0 && { label: `${toReview} from your email to review`, icon: <Mail className="h-3.5 w-3.5" />, onClick: onReviewEmail },
    !toReview && emailCheck && { label: 'Check email for new tickets', icon: <Mail className="h-3.5 w-3.5" />, onClick: onReviewEmail },
    s.needs.date > 0 && { label: `${s.needs.date} need a date`, onClick: () => onOpenTable('needs=date') },
    s.needs.pick > 0 && { label: `${s.needs.pick} waiting on a pick`, onClick: () => onOpenTable('needs=pick') },
    s.needs.review > 0 && { label: `${s.needs.review} lineup${s.needs.review === 1 ? '' : 's'} to review`, onClick: () => onOpenTable('needs=review') },
  ].filter(Boolean) as Array<{ label: string; icon?: React.ReactNode; onClick: () => void }>;

  const tiles: Array<[string, number, string]> = [
    ['Events', s.events, ''],
    ['Artists seen', s.artists, ''],
    ['Venues', s.venues, ''],
    [`In ${today.slice(0, 4)}`, s.thisYear, `from=${today.slice(0, 4)}&to=${today.slice(0, 4)}`],
  ];

  return (
    <div className="space-y-6">
      {tasks.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tasks.map((t) => (
            <button
              key={t.label}
              onClick={t.onClick}
              className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-950/30 px-3 py-1 text-xs text-violet-200 hover:border-violet-400"
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map(([label, value, query]) => (
          <button
            key={label}
            onClick={() => onOpenTable(query)}
            className="rounded-xl border border-zinc-900 bg-zinc-900/40 px-4 py-3 text-left hover:border-zinc-800"
          >
            <div className="text-2xl font-extrabold tracking-tight text-zinc-100">{value}</div>
            <div className="text-xs text-zinc-500">{label}</div>
          </button>
        ))}
      </div>

      {s.onThisDay.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-zinc-300">
          <CalendarHeart className="h-4 w-4 text-violet-300" />
          <span className="text-zinc-500">On this day:</span>
          {s.onThisDay.map((e, i) => (
            <button key={e.id} onClick={() => onOpen(e.id)} className="hover:text-violet-300 hover:underline">
              {e.name}, {yearsAgo(e)}{i < s.onThisDay.length - 1 ? ';' : ''}
            </button>
          ))}
        </p>
      )}

      {added.length > 0 && <Section title="Just added">{added.map(row)}</Section>}
      {s.upcoming.some((e) => !addedIds.has(e.id)) && (
        <Section title="Coming up">{s.upcoming.filter((e) => !addedIds.has(e.id)).map(row)}</Section>
      )}
      {recent.length > 0 && <Section title="Recent">{recent.map(row)}</Section>}

      <button onClick={() => onOpenTable('')} className="inline-flex items-center gap-1.5 text-sm text-violet-300 hover:text-violet-200">
        <Table2 className="h-3.5 w-3.5" /> See all {s.events} events in the Table
      </button>
    </div>
  );
};
