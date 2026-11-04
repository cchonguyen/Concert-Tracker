-- artist_genres: allow source 'you' (genres you set yourself on an act).
-- 0013 already lists 'you', but a database that ran an earlier 0013 has the
-- old two-value check, so saving a genre under Manage fails with
-- artist_genres_source_check. Re-creating the check is safe: no row can hold
-- 'you' under the old check.

alter table artist_genres drop constraint if exists artist_genres_source_check;
alter table artist_genres add constraint artist_genres_source_check
  check (source in ('music-story', 'musicbrainz', 'you'));
