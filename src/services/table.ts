import type { LineupSummary, LoggedEvent } from '../server/events/types';
import { eventScale, LineupFacts } from '../server/events/scale';
import { eventYear } from './format';

// The Table view: filters, sorting and a summary over the event list the app
// already loaded. Read-only; nothing here is stored. An empty field is a gap,
// never a zero, so every "has" filter can also pick events where it is not set.

export type Has = 'any' | 'yes' | 'no';
export type HasField = 'seen' | 'rating' | 'price' | 'companions' | 'lineup';
export const HAS_FIELDS: HasField[] = ['seen', 'rating', 'price', 'companions', 'lineup'];

export type Needs = 'any' | 'date' | 'pick' | 'review';
export type Origin = 'any' | 'typed' | 'email';
export type KindFilter = 'any' | 'concert' | 'festival' | 'unknown';
export type SortKey = 'date' | 'name' | 'venue' | 'city' | 'seen' | 'rating' | 'price';

export interface TableFilters {
  q: string;
  yearFrom?: number;
  yearTo?: number;
  venue: string;
  city: string;
  country: string;
  artist: string; // a seen act's key
  companion: string;
  minRating?: number; // 1-5
  has: Partial<Record<HasField, Has>>;
  needs: Needs;
  origin: Origin;
  kind: KindFilter;
  format: string;
  sort: SortKey;
  desc: boolean;
}

export const EMPTY_FILTERS: TableFilters = {
  q: '',
  venue: '',
  city: '',
  country: '',
  artist: '',
  companion: '',
  has: {},
  needs: 'any',
  origin: 'any',
  kind: 'any',
  format: '',
  sort: 'date',
  desc: true,
};

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function fromEmail(e: LoggedEvent): boolean {
  return Object.values(e.sources).some((s) => s?.sourceType === 'email');
}

function hasField(e: LoggedEvent, f: HasField): boolean {
  switch (f) {
    case 'seen':
      return e.seen.length > 0;
    case 'rating':
      return e.rating !== undefined && e.rating !== null;
    case 'price':
      return e.ticketPrice !== undefined && e.ticketPrice !== null;
    case 'companions':
      return e.companions.length > 0;
    case 'lineup':
      return Boolean(e.editionId);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// A date cell split into parts, so day, month and year line up in their own
// columns down the table. Parts the event does not have stay empty, and the
// note says what is missing; nothing is filled in.
export interface TableDate {
  day?: string;
  month?: string;
  year: string;
  note?: string;
}

const utc = (iso: string) => new Date(`${iso}T12:00:00Z`);

export function tableDate(e: Pick<LoggedEvent, 'startDate' | 'endDate' | 'year' | 'month'>): TableDate | null {
  if (e.startDate) {
    const start = utc(e.startDate);
    const parts = { day: String(start.getUTCDate()), month: MONTHS[start.getUTCMonth()], year: String(start.getUTCFullYear()) };
    if (e.endDate && e.endDate > e.startDate) {
      const end = utc(e.endDate);
      const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
      const year = end.getUTCFullYear() === start.getUTCFullYear() ? '' : ` ${end.getUTCFullYear()}`;
      return { ...parts, note: `${days} days, to ${end.getUTCDate()} ${MONTHS[end.getUTCMonth()]}${year}` };
    }
    return { ...parts, note: WEEKDAYS[start.getUTCDay()] };
  }
  if (e.year && e.month) return { month: MONTHS[e.month - 1], year: String(e.year), note: 'Day not known' };
  if (e.year) return { year: String(e.year), note: 'Month not known' };
  return null;
}

// What an event still needs, if anything, in the terms of the "needs" filter.
export function needsOf(e: LoggedEvent, lineup?: LineupSummary): Exclude<Needs, 'any'> | null {
  if (e.details.status === 'needs_date' || (!e.startDate && !e.year)) return 'date';
  if (e.details.status === 'choose') return 'pick';
  if (lineup?.status === 'needs_review' && !e.editionId) return 'review';
  return null;
}

export function matches(e: LoggedEvent, f: TableFilters, lineup?: LineupSummary, facts?: LineupFacts): boolean {
  const q = fold(f.q);
  if (q) {
    const text = [e.name, e.venue, e.city, e.country, e.notes, ...e.seen.map((s) => s.name), ...e.companions]
      .filter(Boolean)
      .map((s) => fold(String(s)))
      .join('\n');
    if (!q.split(/\s+/).every((word) => text.includes(word))) return false;
  }
  if (f.yearFrom !== undefined || f.yearTo !== undefined) {
    const y = eventYear(e);
    if (y === null) return false;
    if (f.yearFrom !== undefined && y < f.yearFrom) return false;
    if (f.yearTo !== undefined && y > f.yearTo) return false;
  }
  if (f.venue && e.venue !== f.venue) return false;
  if (f.city && e.city !== f.city) return false;
  if (f.country && e.country !== f.country) return false;
  if (f.artist && !e.seen.some((s) => s.key === f.artist)) return false;
  if (f.companion && !e.companions.includes(f.companion)) return false;
  if (f.minRating !== undefined && !(typeof e.rating === 'number' && e.rating >= f.minRating)) return false;
  for (const field of HAS_FIELDS) {
    const want = f.has[field] ?? 'any';
    if (want !== 'any' && hasField(e, field) !== (want === 'yes')) return false;
  }
  if (f.needs !== 'any' && needsOf(e, lineup) !== f.needs) return false;
  if (f.origin !== 'any' && fromEmail(e) !== (f.origin === 'email')) return false;
  if (f.kind !== 'any' && (eventScale(e, facts).kind ?? 'unknown') !== f.kind) return false;
  if (f.format && e.format !== f.format) return false;
  return true;
}

// The value a column sorts by; undefined sorts last in either direction.
function sortValue(e: LoggedEvent, key: SortKey): string | number | undefined {
  switch (key) {
    case 'date':
      return e.startDate ?? (e.year ? `${e.year}-${String(e.month ?? 0).padStart(2, '0')}` : undefined);
    case 'name':
      return fold(e.name);
    case 'venue':
      return e.venue ? fold(e.venue) : undefined;
    case 'city':
      return e.city ? fold(e.city) : undefined;
    case 'seen':
      return e.seen.length;
    case 'rating':
      return e.rating ?? undefined;
    case 'price':
      return e.ticketPrice ?? undefined;
  }
}

export function sortRows(events: LoggedEvent[], key: SortKey, desc: boolean): LoggedEvent[] {
  return [...events].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va === undefined || vb === undefined) return va === vb ? 0 : va === undefined ? 1 : -1;
    const c = va < vb ? -1 : va > vb ? 1 : 0;
    return (desc ? -c : c) || a.name.localeCompare(b.name);
  });
}

export function filterEvents(
  events: LoggedEvent[],
  f: TableFilters,
  lineups: Record<string, LineupSummary> = {},
  editions: Record<string, LineupFacts> = {},
): LoggedEvent[] {
  return sortRows(
    events.filter((e) => matches(e, f, lineups[e.id], editions[e.id])),
    f.sort,
    f.desc,
  );
}

// The pick lists, built only from values in your own log, most used first.
export interface Options {
  venues: string[];
  cities: string[];
  countries: string[];
  artists: Array<{ key: string; name: string }>;
  companions: string[];
  formats: string[];
  years: number[];
}

function byCount(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
}

export function filterOptions(events: LoggedEvent[]): Options {
  const names = new Map<string, string>();
  for (const e of events) for (const s of e.seen) if (!names.has(s.key)) names.set(s.key, s.name);
  const years = [...new Set(events.map(eventYear).filter((y): y is number => y !== null))].sort((a, b) => b - a);
  return {
    venues: byCount(events.flatMap((e) => (e.venue ? [e.venue] : []))),
    cities: byCount(events.flatMap((e) => (e.city ? [e.city] : []))),
    countries: byCount(events.flatMap((e) => (e.country ? [e.country] : []))),
    artists: byCount(events.flatMap((e) => e.seen.map((s) => s.key))).map((key) => ({ key, name: names.get(key)! })),
    companions: byCount(events.flatMap((e) => e.companions)),
    formats: byCount(events.flatMap((e) => (e.format ? [e.format] : []))),
    years,
  };
}

// The line above the table. Rating and price say how many events they cover.
export interface Summary {
  events: number;
  acts: number; // distinct acts seen
  venues: number;
  firstYear?: number;
  lastYear?: number;
  rated: number;
  averageRating?: number;
  priced: number;
  totalPrice?: number;
}

export function summarize(events: LoggedEvent[]): Summary {
  const years = events.map(eventYear).filter((y): y is number => y !== null);
  const ratings = events.flatMap((e) => (typeof e.rating === 'number' ? [e.rating] : []));
  const prices = events.flatMap((e) => (typeof e.ticketPrice === 'number' ? [e.ticketPrice] : []));
  return {
    events: events.length,
    acts: new Set(events.flatMap((e) => e.seen.map((s) => s.key))).size,
    venues: new Set(events.flatMap((e) => (e.venue ? [fold(e.venue)] : []))).size,
    firstYear: years.length ? Math.min(...years) : undefined,
    lastYear: years.length ? Math.max(...years) : undefined,
    rated: ratings.length,
    averageRating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : undefined,
    priced: prices.length,
    totalPrice: prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) * 100) / 100 : undefined,
  };
}

// Filters live in the page address so a view can be bookmarked.
export function filtersToQuery(f: TableFilters): string {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.yearFrom !== undefined) p.set('from', String(f.yearFrom));
  if (f.yearTo !== undefined) p.set('to', String(f.yearTo));
  if (f.venue) p.set('venue', f.venue);
  if (f.city) p.set('city', f.city);
  if (f.country) p.set('country', f.country);
  if (f.artist) p.set('artist', f.artist);
  if (f.companion) p.set('with', f.companion);
  if (f.minRating !== undefined) p.set('rating', String(f.minRating));
  for (const field of HAS_FIELDS) {
    const v = f.has[field];
    if (v && v !== 'any') p.set(`has_${field}`, v);
  }
  if (f.needs !== 'any') p.set('needs', f.needs);
  if (f.origin !== 'any') p.set('from_source', f.origin);
  if (f.kind !== 'any') p.set('type', f.kind);
  if (f.format) p.set('format', f.format);
  if (f.sort !== 'date' || !f.desc) p.set('sort', `${f.sort}${f.desc ? '' : ':asc'}`);
  return p.toString();
}

const int = (s: string | null, min: number, max: number) => {
  const n = s === null ? NaN : Number(s);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
};
const oneOf = <T extends string>(s: string | null, values: readonly T[], fallback: T): T =>
  values.includes(s as T) ? (s as T) : fallback;

export function filtersFromQuery(query: string): TableFilters {
  const p = new URLSearchParams(query);
  const has: TableFilters['has'] = {};
  for (const field of HAS_FIELDS) {
    const v = oneOf(p.get(`has_${field}`), ['any', 'yes', 'no'] as const, 'any');
    if (v !== 'any') has[field] = v;
  }
  const [sort, dir] = (p.get('sort') ?? '').split(':');
  return {
    q: p.get('q') ?? '',
    yearFrom: int(p.get('from'), 1900, 3000),
    yearTo: int(p.get('to'), 1900, 3000),
    venue: p.get('venue') ?? '',
    city: p.get('city') ?? '',
    country: p.get('country') ?? '',
    artist: p.get('artist') ?? '',
    companion: p.get('with') ?? '',
    minRating: int(p.get('rating'), 1, 5),
    has,
    needs: oneOf(p.get('needs'), ['any', 'date', 'pick', 'review'] as const, 'any'),
    origin: oneOf(p.get('from_source'), ['any', 'typed', 'email'] as const, 'any'),
    kind: oneOf(p.get('type'), ['any', 'concert', 'festival', 'unknown'] as const, 'any'),
    format: p.get('format') ?? '',
    sort: oneOf(sort, ['date', 'name', 'venue', 'city', 'seen', 'rating', 'price'] as const, 'date'),
    desc: dir !== 'asc',
  };
}

export function activeFilterCount(f: TableFilters): number {
  return (
    [f.q, f.venue, f.city, f.country, f.artist, f.companion, f.format].filter(Boolean).length +
    [f.yearFrom, f.yearTo, f.minRating].filter((v) => v !== undefined).length +
    Object.values(f.has).filter((v) => v && v !== 'any').length +
    (f.needs !== 'any' ? 1 : 0) +
    (f.origin !== 'any' ? 1 : 0) +
    (f.kind !== 'any' ? 1 : 0)
  );
}

// "Fill gaps": what an event is missing, one kind of gap at a time.
export type Gap =
  | 'date'
  | 'venue'
  | 'city'
  | 'type'
  | 'format'
  | 'seen'
  | 'favourite'
  | 'companions'
  | 'rating'
  | 'price'
  | 'weather'
  | 'review';
export const GAPS: Gap[] = ['date', 'venue', 'city', 'type', 'seen', 'review', 'favourite', 'format', 'companions', 'rating', 'price', 'weather'];

const today = () => new Date().toISOString().slice(0, 10);

export function hasGap(e: LoggedEvent, gap: Gap, lineup?: LineupSummary, facts?: LineupFacts): boolean {
  switch (gap) {
    case 'date':
      return !e.startDate;
    case 'venue':
      return !e.venue;
    case 'city':
      return !e.city;
    case 'type':
      return !eventScale(e, facts).kind;
    case 'format':
      return !e.format;
    case 'seen':
      return e.seen.length === 0;
    case 'favourite':
      return e.seen.length > 0 && !e.seen.some((s) => s.favourite);
    case 'companions':
      return e.companions.length === 0;
    case 'rating':
      return typeof e.rating !== 'number';
    case 'price':
      return typeof e.ticketPrice !== 'number';
    case 'weather':
      // Only events it can be looked up for: a past date and a city.
      return !e.weather && Boolean(e.startDate && e.city) && e.startDate! < today();
    case 'review':
      return lineup?.status === 'needs_review' && !e.editionId;
  }
}

export function gapCounts(
  events: LoggedEvent[],
  lineups: Record<string, LineupSummary> = {},
  editions: Record<string, LineupFacts> = {},
): Record<Gap, number> {
  const out = Object.fromEntries(GAPS.map((g) => [g, 0])) as Record<Gap, number>;
  for (const e of events) for (const g of GAPS) if (hasGap(e, g, lineups[e.id], editions[e.id])) out[g] += 1;
  return out;
}

// Events that can start a lineup lookup from the Table: dated, no confirmed
// lineup, and no lookup that is running, waiting or ready for review.
export function canFindLineup(e: LoggedEvent, lineup?: LineupSummary): boolean {
  if (e.editionId || (!e.year && !e.startDate)) return false;
  return !lineup || lineup.status === 'failed';
}
