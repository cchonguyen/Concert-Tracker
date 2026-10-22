import type { LoggedEvent } from './types';

// Whether you went. An event added before it happens is "planned" until you
// say you went (the value is cleared) or didn't ("missed"). No value means
// you went: every event logged after the fact. Only your answer is stored;
// whether a planned event is still ahead or waiting on you is worked out
// from its dates each time. Stats, Artists and the Map count only events you
// went to.

export type Attendance = 'planned' | 'missed';
export const isAttendance = (v: unknown): v is Attendance => v === 'planned' || v === 'missed';

// went: counted; upcoming: planned, still ahead; confirm: planned and over
// (or with no date to tell), so the app asks whether you went; missed: you
// said you didn't go.
export type AttendanceState = 'went' | 'upcoming' | 'confirm' | 'missed';

type When = Pick<LoggedEvent, 'startDate' | 'endDate' | 'year' | 'month'> & { attendance?: Attendance };

const pad = (n: number) => String(n).padStart(2, '0');

// The earliest and latest day the event can be on, from what you gave.
function firstDay(e: When): string | undefined {
  if (e.startDate) return e.startDate;
  if (e.year && e.month) return `${e.year}-${pad(e.month)}-01`;
  if (e.year) return `${e.year}-01-01`;
  return undefined;
}

export function lastDay(e: When): string | undefined {
  if (e.endDate ?? e.startDate) return e.endDate ?? e.startDate;
  if (e.year && e.month) return `${e.year}-${pad(e.month)}-${pad(new Date(Date.UTC(e.year, e.month, 0)).getUTCDate())}`;
  if (e.year) return `${e.year}-12-31`;
  return undefined;
}

// Every day it can be on is after today (YYYY-MM-DD): you can't have been yet.
export function isAhead(e: When, today: string): boolean {
  const d = firstDay(e);
  return Boolean(d && d > today);
}

export function attendanceOf(e: When, today: string): AttendanceState {
  if (e.attendance === 'missed') return 'missed';
  if (e.attendance === 'planned') {
    const d = lastDay(e);
    return d && d > today ? 'upcoming' : 'confirm';
  }
  // Logged after the fact, unless its dates are still ahead.
  return isAhead(e, today) ? 'upcoming' : 'went';
}

// The events Stats, Artists, the Map and the summary tiles count.
export function wentTo<T extends When>(events: T[], today: string): T[] {
  return events.filter((e) => attendanceOf(e, today) === 'went');
}

export const ATTENDANCE_LABELS: Record<AttendanceState, string> = {
  went: 'Went',
  upcoming: 'Upcoming',
  confirm: 'Did you go?',
  missed: "Didn't go",
};
