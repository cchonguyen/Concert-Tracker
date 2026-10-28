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
