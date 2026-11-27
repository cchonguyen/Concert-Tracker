import type { LoggedEvent } from '../server/events/types';
import { attendanceOf, wentTo } from '../server/events/attendance';
import type { ArtistGenres, GenreLevel, GenreVocabulary, VocabGenre } from '../server/events/genreTypes';
import {
  genreKey,
  genreResolver,
  genresUnder,
  levelOf,
  NOT_GROUPED,
  shareGroup,
  umbrellaClosure,
} from '../server/events/genreVocabulary';
import { eventScale, type LineupFacts } from '../server/events/scale';
import { genreMix, umbrellaNames } from './genres';

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
export const FIRSTS_MIN_SETS = 10;
export const MILESTONE_MARKS = [10, 25, 50, 100, 250] as const;
export const MILESTONE_NEAR_WITHIN = 5;
export const MILESTONE_LATEST_LIMIT = 4;
export const TEN_YEARS_MONTHS = 120;
export const LABEL_MIN_SETS = 30;
export const LABEL_SHAPE_SHIFTER_RECENT_MIN = 10;
export const LABEL_DEVOTED_SHARE = 0.60;
export const LABEL_DOUBLE_ACT_COMBINED = 0.75;
export const LABEL_DOUBLE_ACT_EACH = 0.25;
export const LABEL_DEEP_DIVER_SHARE = 0.25;
export const LABEL_EXPLORER_MIN_GROUPS = 5;
export const LABEL_EXPLORER_MAX_SHARE = 0.40;
export const YEARS_MIN_SETS = 10;
export const YEARS_MIN_COUNTED = 3;
export const YEARS_TOP_GROUPS = 5;
export const SPLIT_MIN_SETS = 10;
export const SEASON_MIN_LEAD_POINTS = 0.05;
export const YEAR_GENRES_MIN_SETS = 10;
export const YEAR_FAVOURITES_MIN = 3;
export const PEOPLE_MIN_SHOWS = 3;
export const PEOPLE_MIN_GROUP_SHOWS = 3;
export const PEOPLE_HEADLINE_SHARE = 0.50;

export type GenrePeriod = 'all' | 'last12' | number;
// 'group' is the macro genre when the vocabulary has a taxonomy; 'family' is a family.
export type GenreTarget = { kind: 'group' | 'family' | 'style' | 'umbrella'; name: string };

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
          if (shareGroup(x) === target.name) w += x.weight;
        } else if (target.kind === 'family') {
          if (x.family !== undefined && genreKey(x.family) === targetKey) w += x.weight;
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

export interface GenreFirstItem {
  group: string;
  year: number;
  acts: string[];
  moreCount: number;
  eventName: string;
  eventId: string;
  date: string;
  sortDate: string;
}

export interface GenreFirstsResult {
  knownSets: number;
  items: GenreFirstItem[];
}

export function genreFirsts(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  _vocab: GenreVocabulary | undefined,
  today: string,
): GenreFirstsResult {
  const went = wentTo(events, today);
  let knownSets = 0;
  const dated: Array<{ e: LoggedEvent; sortDate: string; displayDate: string }> = [];

  for (const e of went) {
    for (const s of e.seen) {
      if (byArtist.get(s.key)?.genres.length) knownSets += 1;
    }
    const sortDate = eventSortDate(e);
    const displayDate = eventDisplayDate(e);
    if (sortDate && displayDate) dated.push({ e, sortDate, displayDate });
  }

  dated.sort((a, b) => a.sortDate.localeCompare(b.sortDate) || a.e.name.localeCompare(b.e.name));

  const firstByGroup = new Map<string, GenreFirstItem>();
  for (const { e, sortDate, displayDate } of dated) {
    const actsByGroup = new Map<string, Set<string>>();
    for (const s of e.seen) {
      const g = byArtist.get(s.key);
      if (!g?.genres.length) continue;
      for (const x of g.genres) {
        const group = shareGroup(x);
        if (firstByGroup.has(group)) continue;
        let set = actsByGroup.get(group);
        if (!set) actsByGroup.set(group, (set = new Set()));
        set.add(s.name);
      }
    }
    for (const [group, actSet] of actsByGroup) {
      const sorted = [...actSet].sort((a, b) => a.localeCompare(b));
      firstByGroup.set(group, {
        group,
        year: Number(sortDate.slice(0, 4)),
        acts: sorted.slice(0, 2),
        moreCount: Math.max(0, sorted.length - 2),
        eventName: e.name,
        eventId: e.id,
        date: displayDate,
        sortDate,
      });
    }
  }

  const items = [...firstByGroup.values()].sort(
    (a, b) => a.sortDate.localeCompare(b.sortDate) || a.group.localeCompare(b.group),
  );
  return { knownSets, items };
}

export interface NewThisYearItem {
  key: string;
  name: string;
  firstAct: string;
  firstEvent: string;
  firstEventId: string;
  firstDate: string;
  firstSortDate: string;
}

export function newThisYear(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  _vocab: GenreVocabulary | undefined,
  today: string,
): NewThisYearItem[] {
  const went = wentTo(events, today);
  const currentYear = Number(today.slice(0, 4));
  const dated = went
    .map((e) => ({ e, sortDate: eventSortDate(e), displayDate: eventDisplayDate(e) }))
    .filter((x): x is { e: LoggedEvent; sortDate: string; displayDate: string } => Boolean(x.sortDate && x.displayDate))
    .sort((a, b) => a.sortDate.localeCompare(b.sortDate) || a.e.name.localeCompare(b.e.name));

  const firstByStyle = new Map<string, NewThisYearItem>();
  for (const { e, sortDate, displayDate } of dated) {
    for (const s of e.seen) {
      const g = byArtist.get(s.key);
      if (!g?.genres.length) continue;
      for (const x of g.genres) {
        const k = genreKey(x.style);
        if (!k || firstByStyle.has(k)) continue;
        firstByStyle.set(k, {
          key: k,
          name: x.style,
          firstAct: s.name,
          firstEvent: e.name,
          firstEventId: e.id,
          firstDate: displayDate,
          firstSortDate: sortDate,
        });
      }
    }
  }

  return [...firstByStyle.values()]
    .filter((item) => Number(item.firstSortDate.slice(0, 4)) === currentYear)
    .sort((a, b) => a.firstSortDate.localeCompare(b.firstSortDate) || a.name.localeCompare(b.name));
}

export interface GenreMilestoneReached {
  group: string;
  mark: number;
  actName: string;
  eventName: string;
  eventId: string;
  date: string | null;
  sortDate: string;
}

export interface GenreAnniversary {
  group: string;
  years: number;
}

export interface GenreNextUp {
  group: string;
  mark: number;
  remaining: number;
}

export interface GenreMilestonesResult {
  knownSets: number;
  reached: GenreMilestoneReached[];
  anniversaries: GenreAnniversary[];
  nextUp: GenreNextUp | null;
}

export function genreMilestones(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  _vocab: GenreVocabulary | undefined,
  today: string,
): GenreMilestonesResult {
  const went = wentTo(events, today).sort(
    (a, b) => (eventSortDate(a) ?? '9999-99-99').localeCompare(eventSortDate(b) ?? '9999-99-99') || a.name.localeCompare(b.name),
  );
  const recentStart = shiftDays(today, -(LATELY_WINDOW_DAYS - 1));
  const tenYearsCutoff = shiftMonths(today, -TEN_YEARS_MONTHS);

  let knownSets = 0;
  const counts = new Map<string, number>();
  const firstDateByGroup = new Map<string, string>();
  const hasRecentByGroup = new Set<string>();
  const allReached: GenreMilestoneReached[] = [];

  for (const e of went) {
    const sortDate = eventSortDate(e);
    const displayDate = eventDisplayDate(e);
    const inRecent = Boolean(sortDate && sortDate >= recentStart && sortDate <= today);
    for (const s of e.seen) {
      const g = byArtist.get(s.key);
      if (!g?.genres.length) continue;
      knownSets += 1;
      const seenGroups = new Set<string>();
      for (const x of g.genres) {
        const group = shareGroup(x);
        if (seenGroups.has(group)) continue;
        seenGroups.add(group);
        const next = (counts.get(group) ?? 0) + 1;
        counts.set(group, next);
        if (sortDate && !firstDateByGroup.has(group)) firstDateByGroup.set(group, sortDate);
        if (inRecent) hasRecentByGroup.add(group);
        if ((MILESTONE_MARKS as readonly number[]).includes(next) && sortDate) {
          allReached.push({
            group,
            mark: next,
            actName: s.name,
            eventName: e.name,
            eventId: e.id,
            date: displayDate,
            sortDate,
          });
        }
      }
    }
  }

  const reached = allReached
    .sort((a, b) => b.sortDate.localeCompare(a.sortDate) || b.mark - a.mark || a.group.localeCompare(b.group))
    .slice(0, MILESTONE_LATEST_LIMIT);

  const anniversaries: GenreAnniversary[] = [];
  for (const [group, first] of firstDateByGroup) {
    if (first <= tenYearsCutoff && hasRecentByGroup.has(group)) {
      const years = Math.max(10, Number(today.slice(0, 4)) - Number(first.slice(0, 4)));
      anniversaries.push({ group, years });
    }
  }
  anniversaries.sort((a, b) => b.years - a.years || a.group.localeCompare(b.group));

  let nextUp: GenreNextUp | null = null;
  for (const [group, count] of counts) {
    const mark = MILESTONE_MARKS.find((m) => m > count && m - count <= MILESTONE_NEAR_WITHIN);
    if (mark === undefined) continue;
    const remaining = mark - count;
    if (!nextUp || remaining < nextUp.remaining || (remaining === nextUp.remaining && mark < nextUp.mark)) {
      nextUp = { group, mark, remaining };
    }
  }

  return { knownSets, reached, anniversaries, nextUp };
}

export interface GenreRangeResult {
  knownSets: number;
  styleCount: number;
  seenGroupCount: number;
  totalGroupCount: number;
  squares: Array<{ group: string; seen: boolean }>;
  missingGroups: string[];
  topGroup: { name: string; sets: number; share: number } | null;
}

export function genreRange(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  vocab: GenreVocabulary | undefined,
  today: string,
  mapGroups?: string[],
): GenreRangeResult {
  const went = wentTo(events, today);
  const mix = genreMix(went, byArtist, vocab);
  const seenSet = new Set(mix.parents.map((p) => p.name).filter((g) => g !== NOT_GROUPED));
  const orderedGroups = mapGroups?.length
    ? [...new Set(mapGroups.filter((g) => g && g !== NOT_GROUPED))]
    : mix.parents.map((p) => p.name).filter((g) => g !== NOT_GROUPED);

  return {
    knownSets: mix.known,
    styleCount: mix.styles.length,
    seenGroupCount: orderedGroups.filter((g) => seenSet.has(g)).length,
    totalGroupCount: orderedGroups.length,
    squares: orderedGroups.map((group) => ({ group, seen: seenSet.has(group) })),
    missingGroups: orderedGroups.filter((g) => !seenSet.has(g)),
    topGroup: mix.parents[0] ?? null,
  };
}

export type GenreLabelName = 'Shape-shifter' | 'Devoted' | 'Double act' | 'Deep diver' | 'Explorer' | 'All-rounder';

export interface GenreLabelResult {
  label: GenreLabelName;
  rule: string;
}

export function genreLabel(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  vocab: GenreVocabulary | undefined,
  today: string,
): GenreLabelResult | null {
  const went = wentTo(events, today);
  const allMix = genreMix(went, byArtist, vocab);
  if (allMix.known < LABEL_MIN_SETS) return null;

  const recentMix = genreMix(periodEvents(went, 'last12', today), byArtist, vocab);
  if (
    recentMix.known >= LABEL_SHAPE_SHIFTER_RECENT_MIN &&
    recentMix.parents[0] &&
    allMix.parents[0] &&
    recentMix.parents[0].name !== allMix.parents[0].name
  ) {
    return { label: 'Shape-shifter', rule: "Your top genre lately isn't your all-time top genre." };
  }

  const p0 = allMix.parents[0];
  const p1 = allMix.parents[1];
  if (p0 && p0.share >= LABEL_DEVOTED_SHARE) {
    return { label: 'Devoted', rule: 'One genre is 60% or more of your sets.' };
  }
  if (p0 && p1 && p0.share + p1.share >= LABEL_DOUBLE_ACT_COMBINED && p0.share >= LABEL_DOUBLE_ACT_EACH && p1.share >= LABEL_DOUBLE_ACT_EACH) {
    return { label: 'Double act', rule: 'Two genres make up three quarters of your sets.' };
  }
  if ((allMix.styles[0]?.share ?? 0) >= LABEL_DEEP_DIVER_SHARE) {
    return { label: 'Deep diver', rule: 'One style is a quarter of everything you see.' };
  }
  const namedGroups = allMix.parents.filter((p) => p.name !== NOT_GROUPED);
  if (namedGroups.length >= LABEL_EXPLORER_MIN_GROUPS && (p0?.share ?? 0) <= LABEL_EXPLORER_MAX_SHARE) {
    return { label: 'Explorer', rule: 'No genre is over 40%, across 5 or more groups.' };
  }
  return { label: 'All-rounder', rule: 'A bit of everything.' };
}

export interface GenreYearRow {
  year: number;
  knownSets: number;
  thin: boolean;
  topGroup: string | null;
  shares: Record<string, number>;
}

export interface GenreByYearResult {
  groups: string[];
  hasOther: boolean;
  countedYears: number;
  years: GenreYearRow[];
}

export function genreByYear(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  vocab: GenreVocabulary | undefined,
  today: string,
): GenreByYearResult {
  const went = wentTo(events, today);
  const allMix = genreMix(went, byArtist, vocab);
  const groups = allMix.parents.slice(0, YEARS_TOP_GROUPS).map((p) => p.name);
  const topSet = new Set(groups);

  const byYr = new Map<number, LoggedEvent[]>();
  for (const e of went) {
    const y = eventYearValue(e);
    if (!y) continue;
    let list = byYr.get(y);
    if (!list) byYr.set(y, (list = []));
    list.push(e);
  }

  let hasOther = false;
  const years: GenreYearRow[] = [];
  for (const y of [...byYr.keys()].sort((a, b) => a - b)) {
    const mix = genreMix(byYr.get(y)!, byArtist, vocab);
    if (mix.known === 0) continue;
    const shares: Record<string, number> = {};
    for (const g of groups) shares[g] = 0;
    let other = 0;
    for (const p of mix.parents) {
      if (topSet.has(p.name)) shares[p.name] = p.share;
      else other += p.share;
    }
    if (other > 0) {
      hasOther = true;
      shares.Other = other;
    }
    years.push({
      year: y,
      knownSets: mix.known,
      thin: mix.known < YEARS_MIN_SETS,
      topGroup: mix.parents[0]?.name ?? null,
      shares,
    });
  }

  return {
    groups,
    hasOther,
    countedYears: years.filter((y) => !y.thin).length,
    years,
  };
}

export function genreStoryLine(byYear: GenreByYearResult): string | null {
  if (byYear.countedYears < YEARS_MIN_COUNTED) return null;
  const counted = byYear.years.filter((y) => !y.thin && y.topGroup);
  if (counted.length < YEARS_MIN_COUNTED) return null;

  const firstLeader = counted[0].topGroup!;
  if (counted.every((y) => y.topGroup === firstLeader)) {
    return `${firstLeader} has led every year since ${counted[0].year}.`;
  }

  for (let i = counted.length - 2; i >= 1; i--) {
    const prev = counted[i - 1].topGroup!;
    const cur = counted[i].topGroup!;
    const next = counted[i + 1].topGroup!;
    if (cur !== prev && next === cur) {
      return `You moved from ${prev.toLowerCase()} to ${cur.toLowerCase()} around ${counted[i].year}.`;
    }
  }

  return 'Your top genre changes from year to year.';
}

export interface GenreSplitBar {
  label: string;
  knownSets: number;
  topGroup: string;
  segments: Array<{ group: string; sets: number; share: number }>;
}

export interface GenreByKindResult {
  bars: GenreSplitBar[];
  headline: string | null;
}

function pluralKind(label: string): string {
  if (label === 'Concert') return 'Concerts';
  if (label === 'Festival') return 'Festivals';
  return label.toLowerCase().endsWith('s') ? label : `${label}s`;
}

export function genreByKind(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  vocab: GenreVocabulary | undefined,
  today: string,
  editions?: Record<string, LineupFacts>,
): GenreByKindResult {
  const went = wentTo(events, today);
  const buckets = new Map<string, { label: string; events: LoggedEvent[] }>();

  const pushBucket = (key: string, label: string, e: LoggedEvent) => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { label, events: [] }));
    b.events.push(e);
  };

  for (const e of went) {
    const scale = eventScale(e, editions?.[e.id]);
    if (scale.kind === 'concert') pushBucket('kind:concert', 'Concert', e);
    else if (scale.kind === 'festival') pushBucket('kind:festival', 'Festival', e);

    const fmt = e.format?.trim();
    if (fmt) pushBucket(`fmt:${fmt.toLowerCase()}`, fmt, e);
  }

  const bars: GenreSplitBar[] = [];
  for (const b of buckets.values()) {
    const mix = genreMix(b.events, byArtist, vocab);
    if (mix.known < SPLIT_MIN_SETS || !mix.parents.length) continue;
    bars.push({
      label: b.label,
      knownSets: mix.known,
      topGroup: mix.parents[0].name,
      segments: mix.parents.map((p) => ({ group: p.name, sets: p.sets, share: p.share })),
    });
  }

  bars.sort((a, b) => b.knownSets - a.knownSets || a.label.localeCompare(b.label));

  let headline: string | null = null;
  if (bars.length >= 2) {
    const [a, b] = bars;
    if (a.topGroup === b.topGroup) {
      headline = `${a.topGroup} leads at every kind of night.`;
    } else {
      headline = `${pluralKind(a.label)} are for ${a.topGroup.toLowerCase()}. ${pluralKind(b.label)} are for ${b.topGroup.toLowerCase()}.`;
    }
  }

  return { bars, headline };
}

export interface GenreSeasonTile {
  label: 'Dec–Feb' | 'Mar–May' | 'Jun–Aug' | 'Sep–Nov';
  knownSets: number;
  enough: boolean;
  topGroup: { name: string; sets: number; share: number } | null;
}

export interface GenreBySeasonResult {
  tiles: GenreSeasonTile[];
  headline: string | null;
}

const SEASON_DEFS: Array<{ label: GenreSeasonTile['label']; months: number[] }> = [
  { label: 'Dec–Feb', months: [12, 1, 2] },
  { label: 'Mar–May', months: [3, 4, 5] },
  { label: 'Jun–Aug', months: [6, 7, 8] },
  { label: 'Sep–Nov', months: [9, 10, 11] },
];

function eventMonthValue(e: Pick<LoggedEvent, 'startDate' | 'month'>): number | null {
  if (e.startDate) return Number(e.startDate.slice(5, 7));
  return e.month ?? null;
}

export function genreBySeason(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  vocab: GenreVocabulary | undefined,
  today: string,
): GenreBySeasonResult {
  const went = wentTo(events, today);
  const allMix = genreMix(went, byArtist, vocab);
  const allShare = new Map(allMix.parents.map((p) => [p.name, p.share]));

  let bestLead = 0;
  let headline: string | null = null;

  const tiles: GenreSeasonTile[] = SEASON_DEFS.map(({ label, months }) => {
    const evs = went.filter((e) => {
      const m = eventMonthValue(e);
      return m !== null && months.includes(m);
    });
    const mix = genreMix(evs, byArtist, vocab);
    const enough = mix.known >= SPLIT_MIN_SETS;
    const topGroup = enough && mix.parents[0] ? mix.parents[0] : null;
    if (topGroup) {
      const lift = topGroup.share - (allShare.get(topGroup.name) ?? 0);
      if (lift >= SEASON_MIN_LEAD_POINTS && lift > bestLead) {
        bestLead = lift;
        headline = `${label} is when you go for ${topGroup.name.toLowerCase()}.`;
      }
    }
    return { label, knownSets: mix.known, enough, topGroup };
  });

  return { tiles, headline };
}

export interface YearGenreStyle {
  name: string;
  sets: number;
  share: number;
  topAct: string | null;
}

export interface YearGenresResult {
  year: number;
  nights: number;
  knownSets: number;
  totalSets: number;
  topStyle: YearGenreStyle;
  topStyles: YearGenreStyle[];
  newestToYou: { name: string; actName: string; date: string } | null;
  distinctStyles: number;
  prevDistinctStyles: number | null;
  biggestChange: { name: string; beforeSets: number; afterSets: number; delta: number } | null;
  favourites: { total: number; topStyle: string; topCount: number } | null;
}

export function yearGenres(
  events: LoggedEvent[],
  year: number,
  byArtist: Map<string, ArtistGenres>,
  vocab: GenreVocabulary | undefined,
  today: string,
): YearGenresResult | null {
  const went = wentTo(events, today);
  const yearEvs = went.filter((e) => eventYearValue(e) === year);
  const mix = genreMix(yearEvs, byArtist, vocab);
  if (mix.known < YEAR_GENRES_MIN_SETS || !mix.styles.length) return null;

  const topStyles: YearGenreStyle[] = mix.styles.slice(0, 5).map((s) => ({
    name: s.name,
    sets: s.sets,
    share: s.share,
    topAct: artistsBehind(yearEvs, byArtist, vocab, { kind: 'style', name: s.name })[0]?.name ?? null,
  }));

  const datedAll = went
    .map((e) => ({ e, sortDate: eventSortDate(e), displayDate: eventDisplayDate(e) }))
    .filter((x): x is { e: LoggedEvent; sortDate: string; displayDate: string } => Boolean(x.sortDate && x.displayDate))
    .sort((a, b) => a.sortDate.localeCompare(b.sortDate) || a.e.name.localeCompare(b.e.name));

  const firstByStyle = new Map<string, { name: string; actName: string; date: string; sortDate: string }>();
  for (const { e, sortDate, displayDate } of datedAll) {
    for (const s of e.seen) {
      const g = byArtist.get(s.key);
      if (!g?.genres.length) continue;
      for (const x of g.genres) {
        const k = genreKey(x.style);
        if (!k || firstByStyle.has(k)) continue;
        firstByStyle.set(k, { name: x.style, actName: s.name, date: displayDate, sortDate });
      }
    }
  }

  const newestMatch = [...firstByStyle.values()]
    .filter((x) => Number(x.sortDate.slice(0, 4)) === year)
    .sort((a, b) => a.sortDate.localeCompare(b.sortDate) || a.name.localeCompare(b.name))[0];

  const prevEvs = went.filter((e) => eventYearValue(e) === year - 1);
  const prevMix = genreMix(prevEvs, byArtist, vocab);
  let biggestChange: YearGenresResult['biggestChange'] = null;
  if (prevMix.known > 0) {
    const curMap = new Map(mix.styles.map((s) => [genreKey(s.name), s]));
    const prevMap = new Map(prevMix.styles.map((s) => [genreKey(s.name), s]));
    const allKeys = new Set([...curMap.keys(), ...prevMap.keys()]);
    let bestAbs = 0;
    for (const k of allKeys) {
      const afterSets = curMap.get(k)?.sets ?? 0;
      const beforeSets = prevMap.get(k)?.sets ?? 0;
      const delta = afterSets - beforeSets;
      const abs = Math.abs(delta);
      const name = curMap.get(k)?.name ?? prevMap.get(k)?.name ?? k;
      if (abs > bestAbs) {
        bestAbs = abs;
        biggestChange = { name, beforeSets, afterSets, delta };
      }
    }
  }

  let favTotal = 0;
  const favCounts = new Map<string, { name: string; count: number }>();
  for (const e of yearEvs) {
    for (const s of e.seen) {
      if (!s.favourite) continue;
      const g = byArtist.get(s.key);
      if (!g?.genres.length) continue;
      favTotal += 1;
      const seenKeys = new Set<string>();
      for (const x of g.genres) {
        const k = genreKey(x.style);
        if (!k || seenKeys.has(k)) continue;
        seenKeys.add(k);
        const cur = favCounts.get(k);
        if (cur) cur.count += 1;
        else favCounts.set(k, { name: x.style, count: 1 });
      }
    }
  }
  const topFav = [...favCounts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))[0];

  return {
    year,
    nights: yearEvs.length,
    knownSets: mix.known,
    totalSets: mix.sets,
    topStyle: topStyles[0],
    topStyles,
    newestToYou: newestMatch ? { name: newestMatch.name, actName: newestMatch.actName, date: newestMatch.date } : null,
    distinctStyles: mix.styles.length,
    prevDistinctStyles: prevMix.known > 0 ? prevMix.styles.length : null,
    biggestChange,
    favourites: favTotal >= YEAR_FAVOURITES_MIN && topFav ? { total: favTotal, topStyle: topFav.name, topCount: topFav.count } : null,
  };
}

export interface PersonGenreItem {
  id: string;
  name: string;
  shows: number;
  topGroups: Array<{ group: string; count: number; totalWithAnyone: number }>;
}

export interface PeopleGenresResult {
  people: PersonGenreItem[];
  headline: string | null;
}

export function peopleGenres(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  _vocab: GenreVocabulary | undefined,
  people: Map<string, string>,
  today?: string,
): PeopleGenresResult {
  const went = today
    ? wentTo(events, today)
    : events.filter((e) => e.attendance !== 'planned' && e.attendance !== 'missed');

  const groupWithAnyone = new Map<string, number>();
  const personStats = new Map<string, { id: string; name: string; shows: number; groups: Map<string, number> }>();

  for (const e of went) {
    if (e.peopleLocked) continue;

    const resolvedIds: Array<{ id: string; name: string }> = [];
    const seenPerson = new Set<string>();
    const rawIds = e.personIds?.length ? e.personIds : e.companions;
    for (const pid of rawIds) {
      const name = people.get(pid);
      if (!name || seenPerson.has(pid)) continue;
      seenPerson.add(pid);
      resolvedIds.push({ id: pid, name });
    }
    if (!resolvedIds.length) continue;

    const showGroups = new Set<string>();
    for (const s of e.seen) {
      const g = byArtist.get(s.key);
      if (!g?.genres.length) continue;
      for (const x of g.genres) showGroups.add(shareGroup(x));
    }
    if (!showGroups.size) continue;

    for (const grp of showGroups) {
      groupWithAnyone.set(grp, (groupWithAnyone.get(grp) ?? 0) + 1);
    }
    for (const p of resolvedIds) {
      let cur = personStats.get(p.id);
      if (!cur) {
        cur = { id: p.id, name: p.name, shows: 0, groups: new Map() };
        personStats.set(p.id, cur);
      }
      cur.shows += 1;
      for (const grp of showGroups) {
        cur.groups.set(grp, (cur.groups.get(grp) ?? 0) + 1);
      }
    }
  }

  const list: PersonGenreItem[] = [];
  let bestScore = 0;
  let headline: string | null = null;

  for (const p of personStats.values()) {
    if (p.shows < PEOPLE_MIN_SHOWS) continue;
    const topGroups = [...p.groups]
      .filter(([, count]) => count >= PEOPLE_MIN_GROUP_SHOWS)
      .map(([group, count]) => ({ group, count, totalWithAnyone: groupWithAnyone.get(group) ?? count }))
      .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group))
      .slice(0, 2);

    for (const g of topGroups) {
      const share = g.totalWithAnyone ? g.count / g.totalWithAnyone : 0;
      if (share > PEOPLE_HEADLINE_SHARE && g.count > bestScore) {
        bestScore = g.count;
        headline = `${g.group} nights are with ${p.name}.`;
      }
    }

    list.push({ id: p.id, name: p.name, shows: p.shows, topGroups });
  }

  list.sort((a, b) => b.shows - a.shows || a.name.localeCompare(b.name));
  return { people: list, headline };
}

export interface GenreTreeNode {
  key: string;
  name: string;
  level?: GenreLevel; // taxonomy tree only: macro, family or genre (absent: umbrella tree)
  sets: number;
  seen: boolean;
  children: GenreTreeNode[];
}

export interface GenreTreeRoot extends GenreTreeNode {
  seenBranches: number;
  totalBranches: number;
}

// The taxonomy tree (docs/specs/genre-taxonomy-phase-a.md section 7): macro, then family,
// then genre. A genre with no family, or a family with no macro, sits under "Not grouped",
// the same as its resolved macro or family. Counts use the vocabulary's links only.
const NONE_MACRO_KEY = 'macro:';
function taxonomyTree(
  vocab: GenreVocabulary,
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  today?: string,
): GenreTreeRoot[] {
  const resolver = genreResolver(vocab, [], []);
  const went = today
    ? wentTo(events, today)
    : events.filter((e) => e.attendance !== 'planned' && e.attendance !== 'missed');
  const counts = new Map<string, number>();
  for (const e of went) {
    for (const s of e.seen) {
      const g = byArtist.get(s.key);
      if (!g?.genres.length) continue;
      const keys = new Set<string>();
      for (const x of g.genres) {
        const r = resolver.resolve(x.style);
        if (!r.key) continue;
        keys.add(r.key);
        if (r.family) keys.add(r.family.key);
        keys.add(r.macro?.key ?? NONE_MACRO_KEY);
      }
      for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }

  const macros = vocab.genres.filter((g) => levelOf(g) === 'macro');
  const families = vocab.genres.filter((g) => levelOf(g) === 'family');
  const genres = vocab.genres.filter((g) => levelOf(g) === 'genre');
  const macroKeys = new Set(macros.map((m) => m.key));
  const familyKeys = new Set(families.map((f) => f.key));
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

  const node = (g: VocabGenre, level: GenreLevel, children: GenreTreeNode[]): GenreTreeNode => {
    const sets = counts.get(g.key) ?? 0;
    return { key: g.key, name: g.name, level, sets, seen: sets > 0, children };
  };
  const familyNode = (f: VocabGenre): GenreTreeNode =>
    node(
      f,
      'family',
      genres
        .filter((g) => g.primaryParent === f.key)
        .sort(byName)
        .map((g) => node(g, 'genre', [])),
    );

  const countBranches = (nodes: GenreTreeNode[]): { seen: number; total: number } => {
    let seen = 0;
    let total = 0;
    for (const n of nodes) {
      total += 1;
      if (n.seen) seen += 1;
      const sub = countBranches(n.children);
      seen += sub.seen;
      total += sub.total;
    }
    return { seen, total };
  };

  const macroRoots: GenreTreeNode[] = macros
    .sort(byName)
    .map((m) =>
      node(
        m,
        'macro',
        families
          .filter((f) => f.primaryParent === m.key)
          .sort(byName)
          .map(familyNode),
      ),
    );
  const noneChildren: GenreTreeNode[] = [
    ...families.filter((f) => !f.primaryParent || !macroKeys.has(f.primaryParent)).map(familyNode),
    ...genres
      .filter((g) => !g.primaryParent || !familyKeys.has(g.primaryParent))
      .map((g) => node(g, 'genre', [])),
  ].sort(byName);
  const noneSets = counts.get(NONE_MACRO_KEY) ?? 0;
  const roots: GenreTreeNode[] = [...macroRoots];
  if (noneChildren.length) {
    roots.push({ key: NONE_MACRO_KEY, name: NOT_GROUPED, level: 'macro', sets: noneSets, seen: noneSets > 0, children: noneChildren });
  }
  return roots.map((n) => {
    const { seen, total } = countBranches(n.children);
    return { ...n, seenBranches: seen, totalBranches: total };
  });
}

export function genreTree(
  vocab: GenreVocabulary | undefined,
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  today?: string,
): GenreTreeRoot[] {
  if (!vocab?.genres.length) return [];
  if (vocab.genres.some((g) => levelOf(g) === 'macro')) return taxonomyTree(vocab, events, byArtist, today);
  const { names, ups } = buildUmbrellaLookup(vocab);
  if (!names.size) return [];

  const went = today
    ? wentTo(events, today)
    : events.filter((e) => e.attendance !== 'planned' && e.attendance !== 'missed');

  const counts = new Map<string, number>();
  for (const e of went) {
    for (const s of e.seen) {
      const g = byArtist.get(s.key);
      if (!g?.genres.length) continue;
      const seenKeys = new Set<string>();
      for (const x of g.genres) {
        const k = genreKey(x.style);
        if (!k) continue;
        seenKeys.add(k);
        for (const u of ups(k)) seenKeys.add(u);
      }
      for (const k of seenKeys) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }

  const vocabByKey = new Map(vocab.genres.map((g) => [g.key, g]));
  const childrenOf = new Map<string, string[]>();
  for (const g of vocab.genres) {
    for (const u of g.umbrellas) {
      let list = childrenOf.get(u);
      if (!list) childrenOf.set(u, (list = []));
      list.push(g.key);
    }
  }

  const buildNode = (key: string, trail: Set<string>): GenreTreeNode => {
    const sets = counts.get(key) ?? 0;
    const childKeys = (childrenOf.get(key) ?? [])
      .filter((c) => !trail.has(c))
      .sort((a, b) => (vocabByKey.get(a)?.name ?? a).localeCompare(vocabByKey.get(b)?.name ?? b));
    const nextTrail = new Set(trail);
    nextTrail.add(key);
    return {
      key,
      name: vocabByKey.get(key)?.name ?? names.get(key) ?? key,
      sets,
      seen: sets > 0,
      children: childKeys.map((c) => buildNode(c, nextTrail)),
    };
  };

  const countBranches = (nodes: GenreTreeNode[]): { seen: number; total: number } => {
    let seen = 0;
    let total = 0;
    for (const n of nodes) {
      total += 1;
      if (n.seen) seen += 1;
      const sub = countBranches(n.children);
      seen += sub.seen;
      total += sub.total;
    }
    return { seen, total };
  };

  // Top-level umbrellas are umbrellas that do not sit under any other umbrella.
  const roots = [...names.keys()]
    .filter((u) => !(vocabByKey.get(u)?.umbrellas.length))
    .sort((a, b) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b));

  return roots.map((u) => {
    const node = buildNode(u, new Set([u]));
    const { seen, total } = countBranches(node.children);
    return {
      ...node,
      seenBranches: seen,
      totalBranches: total,
    };
  });
}
