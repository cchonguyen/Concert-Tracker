# Session Handoff

- **Last Active Platform:** Claude Code (project thread)
- **Branch Owner:** Claude (`claude/project-thread-lui75g`).
- **Active Branch / State:** `main` is current. Landing look is the app standard (`docs/specs/landing-look.md`, slices 45.1 to 45.5 merged: #1104, #1107, #1110, #1112, #1116) and the ticket style picker is live (`docs/specs/ticket-stub-styles.md`, 44.1, #1101). This change adds them to the design-system catalogue (`docs/design-system/`). A matching AGENTS.md rule waits on Charlie (AGENTS.md is a red tripwire). No slice is `[IN_PROGRESS]`.
- **Files Modified in Last Turn:** `docs/design-system/design-system.json`, `docs/design-system/agent-rules.md`, `docs/design-system/README.md`, `docs/specs/landing-look.md`, `.spec/SESSION_HANDOFF.md`
- **Verification Status:** typecheck and `npm test` pass (2,119 tests).
- **Immediate Next Step:** None for the design work. Known pre-existing bug: Stats throws "Cannot read properties of undefined (reading 'map')" in sample mode (`/demo`).

## Notes for the three open slices

What exists now (read these before editing):
- `src/services/genres.ts` `genresByArtist`: shared base (owner, legacy you, music-story, MusicBrainz) plus a member's additions; each result row has `added: string[]` with the styles the member added.
- `src/server/events/genreTypes.ts`: `GenreSource` includes `owner` and client-only `added`; `GenreChange` is a row of the change log.
- Routes (`src/server/events/genreRoutes.ts`): `PUT /api/artist-genres/:key` writes the owner's shared genres for the owner and the member's own additions for a member; `POST /api/artist-genres/:key/undo` (owner only) undoes the newest change for that act and returns `{ restored, rows }`, 409 when it changed since. `GET /api/artist-genres` gives a member only rows for their own acts.
- Store: `listGenreChanges({ key, limit })` gives the newest change for an act (owner only).

35.10 (screens, UI only): add `genresApi.undo(key)` in `src/services/lineupApi.ts` calling the undo route. Members: shared pills without a remove button, their own additions with one, "Add genre" appends to their additions, "Remove my genres" resets them, and the line "Shared genres are set by the site owner. Genres you add show only to you." Source label "Set by the site owner" for members, "Set by you" for the owner. Owner: "Last change: <date>. Undo" in the Manage artist record. Exact wording is in `docs/specs/canonical-genres.md` section 4.

35.11 (copy and docs): Genres panel counts say "set by you" for `owner`; add "Genres you set here are shown to everyone."; rewrite `docs/architecture/07-artist-genres.md` for shared genres; remove the "being built in 35.2 to 35.12" notes from `ARCHITECTURE.md` and `docs/architecture/19-multi-user.md`.

35.12 (core): a canonical artist rename or merge in `src/server/entities/canonicalManage.ts` carries `artist_genres` rows through `store.writeArtistGenres` with actors `system:catalog-rename` / `system:catalog-merge` (a merge keeps the target's row and moves the source's only where the target has none for that source). Tests in `tests/canonicalGenresCarry.test.ts`.

Known gap, not in these slices: in a member's request the owner's genre map setting is not returned, so a member's typed genre keeps its own capitals instead of the map's spelling.

- **Open gaps:**
  - Genre vocabulary (docs/specs/genre-vocabulary.md, slices 36.1 to 36.12) is built; migration 0060 is applied. SeenGenres.tsx, ArtistGenresPanel.tsx and ManageEntry.tsx still call `genresByArtist` without the vocabulary, so aliases and owner groups do not show there yet (spellings still fold).
