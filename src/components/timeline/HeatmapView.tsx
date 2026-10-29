import React, { useEffect, useMemo, useRef } from 'react';
import { X } from 'lucide-react';
import { placeLabel } from '../../services/format';
import { DayState, heatmapRows, heatmapYear, MONTH_NAMES, TimelineViewProps, WEEKDAY_SHORT, weekday } from '../../services/timeline';
import { EventTitle } from '../EventTitle';
import { BackToTop } from '../ui/BackToTop';
import { ATTENDANCE_STYLE, ConfirmMark, Rating } from './parts';

// Heatmap: one row per year, newest first, a square per day. Days you went
// are lit (festival days brightest), upcoming days are outlined, days waiting
// for your answer are outlined in amber. Each year is drawn as one SVG, and
// hover uses the browser's own tooltip, so moving the mouse never re-draws
// the page. Tapping a lit day lists its events under that year. Only the
// large size is built so far.

const CELL = 11;
const STEP = 13;
const TOP = 14; // room for month labels

// Fill and outline for each day state, as Tailwind classes so they follow the theme.
const STATE_CLASS: Record<DayState | 'empty', string> = {
  festival: 'fill-violet-400',
  show: 'fill-violet-600',
  upcoming: 'fill-transparent stroke-violet-400',
  confirm: 'fill-transparent stroke-amber-400',
  empty: 'fill-zinc-800/60',
};

const STATE_LABEL: Record<DayState, string> = {
  festival: 'Festival',
  show: 'Show',
  upcoming: 'Upcoming',
  confirm: 'Did you go?',
};

const longDate = (iso: string) => `${WEEKDAY_SHORT[weekday(iso)]} ${Number(iso.slice(8))} ${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

const YearGrid: React.FC<{
  year: number;
  model: TimelineViewProps['model'];
  selectedDate?: string | null;
  onSelectDate?: (date: string | null) => void;
}> = ({ year, model, selectedDate, onSelectDate }) => {
  const grid = useMemo(() => heatmapYear(year), [year]);
  const width = grid.weeks * STEP;
  const height = TOP + 7 * STEP;
  // One click handler for the whole year, reading the day from the square.
  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const date = (e.target as Element).getAttribute('data-date');
    if (!date) return;
    onSelectDate?.(model.days[date] && date !== selectedDate ? date : null);
  };
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="block w-full min-w-[540px]" role="img" aria-label={`Days with events in ${year}`} onClick={onClick}>
      {grid.months.map((m) => (
        <text key={m.month} x={m.week * STEP} y={10} className="fill-zinc-500 text-[9px]">
          {MONTH_NAMES[m.month - 1].slice(0, 3)}
        </text>
      ))}
      {grid.cells.map((c) => {
        const day = model.days[c.date];
        const state = day?.state ?? 'empty';
        const outlined = state === 'upcoming' || state === 'confirm';
        const ring = c.date === selectedDate ? 'stroke-zinc-100' : c.date === model.today ? 'stroke-zinc-400' : '';
        return (
          <rect
            key={c.date}
            data-date={c.date}
            x={c.week * STEP}
            y={TOP + c.dow * STEP}
            width={CELL}
            height={CELL}
            rx={2}
            strokeWidth={ring || outlined ? 1.5 : 0}
            strokeDasharray={outlined && !ring ? '2 1.5' : undefined}
            className={`${STATE_CLASS[state]} ${ring} ${day ? 'cursor-pointer' : ''}`}
          >
            <title>
              {longDate(c.date)}
              {day ? `: ${day.events.map((s) => s.title).join(', ')}` : c.date === model.today ? ': today' : ''}
            </title>
          </rect>
        );
      })}
    </svg>
  );
};

const DayPanel: React.FC<{
  date: string;
  model: TimelineViewProps['model'];
  onOpen: (id: string) => void;
  onClose: () => void;
}> = ({ date, model, onOpen, onClose }) => {
  const day = model.days[date];
  if (!day) return null;
  return (
    <div className="mt-2 space-y-1.5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-2">
      <div className="flex items-center justify-between px-1 text-xs font-semibold text-zinc-400">
        {longDate(date)}
        <button onClick={onClose} aria-label="Close" className="text-zinc-500 hover:text-zinc-200">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <ul className="space-y-1.5">
        {day.events.map((s) => (
          <li key={s.id}>
            <button
              onClick={() => onOpen(s.id)}
              className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left hover:border-zinc-600 ${ATTENDANCE_STYLE[s.attendance]}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-zinc-100">
                  <EventTitle event={s.event} />
                </span>
                {placeLabel(s.event) && <span className="block truncate text-xs text-zinc-500">{placeLabel(s.event)}</span>}
              </span>
              {s.attendance === 'confirm' ? <ConfirmMark /> : s.attendance === 'went' ? <Rating rating={s.event.rating} /> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

// On a narrow screen a year scrolls sideways; this year's row starts scrolled
// so today is in view rather than January.
const Scroller: React.FC<{ today?: string; children: React.ReactNode }> = ({ today, children }) => {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || !today || el.scrollWidth <= el.clientWidth) return;
    const cell = heatmapYear(Number(today.slice(0, 4))).cells.find((c) => c.date === today);
    if (!cell) return;
    const x = ((cell.week * STEP) / (heatmapYear(Number(today.slice(0, 4))).weeks * STEP)) * el.scrollWidth;
    el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
  }, [today]);
  return (
    <div ref={box} className="overflow-x-auto">
      {children}
    </div>
  );
};

export const HeatmapView: React.FC<TimelineViewProps> = ({ model, range, selectedDate, onSelectDate, onOpen }) => {
  const rows = useMemo(() => heatmapRows(model, range), [model, range]);
  if (!rows.length) return <p className="py-10 text-center text-sm text-zinc-500">No dated events match these filters.</p>;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-zinc-500">
        {(['festival', 'show', 'upcoming', 'confirm'] as DayState[]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1">
            <svg width={CELL} height={CELL} aria-hidden>
              <rect
                x={0.75}
                y={0.75}
                width={CELL - 1.5}
                height={CELL - 1.5}
                rx={2}
                strokeWidth={s === 'upcoming' || s === 'confirm' ? 1.5 : 0}
                strokeDasharray={s === 'upcoming' || s === 'confirm' ? '2 1.5' : undefined}
                className={STATE_CLASS[s]}
              />
            </svg>
            {STATE_LABEL[s]}
          </span>
        ))}
      </div>
      {rows.map((row) =>
        row.kind === 'gap' ? (
          <p key={`gap-${row.to}`} className="border-l-2 border-zinc-800 py-1 pl-3 text-xs text-zinc-600">
            No events, {row.from === row.to ? row.from : `${row.from} – ${row.to}`}
          </p>
        ) : (
          <section key={row.year}>
            <div className="mb-1 flex items-baseline gap-2">
              <h2 className="text-lg font-extrabold tracking-tight text-zinc-200">{row.year}</h2>
              <span className="text-xs text-zinc-500">
                {row.events} event{row.events === 1 ? '' : 's'}
              </span>
              {row.undayed.length > 0 && (
                <span className="text-xs text-zinc-500" title={row.undayed.map((p) => p.title).join(', ')}>
                  +{row.undayed.length} without a day
                </span>
              )}
            </div>
            <Scroller today={row.year === Number(model.today.slice(0, 4)) ? model.today : undefined}>
              <YearGrid year={row.year} model={model} selectedDate={selectedDate} onSelectDate={onSelectDate} />
            </Scroller>
            {selectedDate?.startsWith(String(row.year)) && <DayPanel date={selectedDate} model={model} onOpen={onOpen} onClose={() => onSelectDate?.(null)} />}
          </section>
        ),
      )}
      <BackToTop />
    </div>
  );
};
