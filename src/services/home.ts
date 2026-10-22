import type { LineupSummary, LoggedEvent } from '../server/events/types';
import { eventYear } from './format';
import { needsOf } from './table';
import { attendanceOf, wentTo } from '../server/events/attendance';

// The Events home: a summary you can take in at a glance. The full list lives
// in the Table view. Read-only, worked out from the event list each time.

// Tiles count only events you went to: upcoming ones, and ones over that
// you haven't confirmed, wait in their own lists.
export interface HomeSummary {
  events: number;
  artists: number; // distinct acts seen
  venues: number;
  thisYear: number;
  needs: { date: number; pick: number; review: number };
  upcoming: LoggedEvent[]; // still ahead, soonest first
  toConfirm: LoggedEvent[]; // over, waiting for you to say whether you went; most recent first
  recent: LoggedEvent[]; // dated today or earlier, newest first
  onThisDay: LoggedEvent[]; // same month and day in an earlier year
}

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function homeSummary(
  events: LoggedEvent[],
  lineups: Record<string, LineupSummary>,
  today: string, // YYYY-MM-DD
  recentCount = 5,
): HomeSummary {
  const needs = { date: 0, pick: 0, review: 0 };
  for (const e of events) {
    const n = needsOf(e, lineups[e.id]);
    if (n) needs[n] += 1;
  }
  const year = Number(today.slice(0, 4));
  const monthDay = today.slice(5);
  const went = wentTo(events, today);
  const dated = went.filter((e) => e.startDate);
  const when = (e: LoggedEvent) => e.startDate ?? (e.year ? `${e.year}-${String(e.month ?? 12).padStart(2, '0')}` : '');
  return {
    events: went.length,
    artists: new Set(went.flatMap((e) => e.seen.map((s) => s.key))).size,
    venues: new Set(went.flatMap((e) => (e.venue ? [fold(e.venue)] : []))).size,
    thisYear: went.filter((e) => eventYear(e) === year).length,
    needs,
    upcoming: events
      .filter((e) => attendanceOf(e, today) === 'upcoming')
      .sort((a, b) => when(a).localeCompare(when(b))),
    toConfirm: events
      .filter((e) => attendanceOf(e, today) === 'confirm')
      .sort((a, b) => when(b).localeCompare(when(a))),
    recent: dated
      .sort((a, b) => b.startDate!.localeCompare(a.startDate!))
      .slice(0, recentCount),
    onThisDay: dated
      .filter((e) => e.startDate!.slice(5) === monthDay && e.startDate!.slice(0, 4) < today.slice(0, 4))
      .sort((a, b) => b.startDate!.localeCompare(a.startDate!)),
  };
}
