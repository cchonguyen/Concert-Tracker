import type { LoggedEvent } from '../server/events/types';
import { attendanceOf, wentTo } from '../server/events/attendance';
import type { ArtistGenres, GenreLevel, GenreShare, GenreVocabulary, VocabGenre } from '../server/events/genreTypes';
import type { LineupGenresAct } from './lineupApi';
import {
  genreKey,
  genreResolver,
  genresUnder,
  levelOf,
  NOT_GROUPED,
  shareFamily,
  shareGroup,
  umbrellaClosure,
} from '../server/events/genreVocabulary';
import { eventScale, type LineupFacts } from '../server/events/scale';
import { formatSets, genreMix, setShares, umbrellaNames } from './genres';

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
    for (const [si, s] of e.seen.entries()) {
      const share = setShares(e)[si]; // a B2B act counts its share of the set (genres.ts setShares)
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
      // An umbrella gets at most the act's share of the set; any other genre gets w of its share.
      w = target.kind === 'umbrella' ? Math.min(share, w * share) : w * share;
      if (w <= 0) continue;

      const cur = rows.get(s.key);
      if (!cur) {
        rows.set(s.key, {
          key: s.key,
          name: s.name,
          weightedSets: w,
          sets: share,
          lastSeen: displayDate,
          lastSeenSort: sortDate,
        });
      } else {
        cur.weightedSets += w;
        cur.sets += share;
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
    for (const [si, s] of e.seen.entries()) {
      const share = setShares(e)[si]; // genres.ts setShares
      const g = byArtist.get(s.key);
      if (!g?.genres.length) continue;
      knownSets += share;

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
          add(k, info.name, 'style', info.weight * share, e.id);
        }
        for (const u of ups(k)) {
          umbrellaWeight.set(u, (umbrellaWeight.get(u) ?? 0) + info.weight * share);
        }
      }
      for (const [u, w] of umbrellaWeight) {
        add(u, names.get(u) ?? u, 'umbrella', Math.min(share, w), e.id);
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
    for (const [si, s] of e.seen.entries()) {
      const share = setShares(e)[si]; // genres.ts setShares
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
            sets: share,
            lastSortDate: sortDate,
            lastDate: displayDate,
            lastEvent: e.name,
            lastEventId: e.id,
            lastAct: s.name,
          });
        } else {
          cur.sets += share;
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
    const shares = setShares(e);
    e.seen.forEach((s, si) => {
      if (byArtist.get(s.key)?.genres.length) knownSets += shares[si];
    });
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
    const shares = setShares(e);
    e.seen.forEach((s, si) => {
      const share = shares[si];
      const g = byArtist.get(s.key);
      if (!g?.genres.length) return;
      knownSets += share;
      const seenGroups = new Set<string>();
      for (const x of g.genres) {
        const group = shareGroup(x);
        if (seenGroups.has(group)) continue;
        seenGroups.add(group);
        const prev = counts.get(group) ?? 0;
        const next = prev + share;
        counts.set(group, next);
        if (sortDate && !firstDateByGroup.has(group)) firstDateByGroup.set(group, sortDate);
        if (inRecent) hasRecentByGroup.add(group);
        // A mark is reached when the running total crosses it (fractions from B2B sets included).
        if (sortDate) {
          for (const mark of MILESTONE_MARKS) {
            if (prev < mark && mark <= next) {
              allReached.push({
                group,
                mark,
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
    });
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
    const shares = setShares(e);
    e.seen.forEach((s, si) => {
      const share = shares[si]; // genres.ts setShares
      if (!s.favourite) return;
      const g = byArtist.get(s.key);
      if (!g?.genres.length) return;
      favTotal += share;
      const seenKeys = new Set<string>();
      for (const x of g.genres) {
        const k = genreKey(x.style);
        if (!k || seenKeys.has(k)) continue;
        seenKeys.add(k);
        const cur = favCounts.get(k);
        if (cur) cur.count += share;
        else favCounts.set(k, { name: x.style, count: share });
      }
    });
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
    for (const [si, s] of e.seen.entries()) {
      const share = setShares(e)[si]; // genres.ts setShares
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
      for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + share);
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
    for (const [si, s] of e.seen.entries()) {
      const share = setShares(e)[si]; // genres.ts setShares
      const g = byArtist.get(s.key);
      if (!g?.genres.length) continue;
      const seenKeys = new Set<string>();
      for (const x of g.genres) {
        const k = genreKey(x.style);
        if (!k) continue;
        seenKeys.add(k);
        for (const u of ups(k)) seenKeys.add(u);
      }
      for (const k of seenKeys) counts.set(k, (counts.get(k) ?? 0) + share);
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

// Multi-zoom genre breakdown (docs/specs/genre-taxonomy-release-1.md decisions 1-6 and section 2).
// Macro, then family, then genre, each level summing to `known`. Weighting is the same as
// genreMix: a set's share times the genre's weight. Sets with no genre are `unknown`.
export const ZOOM_MIN_SETS = 10;

export interface ZoomRow {
  key: string;
  name: string;
  sets: number;
  share: number; // sets / known
  parentKey?: string;
  children?: ZoomRow[];
}

export interface GenreZoomResult {
  levels: 'taxonomy' | 'groups';
  macros: ZoomRow[]; // taxonomy: macros with families as children; groups: music-story groups
  families: ZoomRow[]; // taxonomy only: families with genres as children
  genres: ZoomRow[]; // taxonomy only: genres with parentKey = family key
  known: number;
  unknown: number;
  enough: boolean; // known >= ZOOM_MIN_SETS
}

const NOT_GROUPED_KEY = 'not-grouped';

function zoomKey(prefix: 'macro' | 'family', name: string): string {
  return name === NOT_GROUPED ? `${prefix}:${NOT_GROUPED_KEY}` : `${prefix}:${genreKey(name)}`;
}

function byZoomSort(a: { sets: number; name: string }, b: { sets: number; name: string }): number {
  return b.sets - a.sets || a.name.localeCompare(b.name);
}

export function genreZoom(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  vocab?: GenreVocabulary,
): GenreZoomResult {
  const live = events.filter((e) => e.attendance !== 'planned' && e.attendance !== 'missed');
  const vocabHasMacro = (vocab?.genres ?? []).some((g) => levelOf(g) === 'macro');

  interface Contribution {
    w: number;
    style: string;
    group: string;
    macro?: string;
    family?: string;
  }
  const contributions: Contribution[] = [];
  let known = 0;
  let unknown = 0;

  for (const e of live) {
    const shares = setShares(e);
    e.seen.forEach((s, si) => {
      const share = shares[si];
      const genres = (byArtist.get(s.key)?.genres ?? []).filter((x) => genreKey(x.style));
      if (!genres.length) {
        unknown += share;
        return;
      }
      known += share;
      for (const x of genres) {
        contributions.push({
          w: x.weight * share,
          style: x.style,
          group: shareGroup(x),
          macro: x.macro,
          family: x.family,
        });
      }
    });
  }

  const taxonomy = vocabHasMacro || contributions.some((c) => c.macro !== undefined);
  const share = (sets: number): number => (known ? sets / known : 0);
  type Acc = { key: string; name: string; sets: number; parentKey?: string };
  const bump = (m: Map<string, Acc>, key: string, name: string, add: number, parentKey?: string) => {
    const cur = m.get(key);
    if (cur) cur.sets += add;
    else m.set(key, { key, name, sets: add, parentKey });
  };
  const toRow = (a: Acc): ZoomRow => {
    const row: ZoomRow = { key: a.key, name: a.name, sets: a.sets, share: share(a.sets) };
    if (a.parentKey !== undefined) row.parentKey = a.parentKey;
    return row;
  };

  if (!taxonomy) {
    const groups = new Map<string, Acc>();
    for (const c of contributions) bump(groups, zoomKey('macro', c.group), c.group, c.w);
    const macros = [...groups.values()].map(toRow).sort(byZoomSort);
    return { levels: 'groups', macros, families: [], genres: [], known, unknown, enough: known >= ZOOM_MIN_SETS };
  }

  const macroAcc = new Map<string, Acc>();
  const familyAcc = new Map<string, Acc>();
  const genreAcc = new Map<string, Acc>();
  for (const c of contributions) {
    const familyName = c.family ?? NOT_GROUPED;
    // A genre with no family is under "Not grouped" at both levels.
    const macroName = familyName === NOT_GROUPED ? NOT_GROUPED : (c.macro ?? NOT_GROUPED);
    const macroKey = zoomKey('macro', macroName);
    const familyKey = zoomKey('family', familyName);
    bump(macroAcc, macroKey, macroName, c.w);
    bump(familyAcc, familyKey, familyName, c.w, macroKey);
    bump(genreAcc, genreKey(c.style), c.style, c.w, familyKey);
  }

  const genres = [...genreAcc.values()].map(toRow).sort(byZoomSort);
  const families = [...familyAcc.values()].map((a) => {
    const row = toRow(a);
    row.children = genres.filter((g) => g.parentKey === a.key);
    return row;
  }).sort(byZoomSort);
  const macros = [...macroAcc.values()].map((a) => {
    const row = toRow(a);
    row.children = families.filter((f) => f.parentKey === a.key);
    return row;
  }).sort(byZoomSort);

  return { levels: 'taxonomy', macros, families, genres, known, unknown, enough: known >= ZOOM_MIN_SETS };
}

// Lineup DNA (docs/specs/genre-taxonomy-release-2.md section 2 and decisions 1, 2, 5).
// Every act on the bill counts 1.0, split across its genres by weight. Acts sharing a slotId
// (a B2B) share one set: 1/n each. Bars: the whole bill, one per stage, then "No stage listed".
export const LINEUP_DNA_MIN_ACTS = 3;
export const LINEUP_DNA_MIN_COVERAGE = 0.6;
const DNA_TOP_FAMILIES = 4;
const DNA_FIFTH_MIN_SHARE = 0.10;
const DNA_TOP_GENRES = 5;

export interface DnaGenre {
  name: string;
  share: number; // of the bar's tagged weight
}

export interface DnaSegment {
  key: string; // family key ('family:...'), group key ('group:...') in fallback mode, or 'other'
  name: string;
  share: number; // of the bar's tagged weight
  genres: DnaGenre[]; // top 5 by share
  acts: string[]; // act keys contributing, by contribution desc
}

export interface DnaBar {
  id: string; // 'all', 'stage:<name>' or 'no-stage'
  name: string;
  segments: DnaSegment[]; // shares add up to 1 when tagged > 0
  tagged: number; // acts on the bar with at least one genre
  total: number; // acts on the bar
  coverage: number; // tagged / total, 0 when total is 0
  lowCoverage: boolean; // coverage under LINEUP_DNA_MIN_COVERAGE
  enough: boolean; // tagged >= LINEUP_DNA_MIN_ACTS
}

export interface LineupDnaResult {
  levels: 'taxonomy' | 'groups';
  bars: DnaBar[];
}

interface DnaPlanAct {
  key: string;
  stages: string[];
  genres: Array<{ name: string; family: string; w: number }>; // w: the act's share of the bill in this genre
}

interface DnaAcc {
  key: string;
  name: string;
  weight: number;
  genres: Map<string, { name: string; weight: number }>; // by genreKey
  acts: Map<string, number>; // by act key
}

function dnaKey(prefix: 'family' | 'group', name: string): string {
  return name === NOT_GROUPED ? `${prefix}:${NOT_GROUPED_KEY}` : `${prefix}:${genreKey(name)}`;
}

export function lineupDna(
  acts: LineupGenresAct[],
  byArtist: Map<string, ArtistGenres>,
  vocab: GenreVocabulary | undefined,
): LineupDnaResult {
  const listed = acts.filter((a) => a.status === undefined || a.status === 'billed' || a.status === 'performed');
  const slotSize = new Map<string, number>();
  for (const a of listed) if (a.slotId) slotSize.set(a.slotId, (slotSize.get(a.slotId) ?? 0) + 1);

  const usable = listed.map((act) => ({
    act,
    genres: (byArtist.get(act.key)?.genres ?? []).filter((x) => genreKey(x.style) && x.weight > 0),
  }));
  // Same test as genreZoom: a taxonomy when the vocabulary has a macro or a shown genre carries one.
  const taxonomy = (vocab?.genres ?? []).some((g) => levelOf(g) === 'macro')
    || usable.some((u) => u.genres.some((x) => x.macro !== undefined));
  const prefix = taxonomy ? 'family' : 'group';

  const plans: DnaPlanAct[] = usable.map(({ act, genres }) => {
    const base = act.slotId ? 1 / (slotSize.get(act.slotId) ?? 1) : 1;
    const sum = genres.reduce((t, x) => t + x.weight, 0);
    return {
      key: act.key,
      stages: [...new Set(act.stages.map((s) => s.trim()).filter(Boolean))],
      genres: genres.map((x) => ({ name: x.style, family: driftBandOf(x, 'family', taxonomy), w: base * x.weight / sum })),
    };
  });

  const bar = (id: string, name: string, members: DnaPlanAct[]): DnaBar => {
    const fams = new Map<string, DnaAcc>();
    let taggedWeight = 0;
    let tagged = 0;
    for (const m of members) {
      if (!m.genres.length) continue;
      tagged += 1;
      for (const g of m.genres) {
        taggedWeight += g.w;
        const famKey = dnaKey(prefix, g.family);
        let f = fams.get(famKey);
        if (!f) {
          f = { key: famKey, name: g.family, weight: 0, genres: new Map(), acts: new Map() };
          fams.set(famKey, f);
        }
        f.weight += g.w;
        const gk = genreKey(g.name);
        const gg = f.genres.get(gk);
        if (gg) gg.weight += g.w;
        else f.genres.set(gk, { name: g.name, weight: g.w });
        f.acts.set(m.key, (f.acts.get(m.key) ?? 0) + g.w);
      }
    }

    const share = (w: number): number => (taggedWeight ? w / taggedWeight : 0);
    const segment = (s: DnaAcc): DnaSegment => ({
      key: s.key,
      name: s.name,
      share: share(s.weight),
      genres: [...s.genres.values()]
        .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
        .slice(0, DNA_TOP_GENRES)
        .map((g) => ({ name: g.name, share: share(g.weight) })),
      acts: [...s.acts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k),
    });

    const ranked = [...fams.values()].sort(
      (a, b) => b.weight - a.weight || a.name.localeCompare(b.name) || a.key.localeCompare(b.key),
    );
    const shown = ranked.slice(0, DNA_TOP_FAMILIES);
    const fifth = ranked[DNA_TOP_FAMILIES];
    if (fifth && share(fifth.weight) >= DNA_FIFTH_MIN_SHARE) shown.push(fifth);
    const tail = ranked.slice(shown.length);
    const segments = shown.map(segment);
    if (tail.length) {
      const other: DnaAcc = { key: 'other', name: 'Other', weight: 0, genres: new Map(), acts: new Map() };
      for (const t of tail) {
        other.weight += t.weight;
        for (const [gk, g] of t.genres) {
          const cur = other.genres.get(gk);
          if (cur) cur.weight += g.weight;
          else other.genres.set(gk, { name: g.name, weight: g.weight });
        }
        for (const [ak, w] of t.acts) other.acts.set(ak, (other.acts.get(ak) ?? 0) + w);
      }
      segments.push(segment(other));
    }

    const total = members.length;
    const coverage = total ? tagged / total : 0;
    return {
      id,
      name,
      segments,
      tagged,
      total,
      coverage,
      lowCoverage: coverage < LINEUP_DNA_MIN_COVERAGE,
      enough: tagged >= LINEUP_DNA_MIN_ACTS,
    };
  };

  const bars: DnaBar[] = [bar('all', 'Whole bill', plans)];
  const stageNames = [...new Set(plans.flatMap((p) => p.stages))].sort((a, b) => a.localeCompare(b));
  if (stageNames.length) {
    for (const s of stageNames) bars.push(bar(`stage:${s}`, s, plans.filter((p) => p.stages.includes(s))));
    const noStage = plans.filter((p) => !p.stages.length);
    if (noStage.length) bars.push(bar('no-stage', 'No stage listed', noStage));
  }
  return { levels: taxonomy ? 'taxonomy' : 'groups', bars };
}

// Event Match (docs/specs/genre-taxonomy-release-2.md section 4 and decisions 3, 4, 7).
// How well one event's bill fits your own taste. Your vector is your other events' seen sets,
// smoothed one step over the owner's adjacent genre links, rolled up to families and compared
// with the bill's whole-bar family vector by cosine. Relations never change Lineup DNA.
export const MATCH_ALPHA = 0.5;
export const MATCH_STRONG = 0.6;
export const MATCH_SOME = 0.3;
export const MATCH_MIN_SETS = 20;
export const MATCH_MIN_EVENTS = 5;
const MATCH_LANE_MAX = 2;

export type MatchBand = 'strong' | 'some' | 'outside';

export interface MatchLaneFamily {
  key: string; // family key, as lineupDna names them
  name: string;
}

export interface EventMatchResult {
  sets: number; // your sets with a genre at other events (this event left out)
  events: number; // those other events that contribute at least one such set
  score: number; // cosine of your smoothed family vector and the bill's, 0 to 1
  band: MatchBand;
  lane: MatchLaneFamily[]; // up to 2 families adding most to the score; empty when outside
  inLane: string[]; // bill act keys whose top genre is one of your genres
  nearby: string[]; // bill act keys whose top genre is adjacent to one of your genres
  nearbyUnseen: string[]; // the nearby ones you never marked as seen at any event
  enough: boolean; // sets and events over the floor, and Lineup DNA's whole-bill floor
}

// Adjacent links read in both directions. Where both exist, the larger weight wins.
function adjacencyOf(vocab: GenreVocabulary | undefined): Map<string, Map<string, number>> {
  const adj = new Map<string, Map<string, number>>();
  const link = (a: string, b: string, w: number): void => {
    if (a === b || !(w > 0)) return;
    let row = adj.get(a);
    if (!row) adj.set(a, (row = new Map()));
    if ((row.get(b) ?? 0) < w) row.set(b, w);
  };
  for (const g of vocab?.genres ?? []) {
    for (const r of g.relations ?? []) {
      if (r.type !== 'adjacent') continue;
      link(g.key, r.target, r.weight);
      link(r.target, g.key, r.weight);
    }
  }
  return adj;
}

export function eventMatch(
  eventId: string,
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  acts: LineupGenresAct[],
  vocab: GenreVocabulary | undefined,
): EventMatchResult {
  const usableGenres = (row: ArtistGenres | undefined): GenreShare[] =>
    (row?.genres ?? []).filter((x) => genreKey(x.style) && x.weight > 0);

  // The bill, as lineupDna reads it: billed and performed acts only.
  const listed = acts.filter((a) => a.status === undefined || a.status === 'billed' || a.status === 'performed');
  const slotSize = new Map<string, number>();
  for (const a of listed) if (a.slotId) slotSize.set(a.slotId, (slotSize.get(a.slotId) ?? 0) + 1);
  const billActs = listed.map((act) => ({ act, genres: usableGenres(byArtist.get(act.key)) }));
  const taxonomy = (vocab?.genres ?? []).some((g) => levelOf(g) === 'macro')
    || billActs.some((b) => b.genres.some((x) => x.macro !== undefined));
  const prefix = taxonomy ? 'family' : 'group';

  const byKey = new Map<string, VocabGenre>();
  for (const g of vocab?.genres ?? []) byKey.set(g.key, g);
  // Family (or group) of each genre key as the shares show it; vocabulary for genres with no share.
  const shownFamily = new Map<string, string>();
  for (const row of byArtist.values()) {
    for (const x of usableGenres(row)) {
      const k = genreKey(x.style);
      if (!shownFamily.has(k)) shownFamily.set(k, driftBandOf(x, 'family', taxonomy));
    }
  }
  const familyOf = (key: string): string => {
    const shown = shownFamily.get(key);
    if (shown !== undefined) return shown;
    const g = byKey.get(key);
    if (!taxonomy) return g?.parent || NOT_GROUPED;
    const fam = g?.primaryParent ? byKey.get(g.primaryParent) : undefined;
    return fam?.name ?? NOT_GROUPED;
  };

  // Your vector by genre key. Every seen act at every other event, split by genre weight.
  const u = new Map<string, number>();
  let sets = 0;
  const contributing = new Set<string>();
  for (const e of events) {
    if (e.id === eventId || e.attendance === 'planned' || e.attendance === 'missed') continue;
    const shares = setShares(e);
    e.seen.forEach((s, si) => {
      const genres = usableGenres(byArtist.get(s.key));
      if (!genres.length) return;
      const share = shares[si];
      const total = genres.reduce((t, x) => t + x.weight, 0);
      sets += share;
      contributing.add(e.id);
      for (const x of genres) {
        const k = genreKey(x.style);
        u.set(k, (u.get(k) ?? 0) + share * x.weight / total);
      }
    });
  }
  // Every act you ever marked as seen, this event included (for nearbyUnseen).
  const seenAll = new Set<string>();
  for (const e of events) for (const s of e.seen) seenAll.add(s.key);

  // One smoothing step: v' = v + alpha * (A-hat v), A-hat = A / sqrt(deg(s) deg(t)).
  const adj = adjacencyOf(vocab);
  const deg = new Map<string, number>();
  for (const [k, row] of adj) deg.set(k, [...row.values()].reduce((t, w) => t + w, 0));
  const smoothed = new Map<string, number>(u);
  for (const [t, row] of adj) {
    for (const [s, w] of row) {
      const us = u.get(s);
      if (!us) continue;
      smoothed.set(t, (smoothed.get(t) ?? 0) + MATCH_ALPHA * w / Math.sqrt((deg.get(t) ?? 0) * (deg.get(s) ?? 0)) * us);
    }
  }

  // Roll your smoothed vector up to families.
  const you = new Map<string, { name: string; w: number }>();
  for (const [k, w] of smoothed) {
    if (!(w > 0)) continue;
    const name = familyOf(k);
    const key = dnaKey(prefix, name);
    const cur = you.get(key);
    if (cur) cur.w += w;
    else you.set(key, { name, w });
  }

  // The bill's whole-bar family vector, as lineupDna splits it (not smoothed).
  const bill = new Map<string, { name: string; w: number }>();
  for (const { act, genres } of billActs) {
    if (!genres.length) continue;
    const base = act.slotId ? 1 / (slotSize.get(act.slotId) ?? 1) : 1;
    const sum = genres.reduce((t, x) => t + x.weight, 0);
    for (const x of genres) {
      const name = driftBandOf(x, 'family', taxonomy);
      const key = dnaKey(prefix, name);
      const cur = bill.get(key);
      const w = base * x.weight / sum;
      if (cur) cur.w += w;
      else bill.set(key, { name, w });
    }
  }

  let dot = 0;
  let youSq = 0;
  let billSq = 0;
  const contributions: Array<{ key: string; name: string; c: number }> = [];
  for (const [key, { name, w }] of you) {
    youSq += w * w;
    const b = bill.get(key)?.w ?? 0;
    dot += w * b;
    if (b > 0) contributions.push({ key, name, c: w * b });
  }
  for (const { w } of bill.values()) billSq += w * w;
  const score = youSq > 0 && billSq > 0 ? dot / Math.sqrt(youSq * billSq) : 0;
  const band: MatchBand = score >= MATCH_STRONG ? 'strong' : score >= MATCH_SOME ? 'some' : 'outside';
  const lane: MatchLaneFamily[] = band === 'outside'
    ? []
    : contributions
      .sort((a, b) => b.c - a.c || a.name.localeCompare(b.name))
      .slice(0, MATCH_LANE_MAX)
      .map(({ key, name }) => ({ key, name }));

  // Acts whose top genre (largest weight) is yours, or reaches yours through an adjacent link.
  const inLane: string[] = [];
  const nearby: string[] = [];
  const nearbyUnseen: string[] = [];
  for (const { act, genres } of billActs) {
    if (!genres.length) continue;
    const top = [...genres].sort((a, b) => b.weight - a.weight || genreKey(a.style).localeCompare(genreKey(b.style)))[0];
    const topKey = genreKey(top.style);
    if ((u.get(topKey) ?? 0) > 0) {
      inLane.push(act.key);
      continue;
    }
    const near = adj.get(topKey);
    if (near && [...near.keys()].some((s) => (u.get(s) ?? 0) > 0)) {
      nearby.push(act.key);
      if (!seenAll.has(act.key)) nearbyUnseen.push(act.key);
    }
  }

  const dna = lineupDna(acts, byArtist, vocab).bars[0];
  const enough = sets >= MATCH_MIN_SETS && contributing.size >= MATCH_MIN_EVENTS && dna.enough;
  return { sets, events: contributing.size, score, band, lane, inLane, nearby, nearbyUnseen, enough };
}

// Sound Drift (docs/specs/genre-taxonomy-release-1.md decisions 1-5, 7 and section 4).
// Works by calendar year. A year is counted when it has at least DRIFT_MIN_SETS known sets.
export const DRIFT_MIN_SETS = 10;
export const DRIFT_MIN_YEARS = 3;
export const DRIFT_BANDS = 6;
const OTHER_BAND = 'Other';

export interface SoundDriftYear {
  year: number;
  known: number;
  counted: boolean;
  shares: Record<string, number>; // per band (plus Other when any); adds up to 1
}

export interface SoundDriftLeader {
  band: string;
  from: number;
  to: number;
}

export interface SoundDriftResult {
  levels: 'taxonomy' | 'groups';
  years: SoundDriftYear[];
  bands: string[];
  countedYears: number;
  enough: boolean;
  leaders: SoundDriftLeader[];
}

export interface DriftSetRow {
  eventId: string;
  eventName: string;
  date: string;
  act: string;
  share: number;
}

export interface DriftArtistRow {
  key: string;
  name: string;
  sets: number;
}

export interface DriftDriversResult {
  sets: DriftSetRow[];
  artists: DriftArtistRow[];
}

// Taxonomy levels apply when the vocabulary has a macro, or the shares read through it do.
function driftTaxonomy(byArtist: Map<string, ArtistGenres>, vocab: GenreVocabulary | undefined): boolean {
  if ((vocab?.genres ?? []).some((g) => levelOf(g) === 'macro')) return true;
  for (const a of byArtist.values()) if (a.genres.some((x) => x.macro !== undefined)) return true;
  return false;
}

// A genre with no family counts under Not grouped at the family and the macro level.
function driftBandOf(x: GenreShare, level: 'family' | 'macro', taxonomy: boolean): string {
  if (!taxonomy) return shareGroup(x);
  const fam = shareFamily(x);
  const familyName = fam && fam !== NOT_GROUPED ? fam : NOT_GROUPED;
  if (level === 'family') return familyName;
  if (familyName === NOT_GROUPED) return NOT_GROUPED;
  return x.macro ?? NOT_GROUPED;
}

function driftGenres(byArtist: Map<string, ArtistGenres>, actKey: string): GenreShare[] {
  return (byArtist.get(actKey)?.genres ?? []).filter((x) => genreKey(x.style));
}

interface DriftRawYear {
  year: number;
  known: number;
  weights: Map<string, number>; // band -> summed weight x set share
}

function driftRawYears(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  taxonomy: boolean,
  level: 'family' | 'macro',
  today: string,
): DriftRawYear[] {
  const byYr = new Map<number, DriftRawYear>();
  for (const e of wentTo(events, today)) {
    const y = eventYearValue(e);
    if (!y) continue;
    const shares = setShares(e);
    e.seen.forEach((s, si) => {
      const genres = driftGenres(byArtist, s.key);
      if (!genres.length) return;
      const share = shares[si];
      let cur = byYr.get(y);
      if (!cur) byYr.set(y, (cur = { year: y, known: 0, weights: new Map() }));
      cur.known += share;
      for (const x of genres) {
        const b = driftBandOf(x, level, taxonomy);
        cur.weights.set(b, (cur.weights.get(b) ?? 0) + x.weight * share);
      }
    });
  }
  return [...byYr.values()].sort((a, b) => a.year - b.year);
}

export function soundDrift(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  vocab: GenreVocabulary | undefined,
  level: 'family' | 'macro',
  today: string,
): SoundDriftResult {
  const taxonomy = driftTaxonomy(byArtist, vocab);
  const raw = driftRawYears(events, byArtist, taxonomy, level, today);

  // Bands are ranked on counted years; with none counted, on all years.
  const counted = raw.filter((y) => y.known >= DRIFT_MIN_SETS);
  const rankFrom = counted.length ? counted : raw;
  const sums = new Map<string, number>();
  for (const y of rankFrom) for (const [b, w] of y.weights) sums.set(b, (sums.get(b) ?? 0) + w);
  const ranked = [...sums]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, DRIFT_BANDS)
    .map(([b]) => b);
  const bandSet = new Set(ranked);

  const otherOf = (y: DriftRawYear): number => {
    let o = 0;
    for (const [b, w] of y.weights) if (!bandSet.has(b)) o += w;
    return o;
  };
  const hasOther = raw.some((y) => otherOf(y) > 0);
  const bands = hasOther ? [...ranked, OTHER_BAND] : ranked;

  const years: SoundDriftYear[] = raw.map((y) => {
    const total = [...y.weights.values()].reduce((t, w) => t + w, 0) || 1;
    const shares: Record<string, number> = {};
    for (const b of ranked) shares[b] = (y.weights.get(b) ?? 0) / total;
    if (hasOther) shares[OTHER_BAND] = otherOf(y) / total;
    return { year: y.year, known: y.known, counted: y.known >= DRIFT_MIN_SETS, shares };
  });

  // The leader of each counted year: the largest named band, Not grouped only when nothing else.
  const leaders: SoundDriftLeader[] = [];
  for (const y of years) {
    if (!y.counted) continue;
    const cands = ranked.filter((b) => (y.shares[b] ?? 0) > 0);
    const named = cands.filter((b) => b !== NOT_GROUPED);
    const pool = named.length ? named : cands;
    if (!pool.length) continue;
    const band = [...pool].sort((a, b) => y.shares[b] - y.shares[a] || a.localeCompare(b))[0];
    const last = leaders[leaders.length - 1];
    if (last && last.band === band) last.to = y.year;
    else leaders.push({ band, from: y.year, to: y.year });
  }

  const countedYears = years.filter((y) => y.counted).length;
  return {
    levels: taxonomy ? 'taxonomy' : 'groups',
    years,
    bands,
    countedYears,
    enough: countedYears >= DRIFT_MIN_YEARS,
    leaders,
  };
}

export function driftDrivers(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  vocab: GenreVocabulary | undefined,
  level: 'family' | 'macro',
  today: string,
  year: number,
  band: string,
): DriftDriversResult {
  const taxonomy = driftTaxonomy(byArtist, vocab);
  const bandSet = new Set(soundDrift(events, byArtist, vocab, level, today).bands);
  const inBand = (b: string): boolean => (band === OTHER_BAND ? !bandSet.has(b) : b === band);

  const rows: Array<{ sort: string; row: DriftSetRow }> = [];
  const artists = new Map<string, DriftArtistRow>();
  for (const e of wentTo(events, today)) {
    if (eventYearValue(e) !== year) continue;
    const shares = setShares(e);
    e.seen.forEach((s, si) => {
      let w = 0;
      for (const x of driftGenres(byArtist, s.key)) if (inBand(driftBandOf(x, level, taxonomy))) w += x.weight;
      if (w <= 0) return;
      const share = shares[si] * w;
      rows.push({
        sort: eventSortDate(e) ?? '',
        row: { eventId: e.id, eventName: e.name, date: eventDisplayDate(e) ?? '', act: s.name, share },
      });
      const cur = artists.get(s.key);
      if (cur) cur.sets += share;
      else artists.set(s.key, { key: s.key, name: s.name, sets: share });
    });
  }

  return {
    sets: rows
      .sort((a, b) => a.sort.localeCompare(b.sort) || a.row.act.localeCompare(b.row.act))
      .map((r) => r.row),
    artists: [...artists.values()].sort((a, b) => b.sets - a.sets || a.name.localeCompare(b.name)),
  };
}
