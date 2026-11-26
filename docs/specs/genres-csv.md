# Artist genres: download as a CSV, edit in a spreadsheet, upload again

Status: designed 2026-11-26 (Level 3 scout); scope approved by Charlie in plain English. Slices 34.1 to 34.5 in `.spec/PROGRESS.md`. No migration.

## In plain English

In Table > Genres there is a new button, "Download artists and genres (CSV)". It gives you a spreadsheet with one row per act: its name, what genres the app shows now, where they came from, and an empty "New genres" column. You type genres there (separated by semicolons) for any act you want to change, save the file and upload it back.

Before anything is saved you see a table of before and after for every act you filled in. Acts the app could not match for sure, or that you changed in the app after you downloaded the file, are listed and left alone. (For the changed ones you can tick "Replace anyway".) Nothing is saved until you press "Apply". Afterwards one "Undo this upload" button puts everything back. Rows you left blank are never touched. Your genres count as "you" genres, like ones you type in the event panel; music-story and MusicBrainz genres stay stored underneath and come back if you ever reset an act.

## Rules (from AGENTS.md and REQUIREMENTS.md)

- No model call anywhere in this feature; no inferred genres. A genre exists only because you typed it in the "New genres" cell.
- Saved as source `you`, with equal weights, a known genre keeping its spelling and parent genre, an unknown one being its own parent genre (`setOwnGenres` semantics, max 10 genres of at most 60 characters). A row over those limits is skipped and listed with the reason, never cut short.
- Blank "New genres" means leave the act alone. The CSV cannot clear an act's genres (use the app's "say none" for that).
- Matching never guesses (below). Stale rows are skipped unless ticked (rule: sync never overwrites newer edits).
- Public paths untouched; routes are under `/api/artist-genres`.

## Which acts are exported

Every act `setOwnGenres` accepts: each act marked as seen at any of the person's events (`seenArtists`) plus every non-merged artist entity of theirs (`kind === 'artist'`, `!mergedIntoId`), once each by key. That is wider than `missingGenreKeys` (seen acts only) on purpose: it is the same set the app lets you give genres. Each row shows what `genresByArtist` shows (yours, else music-story, else MusicBrainz, else none).

Columns, in order:

1. `Artist` (name as stored)
2. `MusicBrainz ID` (stored `canonical_artists.mbid`, blank when none)
3. `Current genres` (styles joined with `; `, largest share first)
4. `Source` (`yours`, `music-story`, `MusicBrainz`, or `none`)
5. `New genres` (blank; you fill it)
6. `Version (leave as it is)` (the version stamp)

The file name is `artists-and-genres-YYYY-MM-DD.csv`. UTF-8 with a byte order mark so spreadsheets keep accents; cells quoted per RFC 4180. Cells starting with `=`, `+`, `-` or `@` get a leading apostrophe on export (spreadsheet formula safety) and the apostrophe is stripped on read.

## Version stamp

A short hash (FNV-1a, 8 hex characters) of `source|lower-cased styles sorted, joined by ;` for the genres shown at export time (`none|` when nothing shows). It is a hash of the stored genres, not a timestamp, so an edit that is later undone does not look stale. The server recomputes it at preview and again at apply. A row with a missing or unreadable stamp counts as stale when the act has genres now and is accepted when the act has none.

## Parsing: in the browser

Decision: the browser reads the file and sends rows as JSON; the server does the matching and the checks.

- Reuse `parseCsv` from `src/services/listImport.ts` (RFC 4180, BOM, CRLF) and `downloadText` from `src/services/download.ts`. Both exist, are tested and are browser-safe.
- No large upload body: only rows with a filled "New genres" cell are sent, so the 100 kB default `express.json` limit is enough (cap 5,000 rows, rejected with a plain message above that).
- Parsing is a pure step, so it is tested without a server. The server never trusts the browser: it recomputes matches, the stamp and the limits at preview and at apply.
- Headers are found by name (case-insensitive), not position, so reordered columns work. A missing `New genres` or `Artist` column gives a plain error.

## Matching (same rule as the music-story import)

For each filled row, against the exportable acts:

1. MusicBrainz ID: exactly one act with that stored ID.
2. Else the exact normalized name: `normalizeName(name)` equals an act's key, or equals `normalizeName(canonicalName(name, aliases))` using `artist_aliases` (your renames).
3. Anything else is skipped with a reason: "no act with that MusicBrainz ID or name", "the name matches more than one act", "the ID and the name point to different acts", "two rows for the same act". Skipped rows are listed in the preview, never guessed, never fuzzy matched.

## Preview, then Apply

`POST /api/artist-genres/csv/preview` takes `{ rows: [{ line, name, mbid, newGenres, stamp }] }` and changes nothing. It returns:

- `changes`: per act `{ key, name, before: string[], beforeSource, after: [{ style, parent, isNew }], stale, sameAsNow }`. `isNew` is true when the genre is not in `knownGenres` (it becomes its own parent genre; the screen says so in plain words). Rows whose genres equal what shows now are listed as "no change".
- `skipped`: `{ line, name, reason }`.

`POST /api/artist-genres/csv/apply` takes `{ rows, overwrite: [keys] }`, recomputes everything, saves only matched, valid rows that are not stale (or are ticked in `overwrite`), and returns `{ saved, skipped, batchId }`. Stale means the stamp no longer equals the current stamp: the person changed the act's genres in the app after downloading.

Required test: edited after export and CSV untouched means nothing changes. That is a row with a filled New genres cell and an old stamp, no overwrite tick: skipped as stale, stored genres identical afterwards.

## Undo of a whole upload (no migration)

No new table. The server keeps one undo record per person with the existing settings store, `store.putSetting('genres_csv_undo', record)` (per member in `user_settings`, the owner's in the same place; `you` genres are per member, so the undo record is too). Record: `{ batchId, at, rows: [{ key, name, before: ArtistGenres | null, after: ArtistGenres }] }` where `before` is the person's own `you` row (null when they had none).

- `POST /api/artist-genres/csv/undo` restores each row: `before` null deletes the `you` row (`deleteArtistGenres(key, 'you')`), else `putArtistGenres([before])`. A row whose current `you` row no longer equals `after` (changed since the upload) is left alone and counted as "changed since, left as it is". The record is removed when done.
- Only the latest upload can be undone; a new Apply replaces the record. Said plainly on screen.
- `GET /api/artist-genres` gains `csvUndo: { at, count } | null` so the panel can show the button.
- A new migration was considered and rejected: the data is small (at most a few thousand rows), owned by one person, and `app_settings` / `user_settings` already carry per-person JSON. Migration 0059 is not needed. If a later review wants a permanent history table, that is a separate slice and Charlie applies the migration.

## Where the code goes

- `src/server/events/genreCsv.ts`: pure, no server imports (so the browser can import it): column names, `genreStamp`, `exportRows`, `matchCsvRows`, `previewChanges`, `parseGenreList`. Tested in `tests/genreCsv.test.ts`.
- `src/server/events/genres.ts`: `setOwnGenres` split so a pure `ownGenreRow(known, key, name, styles, now)` is shared (behaviour unchanged).
- `src/server/events/genreCsvApply.ts`: `previewGenresCsv`, `applyGenresCsv`, `undoGenresCsv`, `exportGenresCsv` (store access).
- `src/server/events/genreRoutes.ts`: `GET /artist-genres/csv/export`, `POST .../csv/preview|apply|undo`.
- `src/services/genresCsvFile.ts`: browser: build and download the CSV, read an uploaded file into rows (uses `parseCsv`, `downloadText`).
- `src/components/ArtistGenresPanel.tsx` (buttons and section) and `src/components/GenresCsvPreview.tsx` (the preview table). Use shared `src/components/ui/` pieces (Dialog already, `Pill` for "New genre" and "Changed since you downloaded", `IconButton`/`Popover` where needed); no fresh inline copies of those patterns.

## UI copy (plain English)

- Button: "Download artists and genres (CSV)". Upload: "Choose your edited file".
- Heading: "Check before saving". Table columns: Artist, Now, New. Pills: "New genre", "Changed since you downloaded", "No change".
- Left out list: "These rows were left out. Nothing was guessed." with a one-line reason each.
- Buttons: "Apply (N acts)", "Cancel", afterwards "Undo this upload".

## Docs updated in the same slices

`docs/architecture/07-artist-genres.md` (new section 4, CSV; the "You" rule gains the CSV route) and `ARCHITECTURE.md` (artist genres summary line) in slice 34.5; `docs/architecture/13-api.md` in 34.3. AGENTS.md already allows genres "from you"; no rule changes there.

## Slice 34.1 decisions (pure rules, `src/server/events/genreCsv.ts`)

- The module imports only `canonicalName` (`lineup/merge.ts`), `normalizeName` (`lineup/text.ts`) and constants and types from `genreTypes.ts`. It does not import `genres.ts`, so it stays free of DB and network code.
- An MBID that matches no act falls back to the name, but a name match whose stored MBID is different is skipped ("the name matches an act with a different MusicBrainz ID"). This is stricter than the matching list above and is never a guess.
- Two rows for one act: both rows are skipped, not the second one only.
- "Current genres" and the stamp treat an act with nothing shown as source `none`, so a "say none" act and a never-set act stamp the same.
- The formula apostrophe is added to cells starting with `=`, `+`, `-` or `@` (after any leading apostrophes) and removed on read, so every value round-trips exactly.
- `sameAsNow` (the "No change" row) means your own genres already are exactly these. A music-story act given the same genres still gets saved, because its source changes to yours.
- A New genres cell with only separators is skipped with a reason, never read as "clear the act".
