# Artist genres

Part of [ARCHITECTURE.md](../../ARCHITECTURE.md).


Genres are shared: one set of genres per artist in `artist_genres`, the same for everyone, so Stats, Artists and event pages show consistent genres across the app. Code: `src/server/events/genres.ts` and `genreCatalog.ts` (shapes in `genreTypes.ts`), routes in `genreRoutes.ts`, CSV helpers in `genreCsv.ts` and `genreCsvApply.ts`, the browser side in `src/services/genres.ts`, `src/components/ArtistGenresPanel.tsx` (the "Genres" button in Manage > Artists, owner only), `src/components/SeenGenres.tsx`, and `src/components/ManageEntry.tsx`. Nothing is guessed and no model is involved; an act neither source knows has no genre, and the views count it apart.

1. **music-story file.** music-story (a separate repo: your 19.5 years of Spotify and Last.fm listening in DuckDB, on your Mac) writes `build/artist_genres.json` with `uv run python -m pipeline.artist_genre export`: every artist it knows with a genre (name, MusicBrainz ID, styles with weights summing to 1, which tag sources fed it: Last.fm, Spotify, MusicBrainz) and its curated genre map (tag to style and one of 13 parent genres). Those groups are the top level only until the owner uploads a genre tree (see Genre taxonomy below). The owner uploads it in the panel (`POST /api/artist-genres/music-story`). It matches against `genreUniverse` (every row in `canonical_artists`, plus every act any member marked as seen via `seen_act_names()`, plus the owner's artist records) by stored MusicBrainz ID (`canonical_artists.mbid`), then by name (`normalizeName`, with `artist_aliases`). Matched acts are written as `artist_genres` rows with source `music-story` via `writeArtistGenres` (`actor: 'system:music-story'`). The genre map is kept in `app_settings` (`genre_map`).
2. **MusicBrainz, on request.** For acts the file does not cover, "Look up on MusicBrainz" sends 5 at a time (`POST /api/artist-genres/musicbrainz`, owner only). Each uses the stored MusicBrainz ID or the one artist whose name or alias is exactly the act's name (`exactMatches`, the rule `resolveArtist` uses); two or more, or none, means no genre. The artist's genres (`/ws/2/artist/<id>?inc=genres`, with vote counts) are read through the genre map: unmapped tags are ignored, styles under 15% of the votes dropped and the rest rescaled (`mapTags`, the same rule as music-story). The row keeps the artist page as `source_url`, written with `actor: 'system:musicbrainz'`. A lookup that finds nothing is stored too (empty `genres`), so it is not repeated unless the owner chooses to retry the MusicBrainz scan or re-scan in the panel.
3. **Owner edits and member additions.** In the event panel (`src/components/SeenGenres.tsx`) and on an artist's record in Manage (`src/components/ManageEntry.tsx`), `PUT /api/artist-genres/:key` splits by role:
   - **Owner:** sets the shared genres (`setOwnerGenres`, `source: 'owner'`, logged in `artist_genre_changes` with `actor: 'owner'`). An empty list means the owner says none; `reset` removes the owner's row so found genres show again. In Manage, the owner sees "Last change: <date>. Undo", which calls `POST /api/artist-genres/:key/undo` (`undoGenreChange`) and refuses with 409 if the row changed since.
   - **Member:** sees the shared genres as plain pills ("Set by the site owner", "From music-story", or "From MusicBrainz") and can add or remove genres of their own (`setMemberAdditions`, stored in `user_artist_genres`, returned to the client with `source: 'added'`). Member additions never hide or replace shared genres, are not logged, and show only to that member. "Remove my genres" resets them. `GET /api/artist-genres` returns shared rows to a member only for acts in their own events or artist records.
4. **Display precedence and stats (`genresByArtist`).** Step 1 picks the shared base per act: `owner` (empty list means none), legacy `you`, `music-story` with genres, `MusicBrainz` with genres, then `music-story` / `MusicBrainz` checked with none. Step 2 (members only) appends the member's `added` styles not already in the base: if there are `n` base genres and `m` additions, each addition gets weight `1 / (n + m)` and each base genre scales by `n / (n + m)`. Stats ("Genres you see live", `genreMix`) splits every seen set across those combined weights; Artists cards show up to three styles (with "Added by you: ..." in the tooltip when present) and filter by combined parent genres.
5. **CSV, edited in a spreadsheet (owner only, Genres panel, section 3).** "Download artists and genres (CSV)" saves `artists-and-genres-YYYY-MM-DD.csv` from `GET /api/artist-genres/csv/export` (`OWNER_ONLY`): every act in `genreUniverse` (`seen_act_names()` returns `(artist_key, name)` only — no member, event, date or count), with its MusicBrainz ID, the shared genres shown now, its source and a blank "New genres" column. The owner types genres there (separated by semicolons) and uploads the file ("Choose your edited file"). The browser reads it (`src/services/genresCsvFile.ts`, rules in `src/server/events/genreCsv.ts`) and posts filled rows to `POST /api/artist-genres/csv/preview`, which changes nothing. "Check before saving" (`src/components/GenresCsvPreview.tsx`) shows Now and New per act, flags acts changed in the app since export ("Replace anyway" tick), and lists skipped rows with reasons. "Apply" (`POST /api/artist-genres/csv/apply`) writes shared `owner` rows via `writeArtistGenres` with a `batchId`. "Undo this upload" (`POST /api/artist-genres/csv/undo`) reads `artist_genre_changes` for that batch and restores rows not changed since.
6. **Audit log (`artist_genre_changes`).** Every shared write (`owner`, `system:music-story`, `system:musicbrainz`, `system:catalog-rename`, `system:catalog-merge`, and `Undo`) goes through `writeArtistGenres` (`artist_genres_write` RPC in migration `0059_canonical_genres.sql`), recording `before`, `after`, `actor`, `reason`, and optional `batch_id` in an append-only table.
7. **Genre vocabulary (`src/server/events/genreVocabulary.ts`, `genreVocabularyManage.ts`; spec [docs/archive/genre-vocabulary.md](../archive/genre-vocabulary.md)).** Every style is resolved when read, never rewritten in `artist_genres`:
   - **One genre per spelling key.** `genreKey` folds capitals, accents, spaces, hyphens and punctuation ("electro house" = "Electro-House" = "electrohouse"). It never stems, drops or reorders words, so "rnb" and "r&b" stay apart until the owner adds an alias. A style with no letter or digit is refused (`GENRE_NEEDS_LETTER`).
   - **The owner's vocabulary** (migration 0060: `genres`, `genre_aliases`, `genre_umbrellas`, `genre_changes`, all server only) holds a genre's shown spelling, its group (the genre map's until a tree is uploaded, then the macro genre; see Genre taxonomy), other spellings (aliases), and umbrella genres. Umbrellas may nest, and loops are refused. Every change is one `genre_vocabulary_write` call through `writeGenreVocabulary`, with actor `owner`, logged with before and after and undoable from the newest change (refused when the genres changed since).
   - **Resolving** (`genreResolver`): vocabulary key or alias, then the genre map, then the style as typed under "Not grouped". Within one act, spellings of one genre become one with their weights added.
   - **Manage > Global archive > Genres** (`GenresPanel.tsx`, `GenreRecord.tsx`, owner only) lists every genre once with its group, umbrellas and artist count. It lists spellings to pick ("N genres have more than one spelling. Pick one.") and opens a record with rename (the old spelling becomes an alias), aliases ("Merge instead" when a spelling is already a genre), group, umbrellas, merge with a preview, and history with Undo. Routes: `POST /api/artist-genres/vocabulary/:operation` and `/vocabulary/undo/:id`. A member gets 403, and a member's `GET /api/artist-genres` has the vocabulary and map but no change log or collisions.
   - **Stats and Artists / Ranking.** `genreMix` adds `umbrellas`: per set, an umbrella gets the weights of the act's genres at or under it, each genre once, never more than one set. Ranking (`?view=ranking&by=artists|genres|people`, `ArtistsView.tsx` + `GenresRanking.tsx` + `src/services/genreInsights.ts`) holds the full "Genres you see live" breakdown with a period picker (`All time`, `Last 12 months`, current year, or any year), the Multi-Zoom Breakdown (see Explore genres below), `"Include related genres"`, tap-to-expand `"The artists behind it"` (top 5 acts), and `"See all ... acts in Artists"` (filtering `ArtistsView` by `g:`, `u:`, or `s:`). `StatsView.tsx` keeps a top-3 summary of `"Genres you see live"` with a `"See all"` link to `?view=ranking&by=genres`.
   - **Genres file.** The export lists resolved names. The stamp hashes resolved keys, and older files still match through `legacyGenreStamp`. The preview shows "typed → stored", and a row equal after resolving is "No change".

## Genre taxonomy

Phase A (approved 2026-11-27; see [docs/specs/genre-taxonomy-phase-a.md](../specs/genre-taxonomy-phase-a.md), migration `0063_genre_taxonomy.sql`) puts each genre under one scene family and each family under one macro genre. The owner builds the tree with uploads and Manage. Nothing in it is guessed or read from a model.

**Levels.** Macros and families are rows in `genres`, with `level` set to `genre`, `family` or `macro`. A family's key is `family:` plus its `genreKey`; a macro's key is `macro:` plus its `genreKey`. A genre key never has a colon, so a typed spelling cannot reach either. A genre has one `primary_parent_key`, a family. A family has one primary parent, a macro. A macro has no parent. `specificity_tier` (`specific` or `umbrella_fallback`) is set on genres only. Code: `src/server/events/genreVocabulary.ts` (`levelOf`, `familyKey`, `macroKey`, `checkTaxonomy`).

**Roll-up.** Totals are worked out when the data is read, never stored:

1. A style resolves through its alias to its genre key (`genreResolver`).
2. The genre's `primary_parent_key` gives its family. Only a row at family level counts.
3. The family's `primary_parent_key` gives its macro.

A genre with no family, or a family with no macro, is "Not grouped". Totals by family or macro never read the stored `parent` (music-story's group). Once a tree exists, every share carries its macro and family. An umbrella (`genre_umbrellas`) works as before and never adds a genre to an act.

**Ranked owner genres.** The owner's genres on an act are ranked by their order. The weights before scaling are 1.0, 0.70, 0.45 and 0.25 for ranks 1 to 4, and 0.25 for every rank after that; the weights are then scaled to sum to 1 (`rankedWeights` in `src/server/events/genres.ts`). Two spellings that merge keep the smaller rank. Music-story and MusicBrainz weights stay as they were sent.

**Relations (`genre_relations`).** Links beside the tree. A link never adds to a total. There are three types:

- `secondary_parent`: a genre to a family, a second family for the genre.
- `adjacent`: a genre to a genre, stored once, never in both directions.
- `derived_from`: a genre to a genre, with no loops.

Each link has a weight above 0 and at most 1, and an origin. `curated` links are the owner's. `artist_cooccur` and `lineup_cooccur` links are computed. A system job may write only those two origins, from shared tables (`artist_genres`, `performances`), and never over a `curated` link; the database refuses a system write that changes one. No link is computed from any member's events, attendance or companions. In Phase A no job writes computed links yet. The owner's links file accepts `curated` and `artist_cooccur`; it refuses `lineup_cooccur`.

**Uploads (owner only).** Each upload has a preview that saves nothing and an apply that writes one change to `genre_changes`, which can be undone.

1. **Genre tree file** (`POST /api/artist-genres/vocabulary/csv/preview`, then `.../apply`). Columns: `genre`, `group`, `other spellings`, and for a tree `family`, `macro`, `tier` and `secondary families`. A file with a `family` column is a tree (operation `taxonomy-import`). Without it, the same route is a plain vocabulary upload (operation `create`). If any row breaks a rule, the file is refused and nothing is written.
2. **Links file** (`POST /api/artist-genres/relations/csv/preview`, then `.../apply`). Columns: `source`, `target`, `type`, `weight`, `origin`. A secondary parent is a family name; the other types are genre names. The file replaces every stored link of each (type, origin) pair it contains, across all genres. Pairs it does not contain stay as they are. Apply is one `relations-import` change.

**Manage (owner).** In Manage > Global archive > Genres, `GenresPanel.tsx` lists the tree by macro, then family, then genre. `GenreRecord.tsx` has a Family menu grouped by macro, lists each genre's links with strength and origin, and adds, removes or re-weights links. Families and macros can be renamed. Merge refuses a family or a macro. Each change is one `genre_vocabulary_write` call, logged in `genre_changes` and undoable, and refused when those genres changed since. Create genre takes a family from a menu grouped by macro, or Not grouped. Undo of a change made after migration 0063 is also refused when a genre's family, tier or links changed since, as it already is for its name, aliases and umbrellas.

**Explore.** `src/services/genres.ts` (`genreMix`, `countedSets`, `setShares`) counts each act's genres, and groups "Genres you see live" by scene family when a tree exists (Charlie, 2026-11-27: macros were too broad, almost everything was Electronic). The same family grouping (`shareGroup`) drives Stats, Your genre story, the Map and Timeline genre filters, the River colours and the people list. The Multi-Zoom Breakdown and Sound Drift still offer Macro as a level. `src/services/genreInsights.ts` (`genreZoom`, `soundDrift`) reads the same links at view time for the Multi-Zoom Breakdown and Sound Drift. A genre or family with no parent is "Not grouped". The screens are described in Explore genres below.

## Explore genres

Release 1 of the genre taxonomy is built in Slices 40.1 to 40.7 ([docs/archive/genre-taxonomy-release-1.md](../archive/genre-taxonomy-release-1.md)). Everything is worked out in the browser from the person's own events and the shared genre rows. Nothing new is stored, and no one's events are read for another person.

**B2B counting.** Each artist in a B2B counts as 1 viewing (whole numbers, never fractions), unless the B2B has a specified combo name (`alias`) that has genres in `byArtist`, in which case it counts as 1 viewing of the combo instead. An act the person also saw play solo at the same event (`solo`) gets a further 1 viewing (`countedSets` and `setShares` in `src/services/genres.ts`). Every genre total on Explore uses `countedSets`.

**Multi-Zoom Breakdown** (Ranking > Genres, `src/components/GenresRanking.tsx`, `genreZoom` in `src/services/genreInsights.ts`).

- Three levels: Macro, Family and Genre. Family is the default.
- Each level has one 100% bar and a ranked list. Each level adds up to 100% of the sets with a genre.
- A family opens to its genres. Each genre's share is of all sets with a genre, so the genres add up to the family's own figure.
- Tapping a row's name lists the artists behind it, the top 5, with a link to See all in Artists.
- Sets with no genre are not spread over the others. A note under the list says how many there were: "N sets had no genre and are not counted."
- The chart needs 10 sets with a genre. Below that, the screen says "Genres show once you have 10 sets with a genre. You have N sets." and shows no chart.
- Without a tree in the vocabulary, the zoom falls back to the music-story groups as one level, shown as Macro.

**Sound Drift** (Your genre story, `src/components/GenreYearsChart.tsx`, `soundDrift` and `driftDrivers` in `src/services/genreInsights.ts`).

- A 100% stacked area chart by calendar year, with a Family or Macro switch.
- Bands are the six largest families (or macros) across counted years, plus Other when a year has one.
- A year counts when it has 10 or more sets with a genre. Other years are drawn faded and are left out of the lead sound.
- The lead sound line names the leading band of each counted year, with repeats merged: "Your lead sound: Progressive House (2019 to 2021), then Melodic Bass (2022)."
- The chart shows only with 3 counted years. Below that: "Sound Drift needs 3 years with at least 10 sets that have a genre. You have N."
- Tapping a band or a year opens the sets and artists behind it. Tapping again closes it. A table gives the same numbers for screen readers.

## Lineup DNA and Event Match

Release 2 of the genre taxonomy is built in Slices 41.1 to 41.5 ([docs/archive/genre-taxonomy-release-2.md](../archive/genre-taxonomy-release-2.md)). **Moved 2026-11-27 (Charlie: too much clutter on the lineup):** Lineup DNA and the Event Match line now sit in the event page's own Genres tab, which replaced the Changes tab (a link there opens this event's changes in the Log). The lineup table no longer shows the "Your lane" and "Nearby" pills. There is no migration and nothing new is stored.

**Lineup genres route.** `GET /api/events/:id/lineup-genres` (`src/server/events/genreRoutes.ts`) answers only for the caller's own event (another person's id gives 404). It returns the lineup acts the event page already shows (`eventPerformers`). Each act comes with its stages and days, read from the edition's performances (cancelled ones left out) or from the lookup's candidate. It also returns the shared genre rows for those acts and the caller's own added rows for them. A member therefore gets the shared genres of acts on their own event's lineup, including acts they did not mark as seen. It only reads: there is no lookup, fetch or model call.

**Lineup DNA** (`src/components/LineupDna.tsx`, `lineupDna` in `src/services/genreInsights.ts`).

- Every act on the bill counts 1.0, split across its genres by weight. A B2B slot with a combo `alias` that has genres counts as 1.0 for the combo; otherwise each act counts 1.0.
- There is one bar for the whole bill. When the lineup has stages, each stage gets its own bar as well. An act on two stages counts on both stage bars and once on the whole bill. Acts with no stage go on "No stage listed", which shows only when other stages exist.
- Each bar shows its 4 largest families. A 5th family shows only when it is at least 10% of the bar, and the rest is grouped as Other. Tapping a segment lists its top genres and acts.
- When fewer than 60% of the acts have a genre, the bar notes "N of M acts have a genre." A bar needs 3 acts with a genre. Below that, the page says so and shows no bar.
- Colours are the Sound Drift palette (`PALETTE`, exported from `GenreYearsChart.tsx`).

**Event Match** (`eventMatch` in `src/services/genreInsights.ts`).

- Your vector is every seen set at your other attended events, counted with `countedSets`. The event being matched is left out, and so are planned and missed events.
- That vector is smoothed one step over the owner's `adjacent` links only: `u + 0.5 · Â·u`. The links are read both ways, and each weight is divided by `sqrt(deg(a) · deg(b))`, so a genre linked to almost everything is toned down. It never goes two steps. `secondary_parent` and `derived_from` links are not used.
- The score is the cosine between your smoothed families and the bill's families. The bands are "Strong fit" at 0.6 or more, "Some overlap" from 0.3, and "Outside your usual" below 0.3. The line names your lane, the 1 or 2 families that add most to the score, with the number of acts in your lane and of nearby acts you haven't seen.
- The lineup table marked those acts with "Your lane" and "Nearby" pills (removed when parked).
- Event Match needs 20 sets with a genre over 5 events, plus the whole-bill bar's own floor. Below that, the line says what is missing.
- Relations never change the Lineup DNA bar, only the match.
- Sample mode shows neither, because the sample events have no lineup edition.

## Orbits, bill links and the Constellation

Release 3 of the genre taxonomy is built in Slices 43.0 to 43.8 ([docs/specs/genre-taxonomy-release-3.md](../specs/genre-taxonomy-release-3.md)). It has one migration, 0064 (see [12-data-model.md](12-data-model.md)).

**Orbits** (`src/server/events/artistOrbits.ts`). An orbit is a small scene named after the acts that define it, such as "Porter Robinson · Madeon lane". It is not a genre word and never adds to a total.

- Each orbit has 2 to 4 anchors, core peers and crossovers (centrality 1.0, 0.5 and 0.25). An act can be in several orbits. Only the owner's `curated` orbits exist today.
- Every change goes through `writeArtistOrbits`, which writes one `artist_orbit_changes` row and can be undone. An undo is refused when an orbit changed after it.
- `GET /api/artist-orbits` gives the owner every orbit and the last 20 changes. A member gets only the orbits that include an act from their own events or records (`memberActKeys`), each with its full roster by name. `POST /api/artist-orbits/undo/:id` is owner only.
- The owner edits orbits as a spreadsheet in Manage > Genres (`src/server/events/artistOrbitsCsv.ts`). The columns are `orbit_id, label, parent_genre, anchors, core, crossover`, with acts separated by `;` and matched by MusicBrainz ID or exact name. The file replaces the whole set. The preview lists added, removed and changed orbits and refuses an unknown anchor or parent genre, or fewer than 2 or more than 4 anchors. Apply writes with actor `owner` and the reason "Orbits spreadsheet".
- In Ranking > Artists, an act in an orbit shows a pill with the orbit's label. Tapping it opens `OrbitSheet` (`src/components/OrbitSheet.tsx`): the roster, which acts you have seen, and your own events with any member on the lineup, planned ones first. With no orbits, nothing shows.

**Bill links** (`src/server/events/lineupCooccur.ts`). A job learns which genres are booked together, from shared lineups only (`performances` and `artist_genres`).

- A bill is one stage at one edition, or the whole edition when its lineup has no stages. Each act brings its top 3 genres, resolved through the vocabulary. Cancelled sets are left out, and a B2B pair counts once per bill.
- For each pair it computes NPMI over the bills that have a genre. A pair is kept when it is on at least 3 bills with NPMI of 0.2 or more, and each genre keeps at most its 5 strongest. The weight is the NPMI.
- The owner presses "Learn links from lineups" in Manage > Genres. `POST /api/artist-genres/relations/lineup/preview` shows the added, removed and changed links and the number of bills and genres used. `/apply` writes them through `writeGenreVocabulary` as `lineup_cooccur` adjacent links, with actor `system:lineup-cooccur` and the reason "Learned from shared lineups", and can be undone.
- The job replaces only its own earlier rows. It skips any pair that already has a `curated` or `artist_cooccur` link in either direction. It never runs on a schedule.
- Event Match and "One step outside your lane" pick the links up with no further change.

**One step outside your lane** (`outsideLane` in `src/services/genreInsights.ts`, a card in `GenreStory.tsx`). It names up to 3 genres that sit next to your top 5 genres by sets (adjacent weight 0.25 or more) and that you have never seen live. Each comes with "next to {your genre}", the acts in it from your planned events, and the orbits that hold those acts. It needs the Event Match floor of 20 sets over 5 events. When there is nothing to show, the card does not show.

**Constellation** (`src/components/GenreConstellation.tsx`). An opt-in map opened from "Open the Constellation" in Your genre story, never on the logging path.

- It is a fixed radial layout in SVG: macro sectors, family arcs and genre dots, with no new library, so it looks the same on every visit.
- Genres you have seen are filled and sized by the square root of your sets. Unseen genres one step away (weight 0.25 or more) are outlined and pulse, unless reduced motion is on.
- Tapping a genre lists your sets and acts in it, and Escape closes the list. A visually hidden table gives the same data to screen readers.
