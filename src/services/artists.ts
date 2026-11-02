import type { LoggedEvent } from '../server/events/types';
import { eventYear } from './format';
import { cityWithRegion } from '../server/events/regions';

// The Artists view: everyone you marked as seen, one entry per act, worked
// out from your log each time. Roles and favourites count only where stored.

export interface ArtistSummary {
  key: string;
  name: string; // as written on your most recent event with them
  events: LoggedEvent[]; // newest first; undated last
  sets: number; // total sets seen
  headlined: number; // events where they were stored as headliner
  supported: number; // events where they were stored as support
  favourites: number; // events where they were your favourite set
  firstYear?: number;
  lastYear?: number;
  cities: string[]; // most visited first
}

export type ArtistSort = 'most' | 'az' | 'recent' | 'first';

export const ARTIST_SORTS: Array<{ value: ArtistSort; label: string }> = [
  { value: 'most', label: 'Most seen' },
  { value: 'recent', label: 'Recently seen' },
  { value: 'first', label: 'First seen' },
  { value: 'az', label: 'A to Z' },
];

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// A sortable date: "2024-05-17", "2024-05", "2024", or '' when unknown.
const when = (e: LoggedEvent) =>
  e.startDate ?? (e.year ? (e.month ? `${e.year}-${String(e.month).padStart(2, '0')}` : String(e.year)) : '');

export function artistSummaries(events: LoggedEvent[]): ArtistSummary[] {
  const newestFirst = [...events].sort((a, b) => when(b).localeCompare(when(a)) || b.createdAt.localeCompare(a.createdAt));
  const map = new Map<
    string,
    ArtistSummary & {
      cityCounts: Map<string, { name: string; n: number }>;
      eventIds: Set<string>;
      favouriteEvents: Set<string>;
      headlinedEvents: Set<string>;
      supportedEvents: Set<string>;
    }
  >();
  for (const e of newestFirst) {
    for (const s of e.seen) {
      let a = map.get(s.key);
      if (!a) {
        a = {
          key: s.key,
          name: s.name,
          events: [],
          sets: 0,
          headlined: 0,
          supported: 0,
          favourites: 0,
          cities: [],
          cityCounts: new Map(),
          eventIds: new Set(),
          favouriteEvents: new Set(),
          headlinedEvents: new Set(),
          supportedEvents: new Set(),
        };
        map.set(s.key, a);
      }
      a.sets += 1;
      if (s.role === 'headliner' && !a.headlinedEvents.has(e.id)) {
        a.headlinedEvents.add(e.id);
        a.headlined += 1;
      }
      if (s.role === 'support' && !a.supportedEvents.has(e.id)) {
        a.supportedEvents.add(e.id);
        a.supported += 1;
      }
      if (s.favourite && !a.favouriteEvents.has(e.id)) {
        a.favouriteEvents.add(e.id);
        a.favourites += 1;
      }
      if (a.eventIds.has(e.id)) continue;
      a.eventIds.add(e.id);
      a.events.push(e);
      const y = eventYear(e);
      if (y !== null) {
        a.firstYear = a.firstYear === undefined ? y : Math.min(a.firstYear, y);
        a.lastYear = a.lastYear === undefined ? y : Math.max(a.lastYear, y);
      }
      const city = cityWithRegion(e.city, e.region);
      if (city) {
        const c = a.cityCounts.get(fold(city)) ?? { name: city, n: 0 };
        c.n += 1;
        a.cityCounts.set(fold(city), c);
      }
    }
  }
  return [...map.values()].map(({ cityCounts, eventIds, favouriteEvents, headlinedEvents, supportedEvents, ...a }) => ({
    ...a,
    cities: [...cityCounts.values()].sort((x, y) => y.n - x.n || x.name.localeCompare(y.name)).map((c) => c.name),
  }));
}

// "The Chemical Brothers" files under C.
const sortName = (name: string) => fold(name).replace(/^the\s+/, '');
const byName = (a: ArtistSummary, b: ArtistSummary) => sortName(a.name).localeCompare(sortName(b.name));
const latest = (a: ArtistSummary) => (a.events[0] ? when(a.events[0]) : '');
const earliest = (a: ArtistSummary) => a.events.map(when).filter(Boolean).sort()[0] ?? '';

// Undated artists go last in the date orders, since there is nothing to place them by.
export function sortArtists(list: ArtistSummary[], sort: ArtistSort): ArtistSummary[] {
  const out = [...list];
  if (sort === 'az') return out.sort(byName);
  if (sort === 'most') return out.sort((a, b) => b.events.length - a.events.length || byName(a, b));
  if (sort === 'recent')
    return out.sort((a, b) => (!latest(a) ? 1 : 0) - (!latest(b) ? 1 : 0) || latest(b).localeCompare(latest(a)) || byName(a, b));
  return out.sort((a, b) => (!earliest(a) ? 1 : 0) - (!earliest(b) ? 1 : 0) || earliest(a).localeCompare(earliest(b)) || byName(a, b));
}

const letter = (name: string) => {
  const c = sortName(name).charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
};
const timesLabel = (n: number) => (n === 1 ? 'Seen once' : n === 2 ? 'Seen twice' : `Seen ${n} times`);

// Sorted artists in headed groups: by letter, by how many times, or by the
// year you last (or first) saw them. Keeps the order from sortArtists.
export function groupArtists(list: ArtistSummary[], sort: ArtistSort): Array<{ label: string; artists: ArtistSummary[] }> {
  const label = (a: ArtistSummary) => {
    if (sort === 'az') return letter(a.name);
    if (sort === 'most') return timesLabel(a.events.length);
    const y = sort === 'recent' ? a.lastYear : a.firstYear;
    return y === undefined ? 'Date unknown' : String(y);
  };
  const groups: Array<{ label: string; artists: ArtistSummary[] }> = [];
  for (const a of sortArtists(list, sort)) {
    const l = label(a);
    const g = groups[groups.length - 1];
    if (g?.label === l) g.artists.push(a);
    else groups.push({ label: l, artists: [a] });
  }
  return groups;
}

export interface JumpTarget {
  label: string; // shown in the jump bar: a letter, a year, or "?" for no date
  group?: string; // the group it scrolls to; none when that letter has nobody
}

// The quick-jump bar over the groups: every letter (greyed when empty) for A
// to Z, the years you have for the date orders, nothing for Most seen.
export function jumpTargets(groups: Array<{ label: string }>, sort: ArtistSort): JumpTarget[] {
  const have = new Set(groups.map((g) => g.label));
  if (sort === 'az') return ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => ({ label: l, group: have.has(l) ? l : undefined }));
  if (sort === 'most') return [];
  return groups.map((g) => ({ label: g.label === 'Date unknown' ? '?' : g.label, group: g.label }));
}
