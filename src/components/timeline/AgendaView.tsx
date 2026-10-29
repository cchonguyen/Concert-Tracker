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
import { ATTENDANCE_STYLE, ConfirmMark, DayDots, Rating } from './parts';

// Agenda: one line per event under year and month headers, newest first unless
// you picked oldest first (remembered on this device), opening at the Today
// line. Only the large size is built so far.

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

const Row: React.FC<{ row: AgendaRow; selected: boolean; onOpen: (id: string) => void; todayRef: React.Ref<HTMLLIElement> }> = ({
  row,
  selected,
  onOpen,
  todayRef,
}) => {
  if (row.kind === 'today') {
    return (
      <li ref={todayRef} className="flex items-center gap-2 py-1 text-[11px] font-bold uppercase tracking-wide text-violet-300">
        <span className="h-px flex-1 bg-violet-500/50" />
        Today
        <span className="h-px flex-1 bg-violet-500/50" />
      </li>
    );
  }
  const item = row.kind === 'span' ? row.span : row.partial;
  const event = item.event;
  const place = placeLabel(event);
  const multi = row.kind === 'span' && row.span.last !== row.span.first;
  return (
    <li id={rowId(item.id)}>
      <button
        onClick={() => onOpen(item.id)}
        className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors hover:border-zinc-600 ${ATTENDANCE_STYLE[item.attendance]} ${
          selected ? 'ring-2 ring-violet-500' : ''
        }`}
      >
        <span className="w-24 shrink-0 text-xs font-semibold text-zinc-400 sm:w-32">
          {row.kind === 'span' ? dateChip(row.span) : row.partial.month ? 'Day unknown' : 'Month unknown'}
          {multi && (
            <span className="mt-1 block">
              <DayDots all={daysBetween(row.span.first, row.span.last)} went={row.span.days} />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-zinc-100">
            <EventTitle event={event} />
          </span>
          {place && <span className="block truncate text-xs text-zinc-500">{place}</span>}
        </span>
        {item.attendance === 'confirm' ? <ConfirmMark /> : item.attendance === 'upcoming' ? null : <Rating rating={event.rating} />}
      </button>
    </li>
  );
};

const Block: React.FC<{
  block: AgendaBlock;
  selectedEventId?: string | null;
  onOpen: (id: string) => void;
  todayRef: React.Ref<HTMLLIElement>;
}> = ({ block, selectedEventId, onOpen, todayRef }) => {
  if (block.kind === 'year') return <h2 className="pt-4 text-2xl font-extrabold tracking-tight text-zinc-200 first:pt-0">{block.year}</h2>;
  if (block.kind === 'gap') return <p className="border-l-2 border-zinc-800 py-1 pl-3 text-xs text-zinc-600">No events, {gapLabel(block)}</p>;
  return (
    <section>
      {/* Sticky under the app header, so you always know which month you are in. */}
      <h3 className="sticky top-[57px] z-10 -mx-1 bg-zinc-950/95 px-1 py-1.5 text-xs font-bold uppercase tracking-wide text-zinc-500 backdrop-blur">
        {block.month ? `${MONTH_NAMES[block.month - 1]} ${block.year}` : `Sometime in ${block.year}`}
      </h3>
      <ul className="space-y-1.5">
        {block.rows.map((row) => (
          <Row
            key={row.kind === 'today' ? 'today' : row.kind === 'span' ? row.span.id : row.partial.id}
            row={row}
            selected={row.kind !== 'today' && (row.kind === 'span' ? row.span.id : row.partial.id) === selectedEventId}
            onOpen={onOpen}
            todayRef={todayRef}
          />
        ))}
      </ul>
    </section>
  );
};

export const AgendaView: React.FC<TimelineViewProps> = ({ model, range, selectedEventId, onOpen }) => {
  const [order, setOrder] = useState<AgendaOrder>(readOrder);
  const blocks = useMemo(() => agendaBlocks(model, range, true, order), [model, range, order]);
  const count = useMemo(() => agendaCount(blocks), [blocks]);
  const todayRef = useRef<HTMLLIElement>(null);
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
    if (selectedEventId) document.getElementById(rowId(selectedEventId))?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [selectedEventId]);

  if (!blocks.length) return <p className="py-10 text-center text-sm text-zinc-500">No dated events match these filters.</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
        <span>
          {count} event{count === 1 ? '' : 's'}
        </span>
        <div role="group" aria-label="Order" className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
          {(['newest', 'oldest'] as const).map((o) => (
            <button
              key={o}
              type="button"
              aria-pressed={order === o}
              onClick={() => choose(o)}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors ${order === o ? 'bg-violet-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              {o === 'newest' ? 'Newest first' : 'Oldest first'}
            </button>
          ))}
        </div>
      </div>
      {blocks.map((block, i) => (
        <Block key={i} block={block} selectedEventId={selectedEventId} onOpen={onOpen} todayRef={todayRef} />
      ))}
      <BackToTop />
    </div>
  );
};
