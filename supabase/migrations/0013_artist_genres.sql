-- Artist genres (ArtistGenres in src/server/events/genreTypes.ts): the genres
-- of acts you saw, from the music-story export, MusicBrainz on request, or
-- you (your own, which win over both).
-- One row per act and source; an empty genres list means the source was
-- checked and had none. The genre map itself lives in app_settings
-- ('genre_map'). Apply this before deploying the code that writes it.

create table if not exists artist_genres (
  artist_key text not null,                -- the seen act's key (normalized name)
  source text not null check (source in ('music-story', 'musicbrainz', 'you')),
  name text not null,
  mbid text,
  genres jsonb not null default '[]',      -- [{ parent, style, weight }], weights sum to 1
  source_url text,                         -- MusicBrainz artist page
  inputs text[] not null default '{}',     -- music-story: lastfm, spotify, musicbrainz
  checked_at timestamptz not null,
  primary key (artist_key, source)
);

alter table artist_genres enable row level security;
