import React, { useEffect, useMemo, useRef, useState } from 'react';
import { placeLabel } from '../../services/format';
import {
  AGENDA_ORDER_KEY,
  AgendaBlock,
  AgendaOrder,
  AgendaRow,
  agendaBlocks,
  agendaCount,
  agendaOrderFrom,
  dateChip,
  daysBetween,
  gapLabel,
  MONTH_NAMES,
  TimelineViewProps,
} from '../../services/timeline';
import { EventTitle } from '../EventTitle';
import { BackToTop } from '../ui/BackToTop';
import { Ledger, type LedgerEdge } from '../ui/Ledger';
import { KindPill, type EventKind } from '../ui/KindPill';
import { HintPill } from '../ui/HintPill';
import { ConfirmMark, DayDots, Rating } from './parts';
import { scrollBehavior } from '../../services/motion';
import { Segmented } from '../ui/Segmented';

// Agenda: one line per event under year separators (no month headers), newest first unless
// you picked oldest first (remembered on this device), opening at the Today line.

const readOrder = (): AgendaOrder => {
  try {
    return agendaOrderFrom(window.localStorage.getItem(AGENDA_ORDER_KEY));
  } catch {
    return 'newest'; // Blocked storage: the default order.
  }
};

const writeOrder = (order: AgendaOrder) => {
  try {
    window.localStorage.setItem(AGENDA_ORDER_KEY, order);
  } catch {
    // Not remembered; the choice still applies to this view.
  }
};

const rowId = (id: string) => `timeline-${id}`;

// Rows sit under year separators only, so each date carries its month.
const monthShort = (m: number) => MONTH_NAMES[m - 1].slice(0, 3);

const kindOfEvent = (kind?: string): EventKind =>
  kind === 'festival' ? 'festival' : kind === 'concert' ? 'show' : 'unknown';

const Row: React.FC<{ row: AgendaRow; selected: boolean; onOpen: (id: string) => void; todayRef: React.Ref<HTMLDivElement> }> = ({
  row,
  selected,
  onOpen,
  todayRef,
}) => {
  if (row.kind === 'today') {
    return (
      <div ref={todayRef} className="today-line px-3.5 py-1.5">
        Today
      </div>
    );
  }
  const item = row.kind === 'span' ? row.span : row.partial;
  const event = item.event;
  const place = placeLabel(event);
  const multi = row.kind === 'span' && row.span.last !== row.span.first;
  const eventKind = kindOfEvent(item.kind);
  const edge: LedgerEdge =
    item.attendance === 'confirm' ? 'needs' : eventKind === 'festival' ? 'festival' : eventKind === 'show' ? 'show' : 'none';

  return (
    <div id={rowId(item.id)}>
      <Ledger.Row edge={edge} selected={selected} onOpen={() => onOpen(item.id)} className="items-start px-3.5 py-2.5 sm:items-center">
        <span className="w-20 shrink-0 font-mono text-xs tabular-nums text-text-muted sm:w-32">
          {row.kind === 'span'
            ? `${monthShort(Number(row.span.first.slice(5, 7)))} · ${dateChip(row.span)}`
            : row.partial.month
              ? `${monthShort(row.partial.month)} · day unknown`
              : 'Month unknown'}
          {multi && (
            <span className="mt-1 block">
              <DayDots all={daysBetween(row.span.first, row.span.last)} went={row.span.days} />
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
          <span className="min-w-0 flex-1 space-y-1">
            <span className="block truncate text-sm font-medium text-text">
              <EventTitle event={event} />
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <KindPill kind={eventKind} size="sm" />
              {place && <span className="truncate text-xs text-text-muted">{place}</span>}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {item.attendance === 'confirm' ? (
              <ConfirmMark />
            ) : item.attendance === 'upcoming' ? (
              <HintPill tone="info">Upcoming</HintPill>
            ) : (
              <Rating rating={event.rating} />
            )}
          </span>
        </span>
      </Ledger.Row>
    </div>
  );
};

interface YearGroup {
  year: number | null;
  items: AgendaBlock[];
  eventCount: number;
}

function groupByYear(blocks: AgendaBlock[]): YearGroup[] {
  const groups: YearGroup[] = [];
  let current: YearGroup | null = null;
  for (const b of blocks) {
    if (b.kind === 'year') {
      current = { year: b.year, items: [], eventCount: 0 };
      groups.push(current);
      continue;
    }
    if (!current) {
      current = { year: b.kind === 'month' ? b.year : null, items: [], eventCount: 0 };
      groups.push(current);
    }
    current.items.push(b);
    if (b.kind === 'month') {
      current.eventCount += b.rows.filter((r) => r.kind !== 'today').length;
    }
  }
  return groups;
}

export const AgendaView: React.FC<TimelineViewProps> = ({ model, range, selectedEventId, onOpen }) => {
  const [order, setOrder] = useState<AgendaOrder>(readOrder);
  const blocks = useMemo(() => agendaBlocks(model, range, true, order), [model, range, order]);
  const groups = useMemo(() => groupByYear(blocks), [blocks]);
  const count = useMemo(() => agendaCount(blocks), [blocks]);
  const todayRef = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  const choose = (next: AgendaOrder) => {
    setOrder(next);
    writeOrder(next);
  };

  // Open at the Today line, once.
  useEffect(() => {
    if (opened.current || !todayRef.current) return;
    opened.current = true;
    todayRef.current.scrollIntoView({ block: 'center' });
  }, [blocks]);

  // A selected event (from the "to confirm" chip, or another view later) is scrolled to.
  useEffect(() => {
    if (selectedEventId) document.getElementById(rowId(selectedEventId))?.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
  }, [selectedEventId]);

  if (!blocks.length) return <p className="py-10 text-center text-sm text-text-muted">No dated events match these filters.</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
        <span className="font-mono tabular-nums">
          {count} event{count === 1 ? '' : 's'}
        </span>
        <Segmented
          label="Order"
          value={order}
          onChange={choose}
          compact
          options={[
            { value: 'newest', label: 'Newest first' },
            { value: 'oldest', label: 'Oldest first' },
          ]}
        />
      </div>
      <Ledger>
        {groups.map((g, gi) => (
          <React.Fragment key={g.year ?? `group-${gi}`}>
            {g.year !== null && <Ledger.Separator label={String(g.year)} count={g.eventCount} />}
            {g.items.map((block, bi) => {
              if (block.kind === 'gap') {
                return (
                  <p key={`gap-${bi}`} className="border-b border-l-[3px] border-b-line border-l-transparent px-3.5 py-2 font-mono text-xs text-text-muted">
                    No events, {gapLabel(block)}
                  </p>
                );
              }
              if (block.kind !== 'month') return null;
              return block.rows.map((row) => (
                <Row
                  key={row.kind === 'today' ? 'today' : row.kind === 'span' ? row.span.id : row.partial.id}
                  row={row}
                  selected={row.kind !== 'today' && (row.kind === 'span' ? row.span.id : row.partial.id) === selectedEventId}
                  onOpen={onOpen}
                  todayRef={todayRef}
                />
              ));
            })}
          </React.Fragment>
        ))}
      </Ledger>
      <BackToTop />
    </div>
  );
};
