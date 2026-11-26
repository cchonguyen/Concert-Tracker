import type { LoggedEvent } from '../server/events/types';
import type { ArtistGenres, GenreShare } from '../server/events/genreTypes';

export type { ArtistGenres, GenreShare };

// The genres to show for each act (docs/specs/canonical-genres.md section 4).
// Step 1, the shared base: the owner's (an empty list means none), legacy
// 'you' rows (read as the owner's until 0059 moves them), music-story with
// genres, MusicBrainz with genres, then music-story and MusicBrainz checked
// with none. An act checked with no genre found keeps its empty row, so the
// app can tell "none found" from "not looked up".
// Step 2: a member's 'added' styles not already in the base go after it.
const BASE_RANK: Partial<Record<string, number>> = { owner: 0, you: 1 };
const baseRank = (r: ArtistGenres): number =>
  BASE_RANK[r.source] ?? 2 + (r.genres.length ? 0 : 2) + (r.source === 'music-story' ? 0 : 1);
const norm = (s: string) => s.trim().toLowerCase();

function withAdditions(base: ArtistGenres | undefined, added: ArtistGenres): ArtistGenres | undefined {
  const have = new Set((base?.genres ?? []).map((g) => norm(g.style)));
  const extra: GenreShare[] = [];
  for (const g of added.genres) {
    const k = norm(g.style);
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

export function genresByArtist(rows: ArtistGenres[]): Map<string, ArtistGenres> {
  const out = new Map<string, ArtistGenres>();
  const added = new Map<string, ArtistGenres>();
  for (const r of rows) {
    if (r.source === 'added') {
      added.set(r.key, r);
      continue;
    }
    const had = out.get(r.key);
    if (!had || baseRank(r) < baseRank(had)) out.set(r.key, r);
  }
  for (const [key, a] of added) {
    const g = withAdditions(out.get(key), a);
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

export interface GenreCount {
  name: string;
  sets: number; // seen sets, each split across its act's genres by weight
  share: number; // of the sets with a genre
}

export interface GenreMix {
  parents: GenreCount[];
  styles: GenreCount[];
  sets: number; // every seen act at every event
  known: number; // those whose act has a genre
}

// What you see live: every act you saw at every event counts once, split
// across its genres by weight. Sets without a genre are counted apart, never
// spread over the others.
export function genreMix(events: LoggedEvent[], byArtist: Map<string, ArtistGenres>): GenreMix {
  const parents = new Map<string, number>();
  const styles = new Map<string, number>();
  let sets = 0;
  let known = 0;
  for (const e of events) {
    for (const s of e.seen) {
      sets += 1;
      const g = byArtist.get(s.key);
      if (!g?.genres.length) continue;
      known += 1;
      for (const x of g.genres) {
        parents.set(x.parent, (parents.get(x.parent) ?? 0) + x.weight);
        styles.set(x.style, (styles.get(x.style) ?? 0) + x.weight);
      }
    }
  }
  const ranked = (m: Map<string, number>) =>
    [...m]
      .map(([name, n]) => ({ name, sets: n, share: known ? n / known : 0 }))
      .sort((a, b) => b.sets - a.sets || a.name.localeCompare(b.name));
  return { parents: ranked(parents), styles: ranked(styles), sets, known };
}
