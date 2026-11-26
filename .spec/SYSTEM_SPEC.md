# System Specification & Contracts

The full spec lives in the project docs and the feature specs under `docs/specs/`. Earlier contracts in this file were built and are in `.spec/archive/`; for how the app works today, read [ARCHITECTURE.md](../ARCHITECTURE.md).

- Requirements: [REQUIREMENTS.md](../REQUIREMENTS.md). Architecture: [ARCHITECTURE.md](../ARCHITECTURE.md). Rules: [AGENTS.md](../AGENTS.md).

## Feature in progress: Artist genres CSV export and re-import (designed 2026-11-26)

Full design: [docs/specs/genres-csv.md](../docs/specs/genres-csv.md). Slices 34.1 to 34.5 in `.spec/PROGRESS.md`.

- Table > Genres gets "Download artists and genres (CSV)" (every seen act plus the person's artist entities; columns: Artist, MusicBrainz ID, Current genres, Source, New genres, version stamp).
- Upload: the browser parses the CSV (`parseCsv`), the server matches (MBID, then normalized name with aliases; unmatched or ambiguous rows skipped), previews before/after, and saves only on Apply as source `you` through `setOwnGenres` rules. Blank New genres is left alone.
- Stale protection: a version stamp (hash of the shown genres) per row; changed since export means skipped unless ticked.
- One-button undo of the latest upload, stored with `putSetting('genres_csv_undo', ...)`. No migration (0059 stays free).
- No model call, no inferred genres, no public path change.

## Feature designed: Shared artist genres (approved 2026-11-26)

Full design: [docs/specs/canonical-genres.md](../docs/specs/canonical-genres.md). Slices 35.1 to 35.12 in `.spec/PROGRESS.md`. Replaces the personal-scope genres CSV above.

- One genre set per artist for everyone, in `artist_genres`; the owner's are source `owner` and win (`genresByArtist` base: owner, legacy you, music-story, MusicBrainz). Only the owner edits the shared set. A member's own additions (`user_artist_genres`, client source `added`) are appended after the base, deduped by style, weights `1/(n+m)` each with shared shares scaled by `n/(n+m)`; shown only to that member; Stats uses the combined weights.
- Every write goes through `writeArtistGenres` (rpc `artist_genres_write`, migration 0059), logged in append-only `artist_genre_changes` (before, after, actor `owner` or `system:*`, reason, batch id); undo per upload and per act with a changed-since check.
- Export universe (`genreUniverse`): `canonical_artists`, then every member's seen acts via the service-role-only `seen_act_names()` (key and name only), then the owner's artist records.
- Members receive genre rows only for their own seen acts and records. Export is `OWNER_ONLY` (`requestScope.ts`, red); `PUT /api/artist-genres/:key` routes the owner to the shared write and a member to their additions.
- Rule changes: AGENTS.md genre bullet (shared, owner-set, member additions on top) and a new export bullet, REQUIREMENTS.md Scope exception, member notice version 4.
