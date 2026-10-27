import type { LoggedEvent } from '../server/events/types';
import type { ArtistGenres, GenreShare } from '../server/events/genreTypes';

export type { ArtistGenres, GenreShare };

// The genres to show for each act: music-story's when it has any, otherwise
// MusicBrainz's. An act checked with no genre found keeps its empty row, so
// the app can tell "none found" from "not looked up".
export function genresByArtist(rows: ArtistGenres[]): Map<string, ArtistGenres> {
  const rank = (r: ArtistGenres) => (r.genres.length ? 0 : 2) + (r.source === 'music-story' ? 0 : 1);
  const out = new Map<string, ArtistGenres>();
  for (const r of rows) {
    const had = out.get(r.key);
    if (!had || rank(r) < rank(had)) out.set(r.key, r);
  }
  return out;
}

// Seen acts with no genre from music-story and no MusicBrainz check yet.
export function missingGenreKeys(events: LoggedEvent[], rows: ArtistGenres[]): string[] {
  const done = new Set(rows.filter((r) => r.source === 'musicbrainz' || r.genres.length).map((r) => r.key));
  const keys = new Set<string>();
  for (const e of events) for (const s of e.seen) if (!done.has(s.key)) keys.add(s.key);
  return [...keys];
}

// The styles worth naming for one act: its largest shares, up to `max`.
export const topStyles = (g: ArtistGenres | undefined, max = 3): string[] =>
  (g?.genres ?? []).slice(0, max).map((x) => x.style);

// The main parent genre of an act, or undefined when unknown.
export const mainGenre = (g: ArtistGenres | undefined): string | undefined => g?.genres[0]?.parent;

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
