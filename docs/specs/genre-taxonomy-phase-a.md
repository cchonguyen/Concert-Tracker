# Genre taxonomy, Phase A: the tree, ranked genres and relations

Planned 2026-11-27 from Charlie's brief "Genre Taxonomy, Visualizations & Relational Discovery" and his answers of 2026-11-27 (06:49 UTC). Phase A is the data layer that Releases 1 to 3 build on. It has one migration (0063) and three owner uploads. Slices are 39.x. The rule wording in section 9 goes in first, in Slice 39.1, once Charlie approves it.

## In plain English

- Every genre sits under one **scene family**, and every family sits under one **macro genre**. There are 8 macros and 28 families. They replace music-story's 13 groups as the top level everywhere the app totals genres.
- A genre can also belong to other families (**secondary families**). It can sit next to similar genres (**adjacent**, with a strength from 0 to 1) or come from another genre (**derived from**). These links help later releases suggest and smooth. They never add to a total.
- The owner's own genres for an artist keep their order. The first genre counts most: 1.0, then 0.70, 0.45 and 0.25, with 0.25 for each genre after the fourth. Genres from music-story and MusicBrainz keep the weights they came with.
- The owner gives the app three files: the tree, the relations and the ranked artist genres. Each upload shows a preview, saves only on Apply, is logged, and can be undone.
- Nothing here reads anyone's events. Members see the same tree and relations as everyone, and their own added genres still count only for them.

## Decisions this spec carries (Charlie, 2026-11-27)

1. 8 macros and 28 scene families replace music-story's 13 groups. A total by family or macro resolves a stored style through `genre_aliases` and then `genres.primary_parent_key` when it is read. It never uses the `parent` stored in an `artist_genres` row, and it never uses the old `genres.parent` group. This supersedes "music-story's parent groups stay the top level" in `genre-vocabulary.md`.
2. The v3 files are the source: `phase-a-taxonomy-tree-v3.csv`, `phase-a-genre-relations-v3.csv` and `phase-a-ranked-artist-genres-v3.csv`. Copies are in the project Library under `genre-taxonomy/`, not in the repository.
3. There is no `user_cooccur`. Release 3 may add a logged, undoable system job that writes `artist_cooccur` and `lineup_cooccur` rows from shared tables only, never over a `curated` row. The rule wording is in section 9.
4. Crew overlap is parked. "Who you go with, by genre" (private, already built in 38.10) stands in for it.
5. The Multi-Zoom Breakdown and Sound Drift replace the Genres ranking (38.5) and the over-the-years chart (38.8). Both slices are built, so Release 1 upgrades those screens once Phase A has merged and its files are applied. Phase A changes them only enough to show macros and families (Slice 39.8).
6. Weights and floors for the releases: each set counts 1.0, and a B2B splits it evenly across its acts. In Lineup DNA every act counts equally (1.0), with per-stage bars where `performances.stages` exist. Decay applies to owner-typed rows only. A chart needs at least 10 sets, and Event Match needs 20 sets across 5 events. Sound Drift needs 10 or more sets in each year it compares. **Open:** it needs either 3 years or 2 years of data. This spec assumes 3 until Charlie says otherwise.

## 1. What the three files hold (checked 2026-11-27)

| File | Rows | Columns | Checks |
|---|---|---|---|
| Tree | 256 genres | `genre, family, macro, tier, secondary_families, other_spellings` (lists split by `;`) | 28 families, 8 macros. Each family is in exactly one macro. Tier is `specific` (239) or `umbrella_fallback` (17). Every secondary family is a known family. No two genres share a `genreKey`. No other spelling points at a different genre. 49 other spellings fold to their own genre's key already and are skipped as redundant. |
| Relations | 589 | `source, target, type, weight, origin` | 374 `adjacent` from `artist_cooccur`, 6 `adjacent` that are `curated`, and 209 `secondary_parent` (curated, weight 1.0). Every source and target exists. The `secondary_parent` rows match the tree's `secondary_families` column exactly. No adjacent pair appears in both directions. |
| Ranked artist genres | 1,929 artists | The existing genres CSV (`Artist, MusicBrainz ID, Current genres, Source, New genres, Version (leave as it is)`) | 320 rows already have owner genres. Each artist has 1 to 4 genres, and every one is in the tree. 41 tree genres are used by no artist yet. |

Five family or macro names are spelled like a genre: House, Techno, Trance, Pop and Electronic. So families and macros get their own key space (section 2).

## 2. Storage: migration 0063

`supabase/migrations/0063_genre_taxonomy.sql`. The pull request is held until Charlie says it is applied.

```sql
-- 1. Levels in the existing vocabulary table. Families and macros are rows too.
alter table public.genres
  add column if not exists level text not null default 'genre'
    check (level in ('genre','family','macro')),
  add column if not exists primary_parent_key text
    references public.genres (key) on update cascade on delete set null,
  add column if not exists specificity_tier text
    check (specificity_tier in ('specific','umbrella_fallback')),
  add constraint genres_parent_not_self check (primary_parent_key is null or primary_parent_key <> key),
  add constraint genres_tier_only_genres check (specificity_tier is null or level = 'genre'),
  add constraint genres_key_space check (
    (level = 'genre'  and key !~ ':') or
    (level = 'family' and key ~ '^family:') or
    (level = 'macro'  and key ~ '^macro:'));
create index if not exists genres_primary_parent_idx on public.genres (primary_parent_key);

-- 2. Links beside the tree. Never counted in totals.
create table if not exists public.genre_relations (
  source_key text not null references public.genres (key) on update cascade on delete cascade,
  target_key text not null references public.genres (key) on update cascade on delete cascade,
  type text not null check (type in ('secondary_parent','adjacent','derived_from')),
  weight numeric not null check (weight > 0 and weight <= 1),
  origin text not null check (origin in ('curated','artist_cooccur','lineup_cooccur')),
  updated_at timestamptz not null default now(),
  primary key (source_key, target_key, type),
  check (source_key <> target_key)
);
create index if not exists genre_relations_target_idx on public.genre_relations (target_key);
alter table public.genre_relations enable row level security;   -- no policies: server only

-- 3. The log gains operations; images gain level, primaryParent, tier and relations.
alter table public.genre_changes drop constraint if exists genre_changes_operation_check;
alter table public.genre_changes add constraint genre_changes_operation_check check (operation in
  ('rename','alias-add','alias-remove','merge','parent','umbrella-add','umbrella-remove','spelling',
   'create','undo','taxonomy-import','relations-import','relation-add','relation-remove','relation-weight','family'));
-- 4. genre_vocabulary_images and genre_vocabulary_write are replaced so that one write also
--    replaces the listed genres' level, primary_parent_key, specificity_tier and outgoing relations.
```

- **Keys.** A genre's key stays `genreKey(name)`. A family's key is `family:` + `genreKey(name)` and a macro's is `macro:` + `genreKey(name)`. `genreKey` never makes a colon, so typed text can never hit a family or a macro.
- **Level rules, checked in code and again in `genre_vocabulary_write`.** A genre's primary parent is a family or none. A family's primary parent is a macro. A macro has none. A `secondary_parent` runs from a genre to a family. `adjacent` and `derived_from` run from a genre to a genre. Adjacent is undirected and stored once per pair, as uploaded. A second row for the reversed pair is refused. A `derived_from` chain never loops.
- **`genres.parent`** (the old group) stays in the table for undo history. Nothing reads it for totals after Slice 39.3. `genre_umbrellas` stays as it is, and "Including related genres" keeps working.
- **Log images.** `VocabGenre` gains `level`, `primaryParent?`, `tier?` and `relations: Array<{ target, type, weight, origin }>` (outgoing only). Before and after images in `genre_changes` carry them, so Undo restores the tree and the links in the same way it restores aliases today.
- **Actors.** These are `owner` for uploads and edits, and `system:<job>` for the Release 3 job. The existing actor check already allows both.

No personal fields go in any of these tables, and no member id does either.

## 3. Reading: style, then genre, then family, then macro

`resolveGenre(style, vocab, map)` in `src/server/events/genreVocabulary.ts` (pure, used by the server and the browser) returns:

```ts
type ResolvedGenre = {
  key: string; name: string;                    // as today, after aliases and merges
  family?: { key: string; name: string };       // from genres.primary_parent_key
  macro?: { key: string; name: string };        // from the family's primary_parent_key
  tier?: 'specific' | 'umbrella_fallback';
};
```

- The order is: the stored style, then `genreKey`, then alias or merge, then the genre row, then its `primary_parent_key` (the family), then that row's `primary_parent_key` (the macro).
- A genre with no family shows as `NOT_GROUPED` ("Not grouped") at both levels. The genre map's parents and the parents in stored rows are not used.
- `genreMix` totals by macro, by family and by genre from the same call. Each set adds 1.0 split by the act's weights. Secondary families, adjacent genres and `derived_from` add nothing.
- The genres response (`GET /api/artist-genres`, which carries the vocabulary) adds `levels` (families and macros with their parents) and `relations` (every row, about 600). Both are shared data with no personal fields, so members get them too. Member scoping of artist rows is unchanged: a member still gets genre rows only for acts in their own events and records.

## 4. Ranked owner genres

- An owner row's `genres` jsonb entries gain `rank` (1 is first): `[{ parent, style, weight, rank }]`. Weights come from the rank in code: 1.0, 0.70, 0.45, 0.25, and 0.25 for the fifth to the tenth (`MAX_OWN_GENRES` stays 10). They are then scaled so that they sum to 1, which the existing check needs. For 4 genres that gives 0.417, 0.292, 0.188 and 0.104.
- `normalizeGenres` sorts by `rank` when every entry has one, and otherwise by weight and then style as today. music-story, MusicBrainz and member rows have no rank and do not change.
- The owner editor in Manage keeps the order the owner typed and offers drag or up and down to reorder. The genres CSV export already lists genres heaviest first, so a download then upload keeps the order.
- In the CSV preview, a row whose genres are the same set in a new order counts as **updated** ("order changed"), not unchanged.
- Existing owner rows have no rank and keep equal weights until they are saved again. Applying the v3 ranked file re-saves all 1,929. That is one logged `artist_genre_changes` upload, undoable once, as today.

## 5. The three uploads

All three sit in Manage > Global archive > Genres, are owner only, and use the 5 MB body limit. The browser reads each file, the server returns a preview, nothing is saved until Apply, Apply writes one `genre_changes` row, and Undo reverses it.

| Upload | Route | Preview shows | Refuses |
|---|---|---|---|
| Tree (extends the vocabulary CSV from 37.6) | `POST /api/artist-genres/vocabulary/csv/preview` and `/apply`; the new columns are detected from the header | Macros, families and genres created, moved or unchanged; tier changes; aliases added or skipped (with the reason); secondary families added or removed; stored genres on artists that would have no family afterwards | A family in two macros; an unknown secondary family; a spelling that belongs to another genre; a level rule broken |
| Relations | `POST /api/artist-genres/relations/csv/preview` and `/apply` (registered before `/artist-genres/:key`) | Added, removed, changed weight, unchanged; by type and origin | An unknown source or target; a weight outside (0, 1]; origin `lineup_cooccur` (reserved for the system job); a reversed adjacent duplicate; a `secondary_parent` that disagrees with the tree |
| Ranked artist genres | The existing genres CSV routes | As today, plus "order changed" | As today |

The relations file **replaces** the rows of each type and origin it contains. A file with only `adjacent` rows from `artist_cooccur` leaves the curated rows and the secondary families as they are. Apply the files in this order: the tree, then the relations, then the ranked artist genres. The ranked file can also go first, since rank needs no migration.

## 6. Manage > Genres changes

- The Group menu becomes a **Family** menu listing the 28 families by macro. "Not grouped" clears it.
- A genre record shows its tier, its family and macro, its secondary families, and its adjacent and derived-from links with weights. The owner can add, remove or reweigh a link, and each change is logged and undoable.
- Family and macro records list their genres and the artists behind them. They can be renamed but not merged with a genre.

## 7. What changes on Explore in Phase A (Slice 39.8)

Phase A changes only the labels and levels. Every screen that shows a "group" today shows the **macro**. Where a second level fits, it shows the **family**. This covers the Stats genre card, Ranking > Genres (the Genre column becomes Macro and Family), the family tree (macro, then family, then genre), the River colour legend, the Map genre picker, the Year in genres card and the People ranking's top two. The tests for `genreInsights.ts` move from parent groups to macros. New pictures, such as the Multi-Zoom Breakdown, Sound Drift, Lineup DNA and orbits, wait for Releases 1 to 3.

## 8. Slices

Each slice gets its issue when it starts. Slices 39.2 and 39.4 to 39.9 merge only after Charlie says 0063 is applied. Slices 39.3 and 39.5 need no migration.

- **39.1 Rule wording** [CORE / DATA, red tripwire]: AGENTS.md, REQUIREMENTS.md, ARCHITECTURE.md, and a note in `genre-vocabulary.md` that decision 1 supersedes its top-level groups. The exact text is in section 9.
- **39.2 Migration 0063** [CORE / DATA, red migration]: Target files are `supabase/migrations/0063_genre_taxonomy.sql` and `tests/migration0063.test.ts`. The tests cover the key space, level checks, relation checks, the extended images and an undo of a taxonomy import.
- **39.3 Resolver and validation** [CORE / DATA]: Target files are `genreTypes.ts`, `genreVocabulary.ts`, `tests/genreVocabulary.test.ts` and `tests/genreTaxonomy.test.ts`. The resolver gives family and macro, and the level and relation rules are pure functions. A test proves the stored `parent` is ignored.
- **39.4 Store and payload** [CORE / DATA]: Target files are `store/types.ts`, `supabaseStore.ts`, `fileStore.ts`, `genreRoutes.ts` and `tests/genreVocabularyRoute.test.ts`. The write carries levels and relations, and the genres response adds `levels` and `relations`. A test confirms that a member gets the same `levels` and `relations` and no extra artist rows.
- **39.5 Ranked owner genres** [CORE / DATA]: Target files are `genres.ts`, `genreCsv.ts`, `genreCsvApply.ts`, `ArtistGenresEditor.tsx`, `tests/genres.test.ts` and `tests/genreCsvApply.test.ts`. It adds rank, decay weights, the reorder control and "order changed".
- **39.6 Tree upload** [CORE / DATA]: Target files are `genreVocabCsv.ts`, `genreVocabularyManage.ts`, `GenresPanel.tsx` and `tests/genreVocabCsv.test.ts`. It includes a fixture cut from the v3 tree.
- **39.7 Relations upload** [CORE / DATA]: Target files are `src/server/events/genreRelationsCsv.ts`, `genreRoutes.ts`, `src/server/app.ts`, `lineupApi.ts`, `GenresPanel.tsx` and `tests/genreRelationsCsv.test.ts`.
- **39.8 Explore shows macros and families** [CORE / DATA]: Target files are `src/services/genres.ts`, `src/services/genreInsights.ts`, `tests/genreInsights.test.ts` and the screens in section 7. A test proves that umbrellas and secondary families never change a total.
- **39.9 Manage genre records** [UI / VISUAL]: Target files are `GenreRecord.tsx` and `GenresPanel.tsx` (the Family menu, the links, and the family and macro records).
- **39.10 Docs** [UI / VISUAL]: Target files are `docs/architecture/07-artist-genres.md`, `12-data-model.md` and `13-api.md`. It also removes the "being built" note.

## 9. Exact rule wording (Slice 39.1, needs Charlie's OK)

AGENTS.md says to change REQUIREMENTS.md or ARCHITECTURE.md first and say why. The reason: on 2026-11-27 Charlie approved a three-level genre tree that replaces music-story's groups, ranked owner genres, and genre relations that a later system job may compute from shared data.

**AGENTS.md**, at the end of the artist genres bullet (after "an umbrella never adds a genre to an act."), add:

> Genre taxonomy (approved 2026-11-27, `docs/specs/genre-taxonomy-phase-a.md`): the owner's vocabulary puts each genre under one scene family and each family under one macro genre. These replace music-story's groups as the top level. A total by family or macro resolves a stored style through its alias to the genre's `primary_parent_key` when it is read, never through a stored `parent`. The owner's own genres are ranked: their order sets their weights (1.0, 0.70, 0.45, 0.25, then 0.25), and music-story and MusicBrainz weights stay as sent. Secondary families, adjacent genres and derived-from links live in `genre_relations`, never add to a total, change only through `writeGenreVocabulary`, are recorded in `genre_changes` and can be undone. Rows with origin `curated` are the owner's. A logged, undoable system job may write `artist_cooccur` and `lineup_cooccur` rows computed only from shared tables (`artist_genres`, `performances`), never over a `curated` row. No relation is computed from any member's events, attendance or companions.

**REQUIREMENTS.md**, Scope, after "so the owner can set shared genres for them.", add:

> Genre relations (approved 2026-11-27) are computed only from shared lineups and shared artist genres, never from any member's events, so nothing about who went where reaches them.

**ARCHITECTURE.md**, in the genres paragraph, change "holds shown spellings, groups, aliases, merges and umbrella genres" to "holds shown spellings, families, aliases, merges and umbrella genres", and add at the end:

> Genre taxonomy (approved 2026-11-27; see `docs/specs/genre-taxonomy-phase-a.md` (link it there), migration 0063, being built in Slices 39.2 to 39.10): macros and scene families are rows in `genres` (`level`, `primary_parent_key`, `specificity_tier`). Totals resolve a style through its alias to its family and macro when read. `genre_relations` holds secondary families, adjacent and derived-from links, uploaded by the owner, logged in `genre_changes` and undoable. The owner's genres keep their order and are weighted by rank.

## 10. Red tripwires

- **Red, rules:** Slice 39.1 edits AGENTS.md, REQUIREMENTS.md and ARCHITECTURE.md. It needs Charlie's OK on a card that names those files, and the commit carries `Approved-Tripwire:`.
- **Red, migration:** Slice 39.2 adds 0063 and is held until Charlie says it is applied.
- **Privacy:** Slice 39.4 sends `levels` and `relations` to members. They hold no personal fields. A test proves that a member's artist rows are scoped as before.

## Not in scope (later releases)

- **Release 1 (personal and artist):** Multi-Zoom Breakdown (replacing 38.5's table), Sound Drift (replacing 38.8's chart), and the B2B split. It uses the floors in decision 6.
- **Release 2 (events):** Lineup DNA with per-stage bars, and Event Match. It uses 1-hop smoothing over `adjacent`, with hub dampening.
- **Release 3 (orbits):** genre orbits, and the co-occurrence system job.
- Parked: crew overlap, `user_cooccur`, and suggestions from anything other than shared lineups.
