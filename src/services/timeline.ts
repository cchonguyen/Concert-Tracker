import type { EventKind, LoggedEvent } from '../server/events/types';
import { eventScale, LineupFacts } from '../server/events/scale';
import { attendanceOf } from '../server/events/attendance';
import { eventTitle } from './series';

// The Timeline tab's data: every view (Agenda, Month, Heatmap, River) reads
// this model and none of them works dates out on its own. Read-only; nothing
// here is stored. Nothing is placed on a day it was not given: an event with
// only a year or a month is listed apart, and one with no date at all goes in
// the No date yet tray. "Didn't go" events are left out entirely.
//
// Dates stay YYYY-MM-DD strings. Day maths goes through Date.UTC only, so a
// show never moves to the day before in a US time zone or across a clock change.

export type TimelineSize = 'small' | 'medium' | 'large';

export type TimelineRange =
  | { kind: 'all' }
  | { kind: 'year'; year: number }
  | { kind: 'month'; year: number; month: number }; // month 1-12

export type TimelineAttendance = 'went' | 'upcoming' | 'confirm';

// What a day square shows when it holds more than one event, strongest first.
export type DayState = 'confirm' | 'festival' | 'show' | 'upcoming';
export const DAY_STATE_ORDER: DayState[] = ['confirm', 'festival', 'show', 'upcoming'];

export interface TimelineSpan {
  id: string;
  title: string;
  first: string; // YYYY-MM-DD
  last: string; // YYYY-MM-DD, same as first for a one-day event
  days: string[]; // the days you went (or will go): ticked days, else every day of the span
  attendance: TimelineAttendance;
  kind?: EventKind; // undefined when not known yet
  weekend?: number;
  acts: number; // seen acts logged; 0 means none logged, not a small show
  event: LoggedEvent;
}

export interface TimelineDay {
  date: string;
  events: TimelineSpan[];
  state: DayState;
}

// An event with a year, or a year and month, but no day.
export interface TimelinePartial {
  id: string;
  title: string;
  year: number;
  month?: number;
  attendance: TimelineAttendance;
  kind?: EventKind;
  event: LoggedEvent;
}

export interface TimelineModel {
  today: string;
  spans: TimelineSpan[]; // by first day, then title
  days: Record<string, TimelineDay>;
  partial: TimelinePartial[]; // by year, then month (unknown month first), then title
  undated: LoggedEvent[];
  toConfirm: number; // over and waiting for you to say whether you went
  first?: string; // earliest day covered by a span
  last?: string; // latest day covered by a span
}

const pad = (n: number) => String(n).padStart(2, '0');
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const isoDate = (year: number, month: number, day: number) => {
  const d = new Date(Date.UTC(year, month - 1, day));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return isoDate(y, m, d + n);
}

// Every day from first to last, both included.
export function daysBetween(first: string, last: string): string[] {
  const out: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

// 0 = Sunday ... 6 = Saturday.
export function weekday(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Where an event's span starts and ends, from what you gave. The start date,
// else the earliest ticked day; the end date, else the latest ticked day,
// else the first day.
export function spanBounds(e: Pick<LoggedEvent, 'startDate' | 'endDate' | 'daysAttended'>): { first: string; last: string } | null {
  const ticked = (e.daysAttended ?? []).filter((d) => ISO.test(d)).sort();
  const first = e.startDate ?? ticked[0];
  if (!first) return null;
  const end = e.endDate ?? ticked[ticked.length - 1] ?? first;
  return { first, last: end > first ? end : first };
}

function dayState(span: TimelineSpan): DayState {
  if (span.attendance === 'confirm') return 'confirm';
  if (span.attendance === 'upcoming') return 'upcoming';
  return span.kind === 'festival' ? 'festival' : 'show';
}

const byTitle = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title);

export function buildTimelineModel(
  events: LoggedEvent[],
  today: string, // YYYY-MM-DD; passed in so the model never reads the clock
  facts: Record<string, LineupFacts> = {},
): TimelineModel {
  const spans: TimelineSpan[] = [];
  const partial: TimelinePartial[] = [];
  const undated: LoggedEvent[] = [];
  let toConfirm = 0;

  for (const e of events) {
    const state = attendanceOf(e, today);
    if (state === 'missed') continue;
    if (state === 'confirm') toConfirm++;
    const kind = eventScale(e, facts[e.id]).kind;
    const title = eventTitle(e);
    const bounds = spanBounds(e);
    if (bounds) {
      const all = daysBetween(bounds.first, bounds.last);
      const ticked = e.daysAttended.filter((d) => d >= bounds.first && d <= bounds.last);
      spans.push({
        id: e.id,
        title,
        ...bounds,
        days: ticked.length ? all.filter((d) => ticked.includes(d)) : all,
        attendance: state,
        kind,
        weekend: e.weekend,
        acts: e.seen.length,
        event: e,
      });
    } else if (e.year) {
      partial.push({ id: e.id, title, year: e.year, month: e.month, attendance: state, kind, event: e });
    } else {
      undated.push(e);
    }
  }

  spans.sort((a, b) => a.first.localeCompare(b.first) || byTitle(a, b));
  partial.sort((a, b) => a.year - b.year || (a.month ?? 0) - (b.month ?? 0) || byTitle(a, b));

  const days: Record<string, TimelineDay> = {};
  for (const span of spans) {
    const state = dayState(span);
    for (const date of span.days) {
      const day = (days[date] ??= { date, events: [], state });
      if (day.events.length && DAY_STATE_ORDER.indexOf(state) < DAY_STATE_ORDER.indexOf(day.state)) day.state = state;
      day.events.push(span);
    }
  }

  return {
    today,
    spans,
    days,
    partial,
    undated,
    toConfirm,
    first: spans[0]?.first,
    last: spans.reduce<string | undefined>((max, s) => (!max || s.last > max ? s.last : max), undefined),
  };
}

// Whether a span touches any day of the range.
export function spanInRange(span: Pick<TimelineSpan, 'first' | 'last'>, range: TimelineRange): boolean {
  if (range.kind === 'all') return true;
  const from = range.kind === 'year' ? `${range.year}-01-01` : isoDate(range.year, range.month, 1);
  const to = range.kind === 'year' ? `${range.year}-12-31` : isoDate(range.year, range.month + 1, 0);
  return span.first <= to && span.last >= from;
}

// River dot size: capped steps by acts you logged. None logged draws like one act.
export function actsStep(acts: number): 1 | 2 | 3 | 4 {
  if (acts >= 10) return 4;
  if (acts >= 5) return 3;
  if (acts >= 2) return 2;
  return 1;
}

// The views the Timeline tab switches between. Only the ones marked ready
// can be picked yet; the rest are built one at a time.
// The four timeline views. Each is an Explore page (see nav.ts).
export type TimelineMode = 'agenda' | 'month' | 'heatmap' | 'river';

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Agenda: oldest first, grouped by month under each year, with a Today line.
// An event spanning two months sits in the month it starts. Events with only
// a year come first in that year ("Month unknown"); events with only a month
// come first in that month ("Day unknown"). A run of empty months between two
// months with events collapses into one gap line.
export type AgendaRow =
  | { kind: 'span'; span: TimelineSpan }
  | { kind: 'partial'; partial: TimelinePartial }
  | { kind: 'today' };

export type AgendaBlock =
  | { kind: 'year'; year: number }
  | { kind: 'month'; year: number; month?: number; rows: AgendaRow[] } // no month: the year's "Month unknown" group
  | { kind: 'gap'; from: { year: number; month: number }; to: { year: number; month: number } };

const monthIndex = (year: number, month: number) => year * 12 + (month - 1);
const fromIndex = (i: number) => ({ year: Math.floor(i / 12), month: (i % 12) + 1 });

export function agendaBlocks(model: TimelineModel, range: TimelineRange = { kind: 'all' }, showToday = true): AgendaBlock[] {
  // Sort keys: a year-only event is "YYYY-00-00", a month-only one "YYYY-MM-00",
  // and the Today line comes right after events on today.
  const entries: Array<{ key: string; row: AgendaRow }> = [];
  for (const span of model.spans) if (spanInRange(span, range)) entries.push({ key: span.first, row: { kind: 'span', span } });
  for (const partial of model.partial) {
    if (range.kind !== 'all' && range.year !== partial.year) continue;
    if (range.kind === 'month' && range.month !== partial.month) continue;
    entries.push({ key: `${partial.year}-${partial.month ? pad(partial.month) : '00'}-00`, row: { kind: 'partial', partial } });
  }
  const todayInRange = spanInRange({ first: model.today, last: model.today }, range);
  if (showToday && todayInRange && entries.length) entries.push({ key: `${model.today}~`, row: { kind: 'today' } });
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const blocks: AgendaBlock[] = [];
  let year: number | undefined;
  let current: Extract<AgendaBlock, { kind: 'month' }> | undefined;
  let lastMonth: number | undefined; // monthIndex of the last dated month block
  for (const { key, row } of entries) {
    const y = Number(key.slice(0, 4));
    const m = Number(key.slice(5, 7)) || undefined;
    if (current && current.year === y && current.month === m) {
      current.rows.push(row);
      continue;
    }
    if (m && lastMonth !== undefined && monthIndex(y, m) - lastMonth > 1) {
      blocks.push({ kind: 'gap', from: fromIndex(lastMonth + 1), to: fromIndex(monthIndex(y, m) - 1) });
    }
    if (y !== year) {
      blocks.push({ kind: 'year', year: y });
      year = y;
    }
    current = { kind: 'month', year: y, month: m, rows: [row] };
    blocks.push(current);
    if (m) lastMonth = monthIndex(y, m);
  }
  return blocks;
}

// "Mar 2018" or "Mar 2018 – Aug 2021" for a gap line.
export function gapLabel(gap: Extract<AgendaBlock, { kind: 'gap' }>): string {
  const name = (p: { year: number; month: number }) => `${MONTH_NAMES[p.month - 1].slice(0, 3)} ${p.year}`;
  const same = gap.from.year === gap.to.year && gap.from.month === gap.to.month;
  return same ? name(gap.from) : `${name(gap.from)} – ${name(gap.to)}`;
}

// The date chip on an agenda row: "Sat 14", or "Fri 14 – Sun 16" for a run
// of days, with the end month added when the run crosses into the next one.
export function dateChip(span: Pick<TimelineSpan, 'first' | 'last'>): string {
  const label = (iso: string) => `${WEEKDAY_SHORT[weekday(iso)]} ${Number(iso.slice(8))}`;
  if (span.last === span.first) return label(span.first);
  const end = span.last.slice(0, 7) === span.first.slice(0, 7) ? label(span.last) : `${label(span.last)} ${MONTH_NAMES[Number(span.last.slice(5, 7)) - 1].slice(0, 3)}`;
  return `${label(span.first)} – ${end}`;
}

// The first event still waiting for you to say whether you went, for the
// "N to confirm" chip to jump to.
export const firstToConfirm = (model: TimelineModel): string | undefined =>
  model.spans.find((s) => s.attendance === 'confirm')?.id ?? model.partial.find((p) => p.attendance === 'confirm')?.id;

// What every timeline view takes, so views can be swapped or set side by side
// later. A day and an event are selected apart (a festival covers several
// days; a day can hold two shows). Hover stays inside each view.
export interface TimelineViewProps {
  model: TimelineModel;
  size: TimelineSize;
  range: TimelineRange;
  onRangeChange?: (next: TimelineRange) => void;
  selectedDate?: string | null;
  selectedEventId?: string | null;
  onSelectDate?: (date: string | null) => void;
  onSelectEvent?: (eventId: string | null) => void;
  onOpen: (eventId: string) => void;
}

// Heatmap: one row per year, a column per week (Sunday first), a square per
// day. A year needs 53 columns, or 54 when a leap year starts on a Saturday,
// so a New Year's Eve show is never cut off.
export interface HeatmapCell {
  date: string;
  week: number; // column, from 0
  dow: number; // row, 0 = Sunday
}
export interface HeatmapYear {
  year: number;
  weeks: number;
  cells: HeatmapCell[];
  months: Array<{ month: number; week: number }>; // the column each month starts in
}

export function heatmapYear(year: number): HeatmapYear {
  const offset = weekday(`${year}-01-01`);
  const cells: HeatmapCell[] = [];
  const months: HeatmapYear['months'] = [];
  let i = 0;
  for (let date = `${year}-01-01`; date.startsWith(String(year)); date = addDays(date, 1), i++) {
    const week = Math.floor((i + offset) / 7);
    if (date.endsWith('-01')) months.push({ month: Number(date.slice(5, 7)), week });
    cells.push({ date, week, dow: (i + offset) % 7 });
  }
  return { year, weeks: cells[cells.length - 1].week + 1, cells, months };
}

export type HeatmapRow =
  | {
      kind: 'year';
      year: number;
      events: number; // dated events starting this year
      undayed: TimelinePartial[]; // events with only this year or a month in it
    }
  | { kind: 'gap'; from: number; to: number }; // a run of years with nothing in them

// The years the heatmap shows, newest first: from the latest event (or this
// year) back to the earliest. A run of years with nothing in them collapses
// into one gap line; this year is always shown.
export function heatmapRows(model: TimelineModel, range: TimelineRange = { kind: 'all' }): HeatmapRow[] {
  const years = [
    ...model.spans.flatMap((s) => [Number(s.first.slice(0, 4)), Number(s.last.slice(0, 4))]),
    ...model.partial.map((p) => p.year),
  ];
  if (!years.length) return [];
  const thisYear = Number(model.today.slice(0, 4));
  const from = range.kind === 'all' ? Math.min(...years) : range.year;
  const to = range.kind === 'all' ? Math.max(...years, thisYear) : range.year;
  const rows: HeatmapRow[] = [];
  for (let year = to; year >= from; year--) {
    const lit = model.spans.some((s) => s.first.slice(0, 4) <= String(year) && s.last.slice(0, 4) >= String(year));
    const undayed = model.partial.filter((p) => p.year === year);
    if (!lit && !undayed.length && year !== thisYear) {
      const last = rows[rows.length - 1];
      if (last?.kind === 'gap') last.from = year;
      else rows.push({ kind: 'gap', from: year, to: year });
      continue;
    }
    rows.push({ kind: 'year', year, events: model.spans.filter((s) => s.first.startsWith(String(year))).length, undayed });
  }
  return rows;
}

// Month: a Sunday-first calendar page. Every event touching the page is a
// segment within a week row: a one-day event fills its day, a run of days is
// a bar across them (cut at the week's edge and carried on the next row),
// with the days you went marked so skipped festival days can show faint.
// Segments that overlap go on separate lanes.
export interface MonthSegment {
  span: TimelineSpan;
  start: number; // column, 0 = Sunday
  len: number; // days covered in this week
  lane: number;
  days: Array<{ date: string; went: boolean }>;
  before: boolean; // the run started in an earlier week
  after: boolean; // the run carries on into the next week
}
export interface MonthWeek {
  days: Array<{ date: string; inMonth: boolean }>;
  segments: MonthSegment[];
  lanes: number;
}
export interface MonthPage {
  year: number;
  month: number;
  weeks: MonthWeek[];
  undayed: TimelinePartial[]; // events with this month but no day
}

export function monthPage(model: TimelineModel, year: number, month: number): MonthPage {
  const first = isoDate(year, month, 1);
  const last = isoDate(year, month + 1, 0);
  const prefix = first.slice(0, 7);
  const weeks: MonthWeek[] = [];
  for (let start = addDays(first, -weekday(first)); start <= last; start = addDays(start, 7)) {
    const end = addDays(start, 6);
    const days = daysBetween(start, end).map((date) => ({ date, inMonth: date.startsWith(prefix) }));
    const segments: MonthSegment[] = [];
    const laneEnds: number[] = []; // last column used on each lane
    for (const span of model.spans) {
      if (span.last < start || span.first > end) continue;
      const from = span.first > start ? span.first : start;
      const to = span.last < end ? span.last : end;
      const col = weekday(from);
      const len = weekday(to) - col + 1;
      let lane = laneEnds.findIndex((e) => e < col);
      if (lane < 0) lane = laneEnds.push(0) - 1;
      laneEnds[lane] = col + len - 1;
      segments.push({
        span,
        start: col,
        len,
        lane,
        days: daysBetween(from, to).map((date) => ({ date, went: span.days.includes(date) })),
        before: span.first < start,
        after: span.last > end,
      });
    }
    weeks.push({ days, segments, lanes: laneEnds.length });
  }
  return { year, month, weeks, undayed: model.partial.filter((p) => p.year === year && p.month === month) };
}

// The month before or after.
export function shiftMonth(year: number, month: number, by: number): { year: number; month: number } {
  const i = year * 12 + (month - 1) + by;
  return { year: Math.floor(i / 12), month: (i % 12) + 1 };
}

// ?month=YYYY-MM in the address for the Month view; this month when missing or malformed.
export function monthFromQuery(query: string, today: string): Extract<TimelineRange, { kind: 'month' }> {
  const m = /^(\d{4})-(\d{2})$/.exec(new URLSearchParams(query).get('month') ?? '');
  const month = m ? Number(m[2]) : 0;
  if (m && month >= 1 && month <= 12) return { kind: 'month', year: Number(m[1]), month };
  return { kind: 'month', year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
}
export const monthToQuery = (r: { year: number; month: number }) => `${r.year}-${pad(r.month)}`;

// River: a left-to-right time axis. Concerts are dots and runs of days are
// bars, sized in steps by acts you logged, stacked on lanes so nothing
// overlaps. Zoom is a number of pixels per day; names are drawn beside the
// marks once there is room for them.
export const RIVER_ZOOMS = [0.5, 1.5, 4, 12]; // about a decade to a month on screen
export const RIVER_LABELS_FROM = 4; // pixels per day at which names are drawn

const DAY_MS = 86_400_000;
export function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

export interface RiverItem {
  span: TimelineSpan;
  x: number; // left edge, px
  w: number; // 0 for a one-day dot
  r: number; // dot radius or half the bar height, from actsStep
  lane: number;
  label: boolean; // the name fits beside the mark
}
export interface RiverLayout {
  width: number;
  lanes: number;
  todayX: number;
  items: RiverItem[];
  ticks: Array<{ x: number; label: string; major: boolean }>;
}

export function riverLayout(model: TimelineModel, pxPerDay: number): RiverLayout | null {
  if (!model.spans.length) return null;
  const firstYear = Number(model.spans[0].first.slice(0, 4));
  const lastYear = Math.max(Number((model.last ?? model.today).slice(0, 4)), Number(model.today.slice(0, 4)));
  const origin = dayNumber(`${firstYear}-01-01`);
  const xOf = (iso: string) => (dayNumber(iso) - origin) * pxPerDay;
  const width = xOf(`${lastYear + 1}-01-01`);
  const labels = pxPerDay >= RIVER_LABELS_FROM;
  const laneEnds: number[] = [];
  const items: RiverItem[] = model.spans.map((span) => {
    const x = xOf(span.first);
    const w = span.last === span.first ? 0 : xOf(addDays(span.last, 1)) - x;
    const r = 2 + 2 * actsStep(span.acts);
    const right = x + Math.max(w, r * 2) + (labels ? 8 + span.title.length * 6.5 : 4);
    let lane = laneEnds.findIndex((end) => end < x - r);
    if (lane < 0) lane = laneEnds.push(0) - 1;
    laneEnds[lane] = right;
    return { span, x, w, r, lane, label: labels };
  });
  const ticks: RiverLayout['ticks'] = [];
  for (let y = firstYear; y <= lastYear; y++) {
    ticks.push({ x: xOf(`${y}-01-01`), label: String(y), major: true });
    if (pxPerDay >= RIVER_LABELS_FROM) {
      for (let m = 2; m <= 12; m++) ticks.push({ x: xOf(isoDate(y, m, 1)), label: `${MONTH_NAMES[m - 1].slice(0, 3)} ${y}`, major: false });
    }
  }
  return { width, lanes: laneEnds.length, todayX: xOf(model.today), items, ticks };
}
