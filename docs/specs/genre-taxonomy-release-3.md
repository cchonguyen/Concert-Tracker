# Genre taxonomy, Release 3: Orbits, bill links and the Constellation

Planned 2026-11-27, after Release 2 ([genre-taxonomy-release-2.md](genre-taxonomy-release-2.md)) merged. It follows Charlie's brief "Genre Taxonomy, Visualizations & Relational Discovery" (Release 3, its Phase B schema, the "Live Stage Co-Occurrence Learning" and "One Step Outside Your Lane" rows) and the Phase A decision on the system job. Slices are 43.x. It has one migration, 0064, which Charlie applied on 2026-11-27.

## In plain English

- **Orbits** are small scenes named after the acts that define them, for example "Porter Robinson · Madeon · ODESZA lane". They are not new genre words. The owner writes them in a spreadsheet and uploads it. Every orbit lists its acts as anchors (the 2 to 4 names in its label), core peers, or crossovers. An act can be in more than one orbit. Orbits never add to any total.
- In Ranking > Artists, an act in an orbit shows a small pill with the orbit's name. Tapping it opens the orbit: its acts, which of them you have seen, and your own events (past and planned) with any of them on the lineup.
- **Bill links**: a job learns which genres get booked together on the same stage or bill, from the shared lineups and the shared genres. It finds pairs that turn up together more often than chance would give (PMI). The owner presses "Learn links from lineups" in Manage > Genres, sees what would change, and applies it. The links are stored as `lineup_cooccur` adjacent links, logged, and can be undone. They never replace a link the owner wrote or the links from the owner's file.
- **One step outside your lane** is an Explore card. It names up to 3 genres next to your top genres (link weight 0.25 or more) that you have never seen live, with the acts in them from your own planned events and the orbits that hold them.
- **Constellation** is an opt-in map in Explore. Genres sit in rings by macro and family. Genres you've seen light up, sized by sets. Unseen neighbours one step away glow softly. Tap a genre to see your sets and acts in it. It never appears on the logging path.
- Nothing reads anyone else's events. The job reads only `performances` and `artist_genres`.

## Decisions this spec carries

1. Orbits are curated only in this release: origin `curated`, from the owner's upload. The schema keeps `lineup_cluster` and `hybrid` for later, but no code writes them (brief: "curated first").
2. Proposed: a member is sent the orbits that include at least one act from their own events or records, with each orbit's full roster by name. A roster is the owner's shared curation and holds no personal fields. This widens what a member gets, so slice 43.0 adds one sentence to AGENTS.md (needs Charlie's tap).
3. The job writes only `lineup_cooccur` rows. It replaces its own earlier rows on each apply, never writes over a `curated` row or the `artist_cooccur` rows from the owner's file, and skips any pair that already has a curated link in either direction. This is what AGENTS.md already allows.
4. Proposed: the job runs only when the owner presses the button, with a preview first. No schedule. A schedule can come later once the numbers look right.
5. Proposed job maths:
   - A bill is one stage at one edition, or the whole edition when its lineup has no stages.
   - An act brings its top 3 genres (resolved through the vocabulary). Cancelled performances are left out.
   - For genres g and h, `PMI = log(n_gh · N / (n_g · n_h))` over N bills, normalised to `NPMI = PMI / −log(n_gh / N)`.
   - A pair is kept when it is on at least 3 bills and NPMI is at least 0.2. Each genre keeps at most its 5 strongest, and the weight is NPMI (in (0, 1]).
   - Production today has 173 editions and 180 stage bills, and 57 editions have 3 or more acts with a genre, so the job has enough to work from.
6. Proposed: "One step outside your lane" uses your top 5 genres by sets, the brief's 0.25 link weight, and genres with 0 sets for you. It needs the Event Match floor (20 sets over 5 events).
7. Proposed: the Constellation uses a fixed radial layout (macro sectors, family arcs, genre dots), drawn in SVG with no new library, so it looks the same on every visit and needs no `package.json` change.

## 1. Rule wording (Slice 43.0)

One sentence is added to AGENTS.md's genre rule: "Artist orbits (`artist_orbits`, `artist_orbit_members`) are the owner's shared curation: changed only by the owner through `writeArtistOrbits`, recorded in `artist_orbit_changes` and undoable, never counted in a total; a member is sent the orbits that include an act from their own events or records, with each orbit's roster by name." The same sentence goes into ARCHITECTURE.md. This is a tripwire file, so it needs Charlie's tap and an `Approved-Tripwire` trailer.

## 2. Migration 0064 (Slice 43.1)

`supabase/migrations/0064_artist_orbits.sql`:

- `artist_orbits`: `id text primary key`, `anchor_keys text[]` (2 to 4), `working_label text null`, `parent_genre_key text null` (references `genres.key`), `origin text` check in (`curated`, `lineup_cluster`, `hybrid`), `updated_at`.
- `artist_orbit_members`: `orbit_id` (cascade), `artist_key`, `centrality numeric` check in (1.0, 0.5, 0.25), primary key (`orbit_id`, `artist_key`). Every anchor is also a member with centrality 1.0: the write function adds a missing anchor at 1.0 and refuses an anchor listed at another centrality.
- `artist_orbit_changes`: `id`, `old jsonb`, `new jsonb`, `actor`, `reason`, `at`, `undone_at`, like `artist_genre_changes`.
- RLS on with no policies, the same as `genres`: only the server reads and writes, through `artist_orbits_images`, `artist_orbits_write` and `artist_orbits_undo` (service role only).
- The PR is held until Charlie says it is applied.

## 3. Orbit store and write path (Slice 43.2)

- `writeArtistOrbits(store, next, actor, reason)` in `src/server/events/artistOrbits.ts` replaces the orbits it is given, writes one `artist_orbit_changes` row with the old and new images, and can be undone (refused when an orbit changed after the change, as genre undo does).
- The Postgres and file stores get `listArtistOrbits`, `putArtistOrbits`, `listOrbitChanges` and `undoOrbitChange`.
- `GET /api/artist-orbits`: the owner gets every orbit, and a member gets those touching their acts (decision 2).
- Tests cover the write, the undo, the stale undo, member filtering and the anchor-must-be-member rule.

## 4. Orbits spreadsheet (Slice 43.3)

- In Manage > Genres there is an Orbits CSV, with download, preview and apply. Its columns are `orbit_id, label, parent_genre, anchors, core, crossover`. Each act list is names separated by `;`, matched by MusicBrainz ID or exact name, the same as the genres CSV.
- The preview lists added, removed and changed orbits. It refuses a row whose anchor is unknown, that has fewer than 2 or more than 4 anchors, or whose parent genre is unknown.
- Apply goes through `writeArtistOrbits` with actor `owner`.

## 5. Orbits on screen (Slice 43.4)

- `orbitLabel(orbit, names)` gives "A · B · C lane" from the anchors, then the working label as a subtitle.
- Ranking > Artists shows an orbit pill on each act in an orbit. A new `OrbitSheet` shows the roster (anchors, core, crossover), which acts you've seen, and your events with any member on the lineup, planned ones first.
- With no orbits uploaded, nothing shows.

## 6. Bill links maths (Slice 43.5)

`lineupCooccur(bills, genreOf, vocab)` in `src/server/events/lineupCooccur.ts` is a pure function that returns `{ source, target, weight }[]` by decision 5, along with the counts it used. Tests cover:

- PMI and NPMI on a small fixture
- the 3-bill support floor
- the top-5 cap per genre
- skipping pairs that have a curated link
- B2B partners counted once per bill
- stages used as bills

## 7. Bill links job (Slice 43.6)

- `POST /api/artist-genres/relations/lineup/preview` and `/apply` (owner only) read `performances` and `artist_genres`, run `lineupCooccur`, and compare the result with the current `lineup_cooccur` rows.
- Apply writes through `writeGenreVocabulary` with actor `system:lineup-cooccur` and the reason "Learned from shared lineups", and can be undone.
- Manage > Genres gets a "Learn links from lineups" button with the preview (added, removed, changed, and the numbers of bills and genres used).
- Event Match and the next card pick the links up with no further change.

## 8. One step outside your lane (Slice 43.7)

`outsideLane(events, byArtist, vocab, orbits)` in `genreInsights.ts`, and a card in Your genre story (`GenreStory.tsx`) per decision 6. It shows up to 3 genres, each with "next to {your genre}", the acts in it from your planned events, and the orbits holding those acts. When there are none, the card does not show.

## 9. Constellation (Slice 43.8)

- `src/components/GenreConstellation.tsx` is opened from an "Open the Constellation" link in Your genre story, and is never shown on its own.
- It uses the radial layout from decision 7, with node size by sets (square root). Seen genres are filled, and unseen one-step neighbours (weight 0.25 or more) are outlined and pulse, unless reduced motion is on.
- Tapping a node lists your sets and acts in that genre. Escape closes the list. A table gives the same data for screen readers.

## 10. Docs (Slice 43.9)

`docs/architecture/07-artist-genres.md`, `docs/architecture/12-data-model.md` (0064), and `ARCHITECTURE.md`.

## 11. Slices

| Slice | Tag | What | Target files |
|---|---|---|---|
| 43.0 | CORE / DATA | Rule wording for orbits | `AGENTS.md`, `ARCHITECTURE.md` |
| 43.1 | CORE / DATA | Migration 0064 (held until applied) | `supabase/migrations/0064_artist_orbits.sql`, `tests/migration0064.test.ts` |
| 43.2 | CORE / DATA | Orbit store, write path, route | `src/server/events/artistOrbits.ts`, `src/server/lineup/store/*.ts`, `src/server/events/genreRoutes.ts`, `tests/artistOrbits.test.ts` |
| 43.3 | CORE / DATA | Orbits CSV preview and apply | `src/server/events/artistOrbitsCsv.ts`, `src/components/GenresPanel.tsx`, `src/services/lineupApi.ts`, `tests/artistOrbitsCsv.test.ts` |
| 43.4 | UI / VISUAL | Orbit pills and sheet | `src/components/ArtistsView.tsx`, `src/components/OrbitSheet.tsx` |
| 43.5 | CORE / DATA | Bill links maths | `src/server/events/lineupCooccur.ts`, `tests/lineupCooccur.test.ts` |
| 43.6 | CORE / DATA | Bill links job and button | `src/server/events/genreRoutes.ts`, `src/components/GenresPanel.tsx`, `src/services/lineupApi.ts`, `tests/lineupCooccurRoute.test.ts` |
| 43.7 | CORE / DATA | One step outside your lane | `src/services/genreInsights.ts`, `src/components/GenreStory.tsx`, `tests/genreInsights.test.ts` |
| 43.8 | UI / VISUAL | Constellation | `src/components/GenreConstellation.tsx`, `src/components/GenreStory.tsx` |
| 43.9 | UI / VISUAL | Docs | `docs/architecture/07-artist-genres.md`, `docs/architecture/12-data-model.md`, `ARCHITECTURE.md` |

The order is 43.5 to 43.8 first, since they need no migration, then 43.0 to 43.4 once Charlie has tapped the rule and applied 0064, then 43.9.

## 12. Not in Release 3

The following stay out of this release:

- Automatic orbit clustering (`lineup_cluster`, `hybrid`).
- Crew Overlap and Bridge Sets, which stay parked.
- `user_cooccur`.
- A scheduled run of the job.
- The artist page's Sonic DNA.
