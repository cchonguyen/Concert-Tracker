# Genre taxonomy, Release 1: Multi-Zoom Breakdown and Sound Drift

Planned 2026-11-27, after Phase A ([genre-taxonomy-phase-a.md](genre-taxonomy-phase-a.md)) merged and its files were applied. It follows Charlie's brief "Genre Taxonomy, Visualizations & Relational Discovery" and decisions 5 and 6 of the Phase A spec. Slices are 40.x. There is no migration, and everything is worked out in the browser from data each person already gets.

## In plain English

- **Multi-Zoom Breakdown** replaces the Genre, Family and Style columns in Ranking > Genres. It opens on your scene families. You can zoom out to macro genres, or tap a family to open the genres inside it. Each level adds up to 100% of the sets that have a genre. Sets with no genre are not spread over the others: a quiet note under the chart says how many there were.
- **Sound Drift** replaces the "Over the years" chart in Your genre story. It shows how your mix of families (or macros) moved from year to year, each year scaled to 100%. Tap a band or a year to see the sets and artists that made it.
- **B2B split**: a B2B is one set, so its acts share 1.0 between them instead of counting 1.0 each. This applies to every genre total on Explore.
- Floors: a chart needs at least 10 sets with a genre. Sound Drift compares only years with 10 or more such sets, and it shows only when there are at least 3 of those years. Below a floor, the screen says what is missing in plain words.
- Nothing new is stored and nothing reads anyone else's events. A member's own added genres still count only on their own screens.

## Decisions this spec carries

1. Weights: each set counts 1.0. An act's share of it is split across the act's genres by their weights: the owner's ranked genres use the decay from Phase A (1.0, 0.70, 0.45, 0.25, then 0.25, scaled to add up to 1), and music-story and MusicBrainz rows keep their own weights (Charlie, 2026-11-27).
2. B2B: the acts in one B2B share one set evenly. Two acts get 0.5 each, three get a third. An act you also saw play on its own at the same event (`solo`) gets a further 1.0 for that set (Charlie, 2026-11-27).
3. Levels come only from the vocabulary's `primary_parent_key` links, read at view time (Phase A decision 1). A genre with no family counts under "Not grouped" at the family level and the macro level.
4. Relations (`genre_relations`) never add to these totals. Release 2 uses them for smoothing.
5. Floors are the Phase A ones: 10 sets for a chart, 10 sets per compared year and 3 such years for Sound Drift.
6. Proposed here: the genre level inside an opened family shows each genre's share of all sets with a genre, so the genres add up to the family's figure. The family's own total stays on its row.
7. Proposed here: Sound Drift works by calendar year. Seasons stay on the "kind of night and season" tiles that 38.8 already built.

## 1. B2B split (Slice 40.1)

- One helper, `setShares(event)` in `src/services/genres.ts`, gives each seen act its share of a set at that event: 1.0 for a solo set, `1 / n` for each of the `n` acts in a B2B (the act plus the partners in its `b2b` list who are also in that event's seen list), plus 1.0 when `solo` is set.
- `genreMix` and every count in `src/services/genreInsights.ts` that loops over seen acts use it, so set counts can be fractions. Screens round them for display ("12.5 sets" shows as "12½ sets" or "13 sets": the slice picks one and uses it everywhere).
- Floors compare the fractional total.

## 2. Multi-Zoom maths (Slice 40.2)

`genreZoom(events, byArtist, vocab)` in `genreInsights.ts` returns, for the events given (the period picker stays):

- `macros`, `families` and `genres`, each a list of `{ key, name, sets, share, parent? }` sorted by sets, where `share` is of all sets with a genre and each list adds up to 1.
- each family row's genres (`children`), and each macro row's families.
- `known` (sets with a genre), `unknown` (sets without one) and `enough` (`known >= 10`).
- Without a taxonomy in the vocabulary (sample mode, or before the tree is uploaded) it falls back to the music-story groups as one level, as today.

## 3. Multi-Zoom Breakdown screen (Slice 40.3)

In Ranking > Genres (`src/components/GenresRanking.tsx`):

- A level switch: **Macro**, **Family** (the default) and **Genre**, using the shared `Segmented` control.
- One horizontal 100% bar for the level, then the ranked list with share and set count. At the Family level each row opens to its genres. Tapping a row's name shows the artists behind it (the existing `artistsBehind` list).
- Under the list: "N sets had no genre and are not counted." when `unknown > 0`.
- Under the floor: "Genres show once you have 10 sets with a genre. You have N." No chart.
- The List or Tree switch (38.13) and "Including related genres" stay as they are.

## 4. Sound Drift maths (Slice 40.4)

`soundDrift(events, byArtist, vocab, level, today)` in `genreInsights.ts`, with `level` `family` (default) or `macro`:

- Per calendar year: sets with a genre, whether the year is counted (10 or more), and each band's share of that year (adding up to 1).
- Bands: the 6 largest families (or macros) across counted years, plus "Other".
- `enough`: at least 3 counted years.
- `leaders`: the leading band of each counted year, with repeats in a row merged, for a line such as "Progressive House, then Melodic Bass, then Tech House".
- `drivers(year, band)`: the sets in that year and band, each with event, date, act and its share, and the artists ranked by sets. Everything comes from the person's own events.

## 5. Sound Drift screen (Slice 40.5)

In Your genre story (`src/components/GenreYearsChart.tsx`, used by `GenreStory.tsx`):

- A stacked 100% area chart by year in SVG, with a Family or Macro switch. Years under 10 sets are drawn faded and are not part of the leaders line.
- Tapping a band or a year opens a panel listing the sets and artists behind it (from `drivers`). Tapping again or pressing Escape closes it.
- A table with the same numbers for screen readers, as 38.8 has today.
- Under the floor: "Sound Drift needs 3 years with at least 10 sets that have a genre. You have N." No chart.
- Colours come from the design tokens and are the same per band on every Explore screen that colours genres (River legend, Map picker).

## 6. Loose ends from Phase A (Slice 40.6)

- The "Create genre" form in Manage > Genres offers the Family menu (by macro) instead of music-story's old groups.
- Undo of a genre change refuses when that genre's links changed after the change, as it already does for its name, aliases and umbrellas.

## 7. Docs (Slice 40.7)

`docs/architecture/07-artist-genres.md` (Explore section), `ARCHITECTURE.md` (Explore line), and a note in `docs/specs/genre-explore.md` that 38.5's table and 38.8's chart were replaced here.

## 8. Slices

| Slice | Tag | What | Target files |
|---|---|---|---|
| 40.1 | CORE / DATA | B2B split in every genre total | `src/services/genres.ts`, `src/services/genreInsights.ts`, `src/services/insights.ts`, `tests/genreInsights.test.ts`, `tests/genres.test.ts` |
| 40.2 | CORE / DATA | Multi-Zoom maths | `src/services/genreInsights.ts`, `tests/genreInsights.test.ts` |
| 40.3 | UI / VISUAL | Multi-Zoom Breakdown in Ranking > Genres | `src/components/GenresRanking.tsx` |
| 40.4 | CORE / DATA | Sound Drift maths | `src/services/genreInsights.ts`, `tests/genreInsights.test.ts` |
| 40.5 | UI / VISUAL | Sound Drift chart and drivers panel | `src/components/GenreYearsChart.tsx`, `src/components/GenreStory.tsx` |
| 40.6 | CORE / DATA | Create genre with a family; undo checks links | `src/components/GenresPanel.tsx`, `src/server/events/genreVocabularyManage.ts`, `tests/genreVocabularyManage.test.ts` |
| 40.7 | UI / VISUAL | Docs | `docs/architecture/07-artist-genres.md`, `ARCHITECTURE.md`, `docs/specs/genre-explore.md` |

No slice touches AGENTS.md, REQUIREMENTS.md, a migration or a shared table.

## 9. Not in Release 1

Lineup DNA and Event Match (Release 2), genre orbits and the co-occurrence job (Release 3), the artist page's Sonic DNA and "Shares a lane with" rail, and crew overlap (parked).
