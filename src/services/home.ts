import type { LineupSummary, LoggedEvent } from '../server/events/types';
import { eventYear } from './format';
import { needsOf } from './table';

// The Events home: a summary you can take in at a glance. The full list lives
// in the Table view. Read-only, worked out from the event list each time.

export interface HomeSummary {
  events: number;
  artists: number; // distinct acts seen
  venues: number;
  thisYear: number;
  needs: { date: number; pick: number; review: number };
  upcoming: LoggedEvent[]; // dated after today, soonest first
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
  const dated = events.filter((e) => e.startDate);
  return {
    events: events.length,
    artists: new Set(events.flatMap((e) => e.seen.map((s) => s.key))).size,
    venues: new Set(events.flatMap((e) => (e.venue ? [fold(e.venue)] : []))).size,
    thisYear: events.filter((e) => eventYear(e) === year && !(e.startDate && e.startDate > today)).length,
    needs,
    upcoming: dated.filter((e) => e.startDate! > today).sort((a, b) => a.startDate!.localeCompare(b.startDate!)),
    recent: dated
      .filter((e) => e.startDate! <= today)
      .sort((a, b) => b.startDate!.localeCompare(a.startDate!))
      .slice(0, recentCount),
    onThisDay: dated
      .filter((e) => e.startDate!.slice(5) === monthDay && e.startDate!.slice(0, 4) < today.slice(0, 4))
      .sort((a, b) => b.startDate!.localeCompare(a.startDate!)),
  };
}
