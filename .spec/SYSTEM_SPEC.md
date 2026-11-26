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
