import type { LoggedEvent } from '../server/events/types';
import { eventYear } from './format';

// The "Do first" insights from the Manage design (step 6), worked out from
// the events you went to each time; nothing is stored. Gaps use only events
// dated to the day and say how many that is, so an undated event never moves
// a figure by a guess.

const DAY = 86_400_000;
const isDay = (s?: string): s is string => Boolean(s && /^\d{4}-\d{2}-\d{2}$/.test(s));
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

export interface ArtistGaps {
  dated: number; // events dated to the day
  total: number;
  lastDate?: string;
  sinceLast?: number; // days from the last dated event to today
  longest?: { days: number; from: string; to: string }; // longest wait between two dated sightings
}

// How long since you last saw an artist, and the longest you waited between
// two shows. `events` are the events you went to where you saw them.
export function artistGaps(events: LoggedEvent[], today: string): ArtistGaps {
  const dates = [...new Set(events.map((e) => e.startDate).filter(isDay))].sort();
  const out: ArtistGaps = { dated: events.filter((e) => isDay(e.startDate)).length, total: events.length };
  if (!dates.length) return out;
  out.lastDate = dates[dates.length - 1];
  if (isDay(today) && today >= out.lastDate) out.sinceLast = days(out.lastDate, today);
  for (let i = 1; i < dates.length; i++) {
    const d = days(dates[i - 1], dates[i]);
    if (!out.longest || d > out.longest.days) out.longest = { days: d, from: dates[i - 1], to: dates[i] };
  }
  return out;
}

// "3 years", "5 months", "12 days".
export function spanLabel(n: number): string {
  if (n >= 365) {
    const y = Math.floor(n / 365.25);
    return `${y} year${y === 1 ? '' : 's'}`;
  }
  if (n >= 60) {
    const m = Math.floor(n / 30.44);
    return `${m} month${m === 1 ? '' : 's'}`;
  }
  return `${n} day${n === 1 ? '' : 's'}`;
}

const order = (e: LoggedEvent) => e.startDate ?? (e.year ? `${e.year}${e.month ? `-${String(e.month).padStart(2, '0')}` : ''}` : '');

export interface PersonInsights {
  together: number;
  first?: LoggedEvent; // the earliest dated show together
  onlyWith: Array<{ key: string; name: string; times: number }>; // acts you saw only with them
}

// Shows you went to with someone (by their record ID on your events), the
// first one, and the acts you have only ever seen with them.
export function personInsights(went: LoggedEvent[], personId: string): PersonInsights {
  const withThem = went.filter((e) => e.refs?.companionIds.includes(personId));
  const dated = withThem.filter((e) => order(e)).sort((a, b) => order(a).localeCompare(order(b)));
  const seen = new Map<string, { name: string; all: number; with: number }>();
  for (const e of went) {
    const mine = e.refs?.companionIds.includes(personId) ?? false;
    for (const key of new Set(e.seen.map((s) => s.key))) {
      const s = seen.get(key) ?? { name: e.seen.find((x) => x.key === key)!.name, all: 0, with: 0 };
      s.all += 1;
      if (mine) s.with += 1;
      seen.set(key, s);
    }
  }
  const onlyWith = [...seen.entries()]
    .filter(([, s]) => s.with > 0 && s.with === s.all)
    .map(([key, s]) => ({ key, name: s.name, times: s.with }))
    .sort((a, b) => b.times - a.times || a.name.localeCompare(b.name));
  return { together: withThem.length, first: dated[0], onlyWith };
}

export interface SeriesStreak {
  years: number[]; // the years you went, oldest first
  longest?: { from: number; to: number; length: number };
  latest?: { from: number; to: number; length: number }; // the run ending at your latest year
}

// The editions of a series you went to (by the series record ID on your
// events) and your runs of consecutive years.
export function seriesStreak(went: LoggedEvent[], seriesId: string): SeriesStreak {
  const years = [...new Set(went.filter((e) => e.refs?.seriesId === seriesId).map(eventYear).filter((y): y is number => y !== null))].sort((a, b) => a - b);
  if (!years.length) return { years };
  const runs: Array<{ from: number; to: number; length: number }> = [];
  for (const y of years) {
    const run = runs[runs.length - 1];
    if (run && y === run.to + 1) {
      run.to = y;
      run.length += 1;
    } else runs.push({ from: y, to: y, length: 1 });
  }
  const longest = runs.reduce((a, b) => (b.length > a.length ? b : a));
  return { years, longest, latest: runs[runs.length - 1] };
}
