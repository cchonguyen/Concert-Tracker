import type { LoggedEvent } from '../server/events/types';
import { eventYear } from './format';
import { cityWithRegion } from '../server/events/regions';
import { attendanceOf, wentTo } from '../server/events/attendance';
import { summarize, type Summary } from './table';

// The Stats view: counts and rankings worked out from your log each time.
// Only events you went to count (nothing still ahead, nothing you haven't
// confirmed going to), and figures
// built on optional fields say how many events they cover.

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const DAY = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

// Events you went to: not still ahead, not waiting for you to confirm, not missed.
export function pastEvents(events: LoggedEvent[], today: string): LoggedEvent[] {
  return wentTo(events, today);
}

export interface YearCount {
  year: number;
  events: number;
  newArtists: number; // acts seen for the first time that year
}

// One entry per year from your first to your last, so empty years show as gaps.
export function perYear(events: LoggedEvent[]): { years: YearCount[]; undated: number } {
  const byYear = new Map<number, LoggedEvent[]>();
  let undated = 0;
  for (const e of events) {
    const y = eventYear(e);
    if (y === null) undated += 1;
    else byYear.set(y, [...(byYear.get(y) ?? []), e]);
  }
  if (!byYear.size) return { years: [], undated };
  const first = firstSeen(events);
  const keys = [...byYear.keys()];
  const years: YearCount[] = [];
  for (let y = Math.min(...keys); y <= Math.max(...keys); y++) {
    years.push({
      year: y,
      events: byYear.get(y)?.length ?? 0,
      newArtists: [...first.values()].filter((f) => f.year === y).length,
    });
  }
  return { years, undated };
}

// The year you first saw each act (by key), from dated or year-only events.
function firstSeen(events: LoggedEvent[]): Map<string, { name: string; year: number }> {
  const out = new Map<string, { name: string; year: number }>();
  for (const e of events) {
    const y = eventYear(e);
    if (y === null) continue;
    for (const s of e.seen) {
      const cur = out.get(s.key);
      if (!cur || y < cur.year) out.set(s.key, { name: s.name, year: y });
    }
  }
  return out;
}

export type RankBy = 'artist' | 'venue' | 'city' | 'companion';

export interface Ranked {
  key: string; // what the Table filters by: an act's key, or the value as most often written
  label: string;
  count: number; // events
}

// Most frequent first; ties by name. Spellings that differ only by case or
// accents count together and show as their most common form.
export function top(events: LoggedEvent[], by: RankBy, n = 10): Ranked[] {
  const groups = new Map<string, { label: string; count: number; spellings: Map<string, number> }>();
  const add = (key: string, label: string) => {
    const g = groups.get(key) ?? { label, count: 0, spellings: new Map() };
    g.count += 1;
    g.spellings.set(label, (g.spellings.get(label) ?? 0) + 1);
    groups.set(key, g);
  };
  for (const e of events) {
    if (by === 'artist') for (const s of e.seen) add(s.key, s.name);
    if (by === 'venue' && e.venue) add(fold(e.venue), e.venue);
    const city = cityWithRegion(e.city, e.region);
    if (by === 'city' && city) add(fold(city), city);
    if (by === 'companion') for (const c of new Set(e.companions)) add(fold(c), c);
  }
  return [...groups.entries()]
    .map(([key, g]) => {
      const label = [...g.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
      return { key: by === 'artist' ? key : label, label: by === 'artist' ? g.label : label, count: g.count };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, n);
}

export interface YearReview {
  year: number;
  events: number;
  artists: number;
  newArtists: string[]; // names, first seen this year
  topArtist?: Ranked; // only when seen more than once
  topVenue?: Ranked;
  topCompanion?: Ranked;
  busiestMonth?: { month: number; events: number }; // 1-12, from dated events
  rated: number;
  averageRating?: number;
}

export function yearInReview(events: LoggedEvent[], year: number): YearReview {
  const inYear = events.filter((e) => eventYear(e) === year);
  const first = firstSeen(events);
  const months = new Map<number, number>();
  for (const e of inYear) if (e.startDate) months.set(Number(e.startDate.slice(5, 7)), (months.get(Number(e.startDate.slice(5, 7))) ?? 0) + 1);
  const busiest = [...months.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  const ratings = inYear.flatMap((e) => (typeof e.rating === 'number' ? [e.rating] : []));
  const repeat = (r?: Ranked) => (r && r.count > 1 ? r : undefined);
  return {
    year,
    events: inYear.length,
    artists: new Set(inYear.flatMap((e) => e.seen.map((s) => s.key))).size,
    newArtists: [...first.values()].filter((f) => f.year === year).map((f) => f.name).sort((a, b) => a.localeCompare(b)),
    topArtist: repeat(top(inYear, 'artist', 1)[0]),
    topVenue: repeat(top(inYear, 'venue', 1)[0]),
    topCompanion: top(inYear, 'companion', 1)[0],
    busiestMonth: busiest && busiest[1] > 1 ? { month: busiest[0], events: busiest[1] } : undefined,
    rated: ratings.length,
    averageRating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : undefined,
  };
}

export interface Facts {
  first?: LoggedEvent; // your earliest dated event
  longestGap?: { days: number; from: LoggedEvent; to: LoggedEvent };
  busiestStretch?: { events: number; from: string; to: string }; // most events within 30 days
  mostSeen?: Ranked;
  actsPerEvent?: { average: number; events: number }; // over events with acts marked
}

export function facts(events: LoggedEvent[]): Facts {
  const dated = events.filter((e) => e.startDate).sort((a, b) => a.startDate!.localeCompare(b.startDate!));
  const out: Facts = {};
  if (dated.length) out.first = dated[0];
  for (let i = 1; i < dated.length; i++) {
    // A multi-day event ends on its last day.
    const gap = days(dated[i - 1].endDate ?? dated[i - 1].startDate!, dated[i].startDate!);
    if (gap > 0 && (!out.longestGap || gap > out.longestGap.days)) out.longestGap = { days: gap, from: dated[i - 1], to: dated[i] };
  }
  let j = 0;
  for (let i = 0; i < dated.length; i++) {
    while (days(dated[j].startDate!, dated[i].startDate!) >= 30) j++;
    const n = i - j + 1;
    if (n > 1 && (!out.busiestStretch || n > out.busiestStretch.events))
      out.busiestStretch = { events: n, from: dated[j].startDate!, to: dated[i].startDate! };
  }
  const most = top(events, 'artist', 1)[0];
  if (most && most.count > 1) out.mostSeen = most;
  const withActs = events.filter((e) => e.seen.length > 0);
  if (withActs.length)
    out.actsPerEvent = {
      average: Math.round((withActs.reduce((a, e) => a + e.seen.length, 0) / withActs.length) * 10) / 10,
      events: withActs.length,
    };
  return out;
}

// Your series (LoggedEvent.series), for fun: how many editions you went to,
// your longest run of years in a row, the cities, and the acts you saw at
// more than one edition. Only your own series names count; nothing is grouped
// that you did not link.
export interface SeriesStat {
  name: string;
  editions: number;
  years: number[]; // years you went, oldest first
  streak?: { years: number; from: number; to: number }; // longest run of years in a row, when 2 or more
  cities: string[];
  acts: number; // distinct acts seen across its editions
  regulars: Array<{ label: string; count: number }>; // acts seen at 2 or more editions, most first
}

export function seriesStats(events: LoggedEvent[]): SeriesStat[] {
  const bySeries = new Map<string, LoggedEvent[]>();
  for (const e of events) if (e.series) bySeries.set(e.series, [...(bySeries.get(e.series) ?? []), e]);
  const out: SeriesStat[] = [];
  for (const [name, list] of bySeries) {
    const years = [...new Set(list.map(eventYear).filter((y): y is number => y !== null))].sort((a, b) => a - b);
    let streak: SeriesStat['streak'];
    for (let i = 0, start = 0; i < years.length; i++) {
      if (i > 0 && years[i] !== years[i - 1] + 1) start = i;
      const run = i - start + 1;
      if (run > 1 && (!streak || run > streak.years)) streak = { years: run, from: years[start], to: years[i] };
    }
    const cities = [...new Map(list.flatMap((e) => (e.city ? [[fold(e.city), e.city] as const] : []))).values()];
    const regulars = top(list, 'artist', 50)
      .filter((r) => r.count > 1)
      .slice(0, 5)
      .map(({ label, count }) => ({ label, count }));
    out.push({
      name,
      editions: list.length,
      years,
      streak,
      cities,
      acts: new Set(list.flatMap((e) => e.seen.map((s) => s.key))).size,
      regulars,
    });
  }
  return out.sort((a, b) => b.editions - a.editions || (b.streak?.years ?? 0) - (a.streak?.years ?? 0) || a.name.localeCompare(b.name));
}

// The "All time" strip at the top of Stats (docs/archive/quiet-tips-table.md): the totals the Table's summary line
// used to show, counted over events you went to, plus how many cities they were in.
export interface AllTime extends Summary {
  cities: number;
}

export function allTime(events: LoggedEvent[], day = new Date().toISOString().slice(0, 10)): AllTime {
  const s = summarize(events, day);
  const went = events.filter((e) => attendanceOf(e, day) === 'went');
  const cities = new Set(went.flatMap((e) => cityWithRegion(e.city, e.region)?.toLowerCase() ?? []));
  return { ...s, cities: cities.size };
}
