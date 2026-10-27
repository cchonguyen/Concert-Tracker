// Shapes and limits shared by the server (genres.ts) and the browser, kept
// free of server imports so the client bundle can use them.

export type GenreSource = 'music-story' | 'musicbrainz';

export interface GenreShare {
  parent: string; // one of music-story's parent genres, e.g. "electronic"
  style: string; // e.g. "deep house"; = parent when there is no finer style
  weight: number; // shares of one artist sum to 1
}

export interface ArtistGenres {
  key: string; // the seen act's key (normalized name)
  name: string;
  source: GenreSource;
  mbid?: string;
  genres: GenreShare[]; // empty: the source was checked and had none
  sourceUrl?: string; // the MusicBrainz artist page
  inputs?: string[]; // music-story: which tag sources fed it (lastfm, spotify, musicbrainz)
  checkedAt: string;
}

export interface GenreMapEntry {
  tag: string; // lower-case tag
  style: string;
  parent: string;
}

// app_settings key holding the genre map from the last music-story import.
export const GENRE_MAP_SETTING = 'genre_map';
export const MUSIC_STORY_FORMAT = 'music-story/artist-genres';
// Same rule as music-story: styles under 15% of an artist's tags are dropped.
export const MIN_SHARE = 0.15;
export const MAX_MUSICBRAINZ_GENRES = 5;
