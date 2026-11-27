import type { LoggedEvent } from '../server/events/types';
import { attendanceOf, wentTo } from '../server/events/attendance';
import type { ArtistGenres, GenreVocabulary } from '../server/events/genreTypes';
import { genreKey, genresUnder, NOT_GROUPED, umbrellaClosure } from '../server/events/genreVocabulary';
import { umbrellaNames } from './genres';

// Pure browser-side genre maths (docs/specs/genre-explore.md sections 5 and 6).
// Never reads the system clock: `today` (YYYY-MM-DD) is always passed in.

export const LATELY_WINDOW_DAYS = 365;
export const RISING_MIN_SETS = 5;
export const RISING_MIN_EVENTS = 3;
export const RISING_MIN_SHARE_GAIN = 0.10;
export const RISING_LIMIT = 4;
export const COOLING_MIN_BEFORE_SETS = 5;
export const COOLING_LIMIT = 2;
export const GONE_QUIET_MIN_SETS = 5;
export const GONE_QUIET_MONTHS = 18;
export const COMING_UP_LIMIT = 3;

export type GenrePeriod = 'all' | 'last12' | number;
export type GenreTarget = { kind: 'group' | 'style' | 'umbrella'; name: string };

export interface ArtistBehindRow {
  key: string;
  name: string;
  weightedSets: number;
  sets: number;
  lastSeen: string | null;
  lastSeenSort: string | null;
}

export interface RisingGenre {
  key: string;
  name: string;
  kind: 'style' | 'umbrella';
  beforeSets: number;
  recentSets: number;
  beforeShare: number;
  recentShare: number;
  recentEvents: number;
  topArtists: ArtistBehindRow[];
}

export interface RisingResult {
  items: RisingGenre[];
  recentKnownSets: number;
  windowStart: string;
}

export interface CoolingGenre {
  key: string;
  name: string;
  kind: 'style' | 'umbrella';
  beforeSets: number;
  recentSets: number;
}

export interface GoneQuietGenre {
  key: string;
  name: string;
  sets: number;
  lastDate: string | null;
  lastSortDate: string;
  lastEvent: string;
  lastEventId: string;
  lastAct: string;
}

export interface ComingUpItem {
  key: string;
  name: string;
  actName: string;
  eventName: string;
  eventId: string;
  venue?: string;
  date: string | null;
  firstSince?: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');

function eventSortDate(e: Pick<LoggedEvent, 'startDate' | 'year' | 'month'>): string | null {
  if (e.startDate) return e.startDate;
  if (e.year && e.month) return `${e.year}-${pad(e.month)}-01`;
  if (e.year) return `${e.year}-01-01`;
  return null;
}

function eventDisplayDate(e: Pick<LoggedEvent, 'startDate' | 'year' | 'month'>): string | null {
  if (e.startDate) return e.startDate;
  if (e.year && e.month) return `${e.year}-${pad(e.month)}`;
  if (e.year) return String(e.year);
  return null;
}

function eventYearValue(e: Pick<LoggedEvent, 'startDate' | 'year'>): number | null {
  if (e.startDate) return Number(e.startDate.slice(0, 4));
  return e.year ?? null;
}

function shiftDays(isoDate: string, deltaDays: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function shiftMonths(isoDate: string, deltaMonths: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const totalMonths = y * 12 + (m - 1) + deltaMonths;
  const ty = Math.floor(totalMonths / 12);
  const tm = ((totalMonths % 12) + 12) % 12;
  const maxDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${pad(tm + 1)}-${pad(Math.min(d, maxDay))}`;
}

function buildUmbrellaLookup(vocab: GenreVocabulary | undefined): {
  names: Map<string, string>;
  ups: (key: string) => Set<string>;
} {
  const closure = umbrellaClosure(vocab);
  const names = umbrellaNames(vocab);
  return {
    names,
    ups: (key: string) => {
      const out = new Set(closure.get(key) ?? []);
      if (names.has(key)) out.add(key);
      return out;
    },
  };
}

export function periodEvents(events: LoggedEvent[], period: GenrePeriod, today: string): LoggedEvent[] {
  const went = wentTo(events, today);
  if (period === 'all') return went;
  if (period === 'last12') {
    const start = shiftDays(today, -(LATELY_WINDOW_DAYS - 1));
    return went.filter((e) => {
      const d = eventSortDate(e);
      return d !== null && d >= start && d <= today;
    });
  }
  return went.filter((e) => eventYearValue(e) === period);
}

export function artistsBehind(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  vocab: GenreVocabulary | undefined,
  target: GenreTarget,
): ArtistBehindRow[] {
  const targetKey = genreKey(target.name);
  const { ups } = target.kind === 'umbrella' ? buildUmbrellaLookup(vocab) : { ups: () => new Set<string>() };
  const rows = new Map<string, ArtistBehindRow>();

  for (const e of events) {
    if (e.attendance === 'planned' || e.attendance === 'missed') continue;
    const sortDate = eventSortDate(e);
    const displayDate = eventDisplayDate(e);
    for (const s of e.seen) {
      const g = byArtist.get(s.key);
      if (!g?.genres.length) continue;
      let w = 0;
      for (const x of g.genres) {
        if (target.kind === 'group') {
          if ((x.parent || NOT_GROUPED) === target.name) w += x.weight;
        } else if (target.kind === 'style') {
          if (genreKey(x.style) === targetKey) w += x.weight;
        } else {
          if (ups(genreKey(x.style)).has(targetKey)) w += x.weight;
        }
      }
      if (target.kind === 'umbrella') w = Math.min(1, w);
      if (w <= 0) continue;

      const cur = rows.get(s.key);
      if (!cur) {
        rows.set(s.key, {
          key: s.key,
          name: s.name,
          weightedSets: w,
          sets: 1,
          lastSeen: displayDate,
          lastSeenSort: sortDate,
        });
      } else {
        cur.weightedSets += w;
        cur.sets += 1;
        if (sortDate && (!cur.lastSeenSort || sortDate > cur.lastSeenSort)) {
          cur.lastSeenSort = sortDate;
          cur.lastSeen = displayDate;
        }
      }
    }
  }

  return [...rows.values()].sort((a, b) => b.weightedSets - a.weightedSets || a.name.localeCompare(b.name));
}

interface WindowGenreStats {
  knownSets: number;
  entries: Map<
    string,
    {
      key: string;
      name: string;
      kind: 'style' | 'umbrella';
      sets: number;
      events: Set<string>;
    }
  >;
}

function collectWindowStats(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  vocab: GenreVocabulary | undefined,
): WindowGenreStats {
  const { names, ups } = buildUmbrellaLookup(vocab);
  const entries: WindowGenreStats['entries'] = new Map();
  let knownSets = 0;

  const add = (key: string, name: string, kind: 'style' | 'umbrella', weight: number, eventId: string) => {
    let cur = entries.get(key);
    if (!cur) {
      cur = { key, name, kind, sets: 0, events: new Set() };
      entries.set(key, cur);
    }
    cur.sets += weight;
    cur.events.add(eventId);
  };

  for (const e of events) {
    for (const s of e.seen) {
      const g = byArtist.get(s.key);
      if (!g?.genres.length) continue;
      knownSets += 1;

      const styleWeight = new Map<string, { name: string; weight: number }>();
      for (const x of g.genres) {
        const k = genreKey(x.style);
        if (!k) continue;
        const prev = styleWeight.get(k);
        if (prev) prev.weight += x.weight;
        else styleWeight.set(k, { name: x.style, weight: x.weight });
      }

      const umbrellaWeight = new Map<string, number>();
      for (const [k, info] of styleWeight) {
        if (!names.has(k)) {
          add(k, info.name, 'style', info.weight, e.id);
        }
        for (const u of ups(k)) {
          umbrellaWeight.set(u, (umbrellaWeight.get(u) ?? 0) + info.weight);
        }
      }
      for (const [u, w] of umbrellaWeight) {
        add(u, names.get(u) ?? u, 'umbrella', Math.min(1, w), e.id);
      }
    }
  }

  return { knownSets, entries };
}

function splitLatelyWindows(events: LoggedEvent[], today: string): {
  windowStart: string;
  recent: LoggedEvent[];
  previous: LoggedEvent[];
} {
  const went = wentTo(events, today);
  const windowStart = shiftDays(today, -(LATELY_WINDOW_DAYS - 1));
  const prevEnd = shiftDays(today, -LATELY_WINDOW_DAYS);
  const prevStart = shiftDays(today, -(LATELY_WINDOW_DAYS * 2 - 1));

  const recent: LoggedEvent[] = [];
  const previous: LoggedEvent[] = [];
  for (const e of went) {
    const d = eventSortDate(e);
    if (!d) continue;
    if (d >= windowStart && d <= today) recent.push(e);
    else if (d >= prevStart && d <= prevEnd) previous.push(e);
  }
  return { windowStart, recent, previous };
}

function dropUmbrellaIfChildQualifies<T extends { key: string; kind: 'style' | 'umbrella' }>(
  items: T[],
  vocab: GenreVocabulary | undefined,
): T[] {
  const qualifiedKeys = new Set(items.map((x) => x.key));
  return items.filter((item) => {
    if (item.kind !== 'umbrella') return true;
    for (const childKey of genresUnder(item.key, vocab)) {
      if (qualifiedKeys.has(childKey)) return false;
    }
    return true;
  });
}

export function rising(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  vocab: GenreVocabulary | undefined,
  today: string,
): RisingResult {
  const { windowStart, recent, previous } = splitLatelyWindows(events, today);
  const cur = collectWindowStats(recent, byArtist, vocab);
  const prev = collectWindowStats(previous, byArtist, vocab);

  const candidates: RisingGenre[] = [];
  for (const entry of cur.entries.values()) {
    const recentSets = entry.sets;
    const recentEvents = entry.events.size;
    if (recentSets < RISING_MIN_SETS || recentEvents < RISING_MIN_EVENTS) continue;
    const prevSets = prev.entries.get(entry.key)?.sets ?? 0;
    const recentShare = cur.knownSets ? recentSets / cur.knownSets : 0;
    const prevShare = prev.knownSets ? prevSets / prev.knownSets : 0;
    const doubled = recentSets >= prevSets * 2;
    const gainedShare = recentShare - prevShare >= RISING_MIN_SHARE_GAIN;
    if (!doubled && !gainedShare) continue;

    candidates.push({
      key: entry.key,
      name: entry.name,
      kind: entry.kind,
      beforeSets: prevSets,
      recentSets,
      beforeShare: prevShare,
      recentShare,
      recentEvents,
      topArtists: [],
    });
  }

  const deduped = dropUmbrellaIfChildQualifies(candidates, vocab)
    .sort((a, b) => (b.recentSets - b.beforeSets) - (a.recentSets - a.beforeSets) || b.recentSets - a.recentSets || a.name.localeCompare(b.name))
    .slice(0, RISING_LIMIT)
    .map((item) => ({
      ...item,
      topArtists: artistsBehind(recent, byArtist, vocab, { kind: item.kind, name: item.name }).slice(0, 2),
    }));

  return { items: deduped, recentKnownSets: cur.knownSets, windowStart };
}

export function cooling(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  vocab: GenreVocabulary | undefined,
  today: string,
): CoolingGenre[] {
  const { recent, previous } = splitLatelyWindows(events, today);
  const cur = collectWindowStats(recent, byArtist, vocab);
  const prev = collectWindowStats(previous, byArtist, vocab);

  const candidates: CoolingGenre[] = [];
  for (const entry of prev.entries.values()) {
    const beforeSets = entry.sets;
    if (beforeSets < COOLING_MIN_BEFORE_SETS) continue;
    const recentSets = cur.entries.get(entry.key)?.sets ?? 0;
    if (recentSets > beforeSets / 2) continue;
    candidates.push({
      key: entry.key,
      name: entry.name,
      kind: entry.kind,
      beforeSets,
      recentSets,
    });
  }

  return dropUmbrellaIfChildQualifies(candidates, vocab)
    .sort((a, b) => (b.beforeSets - b.recentSets) - (a.beforeSets - a.recentSets) || b.beforeSets - a.beforeSets || a.name.localeCompare(b.name))
    .slice(0, COOLING_LIMIT);
}

export function allGoneQuiet(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  _vocab: GenreVocabulary | undefined,
  today: string,
): GoneQuietGenre[] {
  const went = wentTo(events, today);
  const cutoff = shiftMonths(today, -GONE_QUIET_MONTHS);
  const byGenre = new Map<
    string,
    {
      key: string;
      name: string;
      sets: number;
      lastSortDate: string;
      lastDate: string | null;
      lastEvent: string;
      lastEventId: string;
      lastAct: string;
    }
  >();

  for (const e of went) {
    const sortDate = eventSortDate(e);
    if (!sortDate) continue;
    const displayDate = eventDisplayDate(e);
    for (const s of e.seen) {
      const g = byArtist.get(s.key);
      if (!g?.genres.length) continue;
      const seenKeys = new Set<string>();
      for (const x of g.genres) {
        const k = genreKey(x.style);
        if (!k || seenKeys.has(k)) continue;
        seenKeys.add(k);
        const cur = byGenre.get(k);
        if (!cur) {
          byGenre.set(k, {
            key: k,
            name: x.style,
            sets: 1,
            lastSortDate: sortDate,
            lastDate: displayDate,
            lastEvent: e.name,
            lastEventId: e.id,
            lastAct: s.name,
          });
        } else {
          cur.sets += 1;
          if (sortDate > cur.lastSortDate || (sortDate === cur.lastSortDate && s.name.localeCompare(cur.lastAct) < 0)) {
            cur.lastSortDate = sortDate;
            cur.lastDate = displayDate;
            cur.lastEvent = e.name;
            cur.lastEventId = e.id;
            cur.lastAct = s.name;
          }
        }
      }
    }
  }

  return [...byGenre.values()]
    .filter((g) => g.sets >= GONE_QUIET_MIN_SETS && g.lastSortDate <= cutoff)
    .sort((a, b) => b.sets - a.sets || a.lastSortDate.localeCompare(b.lastSortDate) || a.name.localeCompare(b.name));
}

export function goneQuiet(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  vocab: GenreVocabulary | undefined,
  today: string,
): GoneQuietGenre | null {
  return allGoneQuiet(events, byArtist, vocab, today)[0] ?? null;
}

export function comingUp(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  _vocab: GenreVocabulary | undefined,
  today: string,
  quietSince?: Map<string, string>,
): ComingUpItem[] {
  const upcoming = events
    .filter((e) => attendanceOf(e, today) === 'upcoming')
    .sort((a, b) => (eventSortDate(a) ?? '9999-99-99').localeCompare(eventSortDate(b) ?? '9999-99-99') || a.name.localeCompare(b.name));

  const seenKeys = new Set<string>();
  const out: ComingUpItem[] = [];

  for (const e of upcoming) {
    const date = eventDisplayDate(e);
    for (const s of e.seen) {
      const g = byArtist.get(s.key);
      if (!g?.genres.length) continue;
      for (const x of g.genres) {
        const k = genreKey(x.style);
        if (!k || seenKeys.has(k)) continue;
        seenKeys.add(k);
        out.push({
          key: k,
          name: x.style,
          actName: s.name,
          eventName: e.name,
          eventId: e.id,
          venue: e.venue,
          date,
          firstSince: quietSince?.get(k),
        });
        if (out.length >= COMING_UP_LIMIT) return out;
      }
    }
  }

  return out;
}
