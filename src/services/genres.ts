import type { LoggedEvent } from '../server/events/types';
import type { ArtistGenres, GenreMapEntry, GenreShare, GenreVocabulary } from '../server/events/genreTypes';
import { findPerformanceGroups } from '../server/events/seen';
import { normalizeName } from '../server/lineup/normalizeName';
import {
  genreKey,
  genreResolver,
  NOT_GROUPED,
  resolveShares,
  shareFamily,
  shareGroup,
  umbrellaClosure,
} from '../server/events/genreVocabulary';
import type { GenreResolver } from '../server/events/genreVocabulary';

export type { ArtistGenres, GenreShare };

// The genres to show for each act (docs/specs/canonical-genres.md section 4).
// Step 1, the shared base: the owner's (an empty list means none), legacy
// 'you' rows (read as the owner's until 0059 moves them), music-story with
// genres, MusicBrainz with genres, then music-story and MusicBrainz checked
// with none. An act checked with no genre found keeps its empty row, so the
// app can tell "none found" from "not looked up".
// Step 2: a member's 'added' styles not already in the base go after it.
// Every style is resolved first (docs/archive/genre-vocabulary.md section 3): spellings
// with the same genreKey are one genre, shown in one spelling, with their weights
// added inside one act, and a genre with no group is "Not grouped".
const BASE_RANK: Partial<Record<string, number>> = { owner: 0, you: 1 };
const baseRank = (r: ArtistGenres): number =>
  BASE_RANK[r.source] ?? 2 + (r.genres.length ? 0 : 2) + (r.source === 'music-story' ? 0 : 1);
function withAdditions(base: ArtistGenres | undefined, added: ArtistGenres, resolver: GenreResolver): ArtistGenres | undefined {
  const key = (style: string) => resolver.resolve(style).key;
  const have = new Set((base?.genres ?? []).map((g) => key(g.style)));
  const extra: GenreShare[] = [];
  for (const g of added.genres) {
    const k = key(g.style);
    if (!k || have.has(k)) continue;
    have.add(k);
    extra.push(g);
  }
  if (!extra.length) return base;
  const n = base?.genres.length ?? 0;
  const m = extra.length;
  const genres = [
    ...(base?.genres ?? []).map((g) => ({ ...g, weight: (g.weight * n) / (n + m) })),
    ...extra.map((g) => ({ ...g, weight: 1 / (n + m) })),
  ];
  const added_ = extra.map((g) => g.style);
  if (!n) return { ...added, genres, added: added_ }; // no base genres: the additions alone
  return { ...base!, genres, added: added_ };
}

// Without the genre map, its groups and spellings are read from the music-story and
// MusicBrainz rows, whose parents and styles are the map's own. An empty map is
// read the same as none.
function mapFromRows(rows: ArtistGenres[]): GenreMapEntry[] {
  const out: GenreMapEntry[] = [];
  for (const r of rows) {
    if (r.source !== 'music-story' && r.source !== 'musicbrainz') continue;
    for (const g of r.genres) out.push({ tag: '', style: g.style, parent: g.parent });
  }
  return out;
}

// One row with its styles resolved: same genre merged with weights added, largest first.
function resolvedRow(r: ArtistGenres, resolver: GenreResolver): ArtistGenres {
  const genres = resolveShares(r.genres, resolver)
    .map((g, i) => ({ g, i }))
    .sort((a, b) => b.g.weight - a.g.weight || a.i - b.i)
    .map(({ g }) => g);
  return { ...r, genres };
}

export function genresByArtist(
  rows: ArtistGenres[],
  vocab?: GenreVocabulary,
  map?: GenreMapEntry[],
): Map<string, ArtistGenres> {
  const resolver = genreResolver(vocab, map?.length ? map : mapFromRows(rows), rows);
  const out = new Map<string, ArtistGenres>();
  const added = new Map<string, ArtistGenres>();
  for (const raw of rows) {
    const r = resolvedRow(raw, resolver);
    if (r.source === 'added') {
      added.set(r.key, r);
      continue;
    }
    const had = out.get(r.key);
    if (!had || baseRank(r) < baseRank(had)) out.set(r.key, r);
  }
  for (const [key, a] of added) {
    const g = withAdditions(out.get(key), a, resolver);
    if (g) out.set(key, g);
  }
  return out;
}

// Seen acts with no genre from music-story, none from the owner (or legacy
// 'you') and no MusicBrainz check yet. A member's additions are not a check.
export function missingGenreKeys(events: LoggedEvent[], rows: ArtistGenres[]): string[] {
  const done = new Set(
    rows.filter((r) => r.source !== 'added' && (r.source !== 'music-story' || r.genres.length)).map((r) => r.key),
  );
  const keys = new Set<string>();
  for (const e of events) for (const s of e.seen) if (!done.has(s.key)) keys.add(s.key);
  return [...keys];
}

// The styles worth naming for one act: its largest shares, up to `max`.
export const topStyles = (g: ArtistGenres | undefined, max = 3): string[] =>
  (g?.genres ?? []).slice(0, max).map((x) => x.style);

// Each seen act's set count at this event. Every act in a B2B counts as 1
// viewing (plus 1 when `solo` is set for an act that also played on its own).
// Returns one whole-number count per entry of event.seen, in the same order.
export function setShares(event: Pick<LoggedEvent, 'seen'>): number[] {
  const present = new Set(event.seen.map((s) => s.key));
  return event.seen.map((s) => {
    const partners = new Set((s.b2b ?? []).filter((k) => k !== s.key && present.has(k)));
    if (!partners.size) return 1;
    return 1 + (s.solo ? 1 : 0);
  });
}

export interface CountedSet {
  key: string;
  name: string;
  sets: number; // always a whole number: 1, or 2 for legacy b2b+solo without a combo genre
}

// Each set counted at an event for genre totals. Every artist in a B2B counts as
// 1 viewing, unless the B2B has a specified combo name (`alias`) that has genres
// in `byArtist`, in which case it counts as 1 viewing of the combo instead.
export function countedSets(
  event: Pick<LoggedEvent, 'seen'>,
  byArtist?: Map<string, ArtistGenres>,
): CountedSet[] {
  const groups = findPerformanceGroups(
    event.seen,
    (s) => s.key,
    (s) => s.b2b,
    (s) => s.slotId,
  );
  const out: CountedSet[] = [];
  for (const indices of groups) {
    const members = indices.map((i) => event.seen[i]);
    const isB2b = members.length > 1 || members.some((m) => (m.b2b?.length ?? 0) > 0);
    const alias = members.find((m) => m.alias?.trim())?.alias?.trim();
    const comboKey = alias ? normalizeName(alias) : '';
    const hasComboGenre = Boolean(isB2b && comboKey && (byArtist?.get(comboKey)?.genres.length ?? 0) > 0);
    if (hasComboGenre) {
      out.push({ key: comboKey, name: alias!, sets: 1 });
      for (const m of members) {
        if (members.length > 1 && m.solo) {
          out.push({ key: m.key, name: m.name, sets: 1 });
        }
      }
    } else {
      for (const m of members) {
        out.push({ key: m.key, name: m.name, sets: members.length > 1 && m.solo ? 2 : 1 });
      }
    }
  }
  return out;
}

// A set count for display: rounded to the nearest whole number, halves up.
export const formatSets = (n: number): string => String(Math.floor(n + 0.5));

export interface GenreCount {
  name: string;
  sets: number; // seen sets, each split across its act's genres by weight
  share: number; // of the sets with a genre
}

export interface GenreMix {
  // The group of each genre: its scene family when the vocabulary has a taxonomy (else the
  // music-story parent). The field keeps its name so existing callers still work.
  parents: GenreCount[];
  families: GenreCount[]; // by family name, only for genres that have a family

  styles: GenreCount[];
  umbrellas: GenreCount[]; // a set counts once under each umbrella it falls in
  sets: number; // every seen act at every event
  known: number; // those whose act has a genre
}

// Every umbrella in the vocabulary, by key, with the name to show for it: the
// umbrella's own vocabulary spelling, else the key.
export function umbrellaNames(vocab: GenreVocabulary | undefined): Map<string, string> {
  const names = new Map((vocab?.genres ?? []).map((g) => [g.key, g.name]));
  const out = new Map<string, string>();
  for (const g of vocab?.genres ?? []) for (const u of g.umbrellas) if (!out.has(u)) out.set(u, names.get(u) ?? u);
  return out;
}

// The umbrellas each genre key falls under, itself included when it is one.
function umbrellaLookup(vocab: GenreVocabulary | undefined): (key: string) => Set<string> {
  const closure = umbrellaClosure(vocab);
  const umbrellas = umbrellaNames(vocab);
  return (key) => {
    const out = new Set(closure.get(key) ?? []);
    if (umbrellas.has(key)) out.add(key);
    return out;
  };
}

// True when an act has the umbrella itself or any genre under it, at any depth.
export function hasGenreUnder(g: ArtistGenres | undefined, umbrellaKey: string, vocab: GenreVocabulary | undefined): boolean {
  const ups = umbrellaLookup(vocab);
  return (g?.genres ?? []).some((x) => ups(genreKey(x.style)).has(umbrellaKey));
}

// What you see live: every act you saw at every event counts once, split
// across its genres by weight. Sets without a genre are counted apart, never
// spread over the others. Groups and styles are the resolved ones from
// genresByArtist; a genre with no group counts under "Not grouped", and styles
// are counted by genreKey so two spellings of one genre are one bar.
// Umbrellas (docs/archive/genre-vocabulary.md section 7): per set, an umbrella gets
// the weights of the act's genres at or under it, at any depth, each genre once
// even when two paths reach the umbrella, so never more than one set.
export function genreMix(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  vocab?: GenreVocabulary,
): GenreMix {
  const parents = new Map<string, number>();
  const families = new Map<string, number>();
  const styles = new Map<string, number>();
  const styleName = new Map<string, string>();
  const umbrellas = new Map<string, number>();
  const names = umbrellaNames(vocab);
  const ups = umbrellaLookup(vocab);
  let sets = 0;
  let known = 0;
  for (const e of events) {
    for (const s of countedSets(e, byArtist)) {
      const share = s.sets;
      sets += share;
      const g = byArtist.get(s.key);
      if (!g?.genres.length) continue;
      known += share;
      const genreWeight = new Map<string, number>(); // this set, by genre key, times the share
      for (const x of g.genres) {
        const group = shareGroup(x);
        parents.set(group, (parents.get(group) ?? 0) + x.weight * share);
        const family = shareFamily(x);
        // A genre with no family is not a family: it has no row in the Family list.
        if (family && family !== NOT_GROUPED) families.set(family, (families.get(family) ?? 0) + x.weight * share);
        const k = genreKey(x.style);
        if (!k) continue;
        if (!styleName.has(k)) styleName.set(k, x.style);
        styles.set(k, (styles.get(k) ?? 0) + x.weight * share);
        genreWeight.set(k, (genreWeight.get(k) ?? 0) + x.weight * share);
      }
      // An umbrella gets at most the act's share of the set, however many of its genres the act has.
      const perSet = new Map<string, number>();
      for (const [k, w] of genreWeight) for (const u of ups(k)) perSet.set(u, (perSet.get(u) ?? 0) + w);
      for (const [u, w] of perSet) umbrellas.set(u, (umbrellas.get(u) ?? 0) + Math.min(share, w));
    }
  }
  const ranked = (m: Map<string, number>) =>
    [...m]
      .map(([name, n]) => ({ name, sets: n, share: known ? n / known : 0 }))
      .sort((a, b) => b.sets - a.sets || a.name.localeCompare(b.name));
  const named = new Map([...styles].map(([k, n]) => [styleName.get(k)!, n]));
  const umbrellaNamed = new Map([...umbrellas].map(([k, n]) => [names.get(k) ?? styleName.get(k) ?? k, n]));
  return {
    parents: ranked(parents),
    families: ranked(families),
    styles: ranked(named),
    umbrellas: ranked(umbrellaNamed),
    sets,
    known,
  };
}
