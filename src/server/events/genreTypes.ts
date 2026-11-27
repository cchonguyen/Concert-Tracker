// Shapes and limits shared by the server (genres.ts) and the browser, kept
// free of server imports so the client bundle can use them.

// owner: the site owner's shared genres, which win over every other source.
// you: legacy owner rows in the shared table until migration 0059 moves them to owner.
// added: client-only, a member's own additions (user_artist_genres), shown only to them.
export type GenreSource = 'music-story' | 'musicbrainz' | 'you' | 'owner' | 'added';

export interface GenreShare {
  parent: string; // one of music-story's parent genres, e.g. "electronic"; a genre you made up is its own parent
  style: string; // e.g. "deep house"; = parent when there is no finer style
  weight: number; // shares of one artist sum to 1
  rank?: number; // owner's genres only: 1 is the first genre typed, from the rank decay table
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
  added?: string[]; // display only: the styles a member added on top of the shared ones
}

// One row of artist_genre_changes (docs/specs/canonical-genres.md section 3).
export interface GenreChange {
  id: string;
  key: string; // artist_key
  source: GenreSource; // which artist_genres row changed
  at: string;
  actor: 'owner' | `system:${string}`;
  reason: string;
  batchId?: string; // one genres file upload
  before: ArtistGenres | null; // null: there was no row
  after: ArtistGenres | null; // null: the row was removed
  undoneAt?: string;
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
export const MAX_OWN_GENRES = 10;
export const MAX_GENRE_LENGTH = 60;

// A genre you can pick: every style in the genre map or on a stored act.
export interface KnownGenre {
  style: string;
  parent: string;
}

// A row's place in the taxonomy (docs/specs/genre-taxonomy-phase-a.md section 2).
// A missing level means 'genre'.
export type GenreLevel = 'genre' | 'family' | 'macro';
export type GenreTier = 'specific' | 'umbrella_fallback';
export type GenreRelationType = 'secondary_parent' | 'adjacent' | 'derived_from';
export type GenreRelationOrigin = 'curated' | 'artist_cooccur' | 'lineup_cooccur';

// An outgoing link from one genre (genre_relations). Never counted in totals.
export interface GenreRelation {
  target: string; // key of the linked row
  type: GenreRelationType;
  weight: number; // (0, 1]
  origin: GenreRelationOrigin;
}

// The owner's genre vocabulary (docs/specs/genre-vocabulary.md section 2). A genre
// nobody has changed has no entry: it resolves to itself by its key (genreKey).
export interface VocabGenre {
  key: string; // genreKey(name); a family is 'family:' + genreKey, a macro 'macro:' + genreKey
  name: string; // the spelling shown everywhere
  parent?: string; // the owner's group; absent: from the genre map
  aliases: Array<{ key: string; alias: string }>; // other spellings, by their own keys
  umbrellas: string[]; // keys of the genres this one sits under
  level?: GenreLevel; // absent: 'genre'
  primaryParent?: string; // key of the family (genre) or macro (family); absent: none
  tier?: GenreTier; // genres only
  relations?: GenreRelation[]; // outgoing links only
}

export interface GenreVocabulary {
  genres: VocabGenre[];
}

export type GenreVocabOperation =
  | 'rename'
  | 'alias-add'
  | 'alias-remove'
  | 'merge'
  | 'parent'
  | 'umbrella-add'
  | 'umbrella-remove'
  | 'spelling'
  | 'create'
  | 'undo'
  | 'taxonomy-import'
  | 'relations-import'
  | 'relation-add'
  | 'relation-remove'
  | 'relation-weight'
  | 'family';

// One row of genre_changes: the genres it touched as they were and as they became.
export interface GenreVocabChange {
  id: string;
  at: string;
  actor: 'owner' | `system:${string}`;
  operation: GenreVocabOperation;
  reason: string;
  summary: string;
  before: VocabGenre[]; // empty: none of them had a row
  after: VocabGenre[];
  undoneAt?: string;
}

// What any stored or typed spelling resolves to. No parent: shown as "Not grouped".
export interface ResolvedGenre {
  key: string;
  name: string;
  parent?: string;
  family?: { key: string; name: string }; // from the genre's primaryParent
  macro?: { key: string; name: string }; // from the family's primaryParent
  tier?: GenreTier;
}

// One key with two or more spellings and no chosen spelling yet (spec section 5).
export interface GenreCollision {
  key: string;
  spellings: Array<{ name: string; artists: number }>; // most artists first
  shown: string; // the spelling shown today
}
