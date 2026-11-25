import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, CalendarDays, CalendarHeart, Check, Clock, Mail, MapPin, Mic, Sparkles, Table2, Ticket, TriangleAlert, CircleHelp } from 'lucide-react';
import type { LineupSummary, LoggedEvent } from '../services/lineupApi';
import { dateConfirmations, placeLabel, whenLabel } from '../services/format';
import { homeSummary } from '../services/home';
import { eventScale } from '../server/events/scale';
import { EventTitle } from './EventTitle';
import { Tabs } from './ui/Tabs';
import { Ledger, type LedgerEdge } from './ui/Ledger';
import { KindPill } from './ui/KindPill';
import { HintPill, type HintTone } from './ui/HintPill';

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

interface Hint {
  text: string;
  tone: HintTone;
}

// What an event still needs, as a short hint pill. null = nothing to say.
function hint(e: LoggedEvent, lineup: LineupSummary | undefined, researching: boolean): Hint | null {
  if (researching) return { text: 'Looking up details', tone: 'busy' };
  if (e.details.status === 'candidates' && e.details.candidates.some((c) => Boolean(c.editionId))) {
    return { text: 'Which edition?', tone: 'needs' };
  }
  if (e.editionId && !e.weekend && !e.startDate) return { text: 'Which weekend?', tone: 'needs' };
  if (e.details.status === 'needs_date') return { text: 'When was it?', tone: 'needs' };
  if (e.details.status === 'choose') {
    if (e.details.candidates.some((c) => Boolean(c.editionId))) return { text: 'Which edition?', tone: 'needs' };
    return {
      text: e.startDate ? 'Sources give a different date' : `Is this it? ${e.details.candidates.length} suggestion${e.details.candidates.length === 1 ? '' : 's'}`,
      tone: 'needs',
    };
  }
  if (lineup && !e.editionId) {
    if (lineup.status === 'queued' || lineup.status === 'running') return { text: 'Finding who played', tone: 'busy' };
    if (lineup.status === 'waiting_quota') return { text: 'Lineup lookup waiting for capacity', tone: 'needs' };
    if (lineup.status === 'needs_review') return { text: `Lineup ready: ${lineup.actCount} acts to review`, tone: 'done' };
    if (lineup.status === 'no_data') return { text: 'No lineup found yet', tone: 'info' };
    if (lineup.status === 'failed') return { text: 'Lineup lookup failed', tone: 'needs' };
  }
  return null;
}

const Row: React.FC<{ event: LoggedEvent; lineup?: LineupSummary; researching: boolean; ask?: boolean; onOpen: () => void }> = ({
  event,
  lineup,
  researching,
  ask,
  onOpen,
}) => {
  // Over and not confirmed: the one thing it needs is your answer.
  const h: Hint | null = ask ? { text: 'Did you go?', tone: 'needs' } : hint(event, lineup, researching);
  const place = placeLabel(event);
  const seen = event.seen.map((s) => s.name).join(', ');
  const scale = eventScale(event).kind;
  const kind = scale === 'festival' ? 'festival' : scale === 'concert' ? 'show' : 'unknown';
  const edge: LedgerEdge = h?.tone === 'needs' ? 'needs' : kind === 'unknown' ? 'none' : kind;
  const pills = (
    <>
      {h && <HintPill tone={h.tone}>{h.text}</HintPill>}
      <KindPill kind={kind} size="sm" />
    </>
  );
  return (
    <Ledger.Row edge={edge} onOpen={onOpen} className="px-3 py-2.5">
      <span className="w-24 shrink-0 self-start pt-0.5 font-mono text-[11.5px] leading-snug tabular-nums text-text-muted sm:w-32">
        {whenLabel(event) ?? 'Date unknown'}
        {dateConfirmations(event).length > 0 && <Check className="ml-1 inline h-3 w-3 text-good" aria-label="Date confirmed" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-text"><EventTitle event={event} /></span>
        <span className="block truncate text-xs text-text-muted">{[place, seen && `saw ${seen}`].filter(Boolean).join(' · ')}</span>
        {/* Phones put the pills under the name; wider screens put them at the end of the row. */}
        <span className="mt-1.5 flex flex-wrap gap-1.5 sm:hidden">{pills}</span>
      </span>
      <span className="hidden shrink-0 items-center gap-1.5 sm:flex">{pills}</span>
    </Ledger.Row>
  );
};

// Year separators in list order, with the undated events last under "No date yet".
function byYear(list: LoggedEvent[]): Array<[string, LoggedEvent[]]> {
  const groups = new Map<string, LoggedEvent[]>();
  for (const e of list) {
    const key = e.startDate ? e.startDate.slice(0, 4) : 'No date yet';
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const undated = groups.get('No date yet');
  groups.delete('No date yet');
  return [...groups.entries(), ...(undated ? [['No date yet', undated] as [string, LoggedEvent[]]] : [])];
}

type ListTab = 'recent' | 'upcoming' | 'confirm' | 'added';

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
  const upcoming = s.upcoming.filter((e) => !addedIds.has(e.id));

  // Open "Just added" when there is something new, so a capture shows up at once.
  const [tab, setTab] = useState<ListTab>(added.length ? 'added' : 'recent');
  const addedCount = useRef(added.length);
  useEffect(() => {
    if (added.length > addedCount.current) setTab('added');
    addedCount.current = added.length;
  }, [added.length]);

  const yearsAgo = (e: LoggedEvent) => {
    const n = Number(today.slice(0, 4)) - Number(e.startDate!.slice(0, 4));
    return n === 1 ? 'a year ago' : `${n} years ago`;
  };

  if (loaded && events.length === 0) {
    return (
      <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-sm text-text-muted">
        Nothing here yet. Type the last show you went to above; a name is enough, and you can add the rest later.
      </p>
    );
  }

  const tasks = [
    toReview > 0 && { label: `${toReview} from your email to review`, mail: true, onClick: onReviewEmail },
    !toReview && emailCheck && { label: 'Check email for new tickets', mail: true, onClick: onReviewEmail },
    s.toConfirm.length > 0 && {
      label: `${s.toConfirm.length} to confirm you went`,
      onClick: () => (s.toConfirm.length === 1 ? onOpen(s.toConfirm[0].id) : onOpenTable('went=confirm')),
    },
    s.needs.date > 0 && { label: `${s.needs.date} need a date`, onClick: () => onOpenTable('needs=date') },
    s.needs.pick > 0 && { label: `${s.needs.pick} waiting on a pick`, onClick: () => onOpenTable('needs=pick') },
    s.needs.review > 0 && { label: `${s.needs.review} lineup${s.needs.review === 1 ? '' : 's'} to review`, onClick: () => onOpenTable('needs=review') },
  ].filter(Boolean) as Array<{ label: string; mail?: boolean; onClick: () => void }>;

  const tiles: Array<[string, number, string, React.ElementType]> = [
    ['Events', s.events, 'went=went', Ticket],
    ['Artists seen', s.artists, '', Mic],
    ['Venues', s.venues, '', MapPin],
    [`In ${today.slice(0, 4)}`, s.thisYear, `from=${today.slice(0, 4)}&to=${today.slice(0, 4)}&went=went`, CalendarDays],
  ];

  const lists: Record<ListTab, LoggedEvent[]> = { recent, upcoming, confirm: s.toConfirm, added };
  const tabItems = [
    { value: 'recent' as const, label: 'Recent', icon: Clock, count: recent.length },
    upcoming.length > 0 && { value: 'upcoming' as const, label: 'Coming up', icon: CalendarClock, count: upcoming.length },
    s.toConfirm.length > 0 && { value: 'confirm' as const, label: 'Did you go?', icon: CircleHelp, count: s.toConfirm.length },
    added.length > 0 && { value: 'added' as const, label: 'Just added', icon: Sparkles, count: added.length },
  ].filter(Boolean) as Array<{ value: ListTab; label: string; icon: typeof Clock; count: number }>;
  // A tab whose list has emptied falls back to Recent.
  const open: ListTab = tabItems.some((t) => t.value === tab) ? tab : 'recent';
  const shown = lists[open];

  return (
    <div className="space-y-6">
      {tasks.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tasks.map((t) => (
            <button
              key={t.label}
              onClick={t.onClick}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-line bg-surface-1 px-3 text-xs font-semibold text-text hover:border-line-strong hover:bg-surface-2 sm:min-h-9"
            >
              {t.mail ? (
                <Mail className="h-3.5 w-3.5 text-accent" strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <TriangleAlert className="h-3.5 w-3.5 text-warn" strokeWidth={2} aria-hidden="true" />
              )}
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map(([label, value, query, Icon]) => (
          <button
            key={label}
            onClick={() => onOpenTable(query)}
            className="flex items-center gap-3 rounded-card border border-line bg-surface-1 px-3.5 py-3 text-left hover:border-line-strong hover:bg-surface-2"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-accent-tint text-accent">
              <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-2xl font-extrabold leading-none tracking-tight tabular-nums text-text">{value}</span>
              <span className="mt-1 block truncate text-xs text-text-muted">{label}</span>
            </span>
          </button>
        ))}
      </div>

      {s.onThisDay.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-text">
          <CalendarHeart className="h-4 w-4 text-accent" strokeWidth={1.75} aria-hidden="true" />
          <span className="text-text-muted">On this day:</span>
          {s.onThisDay.map((e, i) => (
            <button key={e.id} onClick={() => onOpen(e.id)} className="hover:text-accent hover:underline">
              <EventTitle event={e} />, {yearsAgo(e)}{i < s.onThisDay.length - 1 ? ';' : ''}
            </button>
          ))}
        </p>
      )}

      {(shown.length > 0 || tabItems.length > 1) && (
        <section>
          <Tabs label="Event lists" items={tabItems} value={open} onChange={setTab} panel="surface-1" />
          <Ledger className="border-t-0">
            {shown.length === 0 && <p className="px-3.5 py-4 text-sm text-text-muted">Nothing here yet.</p>}
            {byYear(shown).map(([year, list]) => (
              <React.Fragment key={year}>
                <Ledger.Separator label={year} count={list.length} />
                {list.map((e) => (
                  <Row
                    key={e.id}
                    event={e}
                    lineup={lineups[e.id]}
                    researching={open === 'confirm' ? false : researching.has(e.id)}
                    ask={open === 'confirm'}
                    onOpen={() => onOpen(e.id)}
                  />
                ))}
              </React.Fragment>
            ))}
          </Ledger>
        </section>
      )}

      <button onClick={() => onOpenTable('')} className="inline-flex min-h-11 items-center gap-1.5 text-sm text-accent hover:underline sm:min-h-9">
        <Table2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> See all {events.length} events in the Table
      </button>
    </div>
  );
};
