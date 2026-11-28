# Genre vocabulary: one spelling per genre, aliases, merges and umbrella genres

**Archived (2026-11-28):** Built and shipped.

Status: draft written 2026-11-26 for Charlie's review. Not approved. Replaces the old planned Slice 35.13. Slices 36.1 to 36.12 below. Needs migration `0060_genre_vocabulary.sql`; Charlie applies it, and the slices that need it are held until he says it is applied.

Builds on `docs/specs/canonical-genres.md` (shared genres, `artist_genres`, `artist_genre_changes`, `writeArtistGenres`).

## Charlie's requirements (2026-11-26)

1. "electro house", "electrohouse" and "electro-house" are the same genre. Stats on the genres a person likes, saw recently and is trending toward must be accurate.
2. A Genres tab in Manage, where the owner can add aliases for a genre or merge two genres, the same way series and editions work today.
3. Related genres: the owner can put "electro house" and "tech house" under a "house" umbrella, or "melodic dubstep" and "future bass" under "melodic bass".

Decided by Charlie: a genre may sit under several umbrellas. music-story's parent groups (13 today) stay the top level, and the owner can override a genre's group. (Superseded 2026-11-27: 8 macro genres and 28 scene families replace music-story's groups as the top level; see [genre-taxonomy-phase-a.md](../specs/genre-taxonomy-phase-a.md).)

## In plain English

- **Spellings that differ only in capitals, spaces, hyphens or punctuation are one genre.** The app works this out in code. It shows one spelling everywhere. This needs no migration and ships first.
- **It never joins different words on its own.** "drum and bass" and "drum & bass", "dnb", "hip hop" and "rap", "house" and "houses" stay apart until the owner says they are the same.
- **The owner gets a Genres tab** in Manage, Global archive. It lists every genre with how many artists have it. The owner can rename a genre, add other spellings (aliases), merge one genre into another (with a preview first), change its group, and put it under umbrella genres. Every change is written down and can be undone, like series.
- **Where two spellings fold together, the tab lists them** so the owner can pick the spelling to show. Until he picks, the app picks by a fixed rule.
- **Umbrellas never add a genre to an artist.** An artist tagged "tech house" still shows "tech house". Stats gain a third list, "Including related genres", where "house" counts every set whose act has a genre under it, once per set.
- **Members change nothing.** They see the same spellings. Genres they add themselves are matched through the owner's aliases.
- **The genres file follows the aliases.** An upload that says "Electro-House" is saved as "electro house", and the preview says so.

## Rules this feature keeps

- No model call and no inferred genre. Folding spellings is not inference: it is a fixed rule in code over the same letters. An umbrella is the owner's grouping, not a genre of the act.
- Stored genres are never rewritten by a merge or an alias (section 4). What music-story, MusicBrainz or the owner gave stays as given.
- Shared tables hold no personal fields. The vocabulary tables hold genre names, keys, groups, links, an actor (`owner` or `system:<job>`), a reason and a time. No user id, event, date seen, companion, note, rating, price or attendance. Members' own additions never enter the vocabulary, the collision list or the counts.
- No hardcoded genre list. The groups come from the genre map music-story sent (`app_settings` `genre_map`), not from code.

## 1. The loose-match key

One pure function, `genreKey(style: string): string`, in `src/server/events/genreVocabulary.ts` (free of server imports, so the browser uses it too, like `genreTypes.ts`).

Steps, in order:

1. Unicode NFKD, then drop combining marks (so "électro" and "electro" match).
2. Lower case.
3. Every character that is not a letter or a digit is removed: spaces, hyphens, underscores, dots, slashes, apostrophes, `&`, `+`, brackets.
4. What is left is the key. A style with no letter or digit (for example "!!!" or "-") is refused where it is typed, with "A genre needs a letter or a number."

Examples:

| Typed | Key | Same genre as |
| --- | --- | --- |
| electro house, Electro-House, electrohouse, electro_house | `electrohouse` | each other |
| hip hop, Hip-Hop, hiphop | `hiphop` | each other |
| R&B, r & b | `rb` | each other, but not "rnb" |
| drum and bass / drum & bass / dnb | `drumandbass` / `drumbass` / `dnb` | none of the others |
| 2-step, 2 step | `2step` | each other |
| house / houses | `house` / `houses` | not each other |

What it never does: stem or singularize words, drop words ("music", "the", "and"), reorder words, turn `&` or `+` into "and", expand abbreviations, or match by closeness or spelling distance. Those joins are the owner's, as aliases.

Today the code compares genres by `trim().toLowerCase()` in `knownGenres`, `knownGenreMap`, `typedGenreRow` and `withAdditions`. Each moves to `genreKey`.

## 2. The vocabulary: what is stored

The vocabulary holds only the owner's decisions. A genre nobody has changed needs no row: it resolves to itself by its key. This keeps the tables small and means a new music-story upload needs no sync step.

Migration `0060_genre_vocabulary.sql` (Slice 36.4 writes it with a check query and a rollback; Charlie applies it):

```sql
-- 0060 genre vocabulary (docs/archive/genre-vocabulary.md). Apply only on Charlie's go.
-- The owner's genre decisions: shown spelling, group, other spellings, umbrellas.
-- No personal fields. Server only: no policies, writes through one function.

create table if not exists public.genres (
  key text primary key,                 -- genreKey(name), checked in code
  name text not null,                   -- the spelling shown everywhere
  parent text,                          -- the owner's group; null: from the genre map
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.genre_aliases (
  alias_key text primary key,           -- genreKey of the other spelling
  alias text not null,                  -- the spelling as typed
  genre_key text not null references public.genres (key) on update cascade on delete cascade
);

-- Umbrellas: many to many. "tech house" (genre_key) sits under "house" (umbrella_key).
create table if not exists public.genre_umbrellas (
  genre_key text not null references public.genres (key) on update cascade on delete cascade,
  umbrella_key text not null references public.genres (key) on update cascade on delete cascade,
  primary key (genre_key, umbrella_key),
  check (genre_key <> umbrella_key)
);
create index if not exists genre_umbrellas_umbrella_idx on public.genre_umbrellas (umbrella_key);

-- Every change: the genres it touched as they were and as they became.
create table if not exists public.genre_changes (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  actor text not null check (actor = 'owner' or actor like 'system:%'),
  operation text not null check (operation in ('rename','alias-add','alias-remove','merge','parent','umbrella-add','umbrella-remove','spelling','create','undo')),
  reason text not null,
  summary text not null,                -- "electro-house merged into electro house"
  before jsonb not null,                -- [{ key, name, parent, aliases[], umbrellas[] }] (empty array: none)
  after jsonb not null,
  undone_at timestamptz
);
create index if not exists genre_changes_at_idx on public.genre_changes (at desc);
-- Append-only trigger: same shape as artist_genre_changes (0059): no delete; only undone_at may be set, once.

alter table public.genres enable row level security;
alter table public.genre_aliases enable row level security;
alter table public.genre_umbrellas enable row level security;
alter table public.genre_changes enable row level security;
revoke all on public.genres, public.genre_aliases, public.genre_umbrellas, public.genre_changes from anon, authenticated;

-- One write: replace the listed genres' rows (name, parent, aliases, umbrellas) with
-- the 'after' images, delete those with no image, and log one change, in one transaction.
-- p_after: [{ key, image: { name, parent, aliases: [{alias_key, alias}], umbrellas: [key] } | null }]
create or replace function public.genre_vocabulary_write(
  p_after jsonb, p_operation text, p_actor text, p_reason text, p_summary text)
returns public.genre_changes
language plpgsql security definer set search_path = public, pg_temp as $$ ... $$;
revoke all on function public.genre_vocabulary_write(jsonb, text, text, text, text) from public, anon, authenticated;
grant execute on function public.genre_vocabulary_write(jsonb, text, text, text, text) to service_role;
```

The function reads the `before` images itself (with `for update`), so the log is always what was really there. It refuses an alias key that is already a genre key, a cycle in the umbrella links (it walks up from each new link), and an umbrella link to a genre that does not exist. The migration test (`tests/migration0060.test.ts`) checks: append-only trigger, the function is `security definer` with execute revoked from `anon` and `authenticated`, RLS on with no policies, and no column named `user_id`, `event_id` or any personal field.

### Store contract (`LineupStore`, `store/types.ts`)

- `getGenreVocabulary(): Promise<GenreVocabulary>`: every scope reads it through the service client (it holds no personal fields). `GenreVocabulary = { genres: VocabGenre[] }`, `VocabGenre = { key, name, parent?, aliases: Array<{ key, alias }>, umbrellas: string[] }`.
- `writeGenreVocabulary(after: Array<{ key; image: VocabGenre | null }>, meta: { operation; actor: 'owner' | \`system:${string}\`; reason; summary }): Promise<GenreVocabChange>`: refused in a member scope.
- `listGenreVocabChanges({ limit? })` and `markGenreVocabChangesUndone(ids, at)`: owner and system only.
- File store: the same in memory.

`GenreVocabulary`, `VocabGenre` and `GenreVocabChange` go in `genreTypes.ts`.

## 3. Resolving a genre

`resolveGenre(style, vocab, map)` (pure, `genreVocabulary.ts`) gives `{ key, name, parent }` for any stored or typed spelling:

1. `k = genreKey(style)`.
2. If `k` is a genre's key, that genre. If `k` is an alias key, the genre it points to.
3. Otherwise the genre is `k` itself, with no vocabulary row.

**Shown spelling** for a genre with no chosen spelling, in this order: the genre map's spelling for that key, then the spelling on the most shared rows (`artist_genres`), then the first alphabetically. A member's own additions never count here.

**Group (parent)**, in this order: the owner's `parent` on the genre; the genre map's parent for that key; the parent most used on shared rows for that key, if it is one of the map's groups; otherwise none, shown as "Not grouped". The groups are the distinct `parent` values of the genre map. Today a genre the owner made up is its own parent, so it shows as a group of its own in stats. After this change it shows as "Not grouped" until the owner gives it a group (see Open question 1).

**Inside one act:** after resolving, two styles with the same genre become one, with their weights added. So an act with "electro house" 0.5 and "Electro-House" 0.5 has "electro house" 1.0. Weights still sum to 1.

## 4. Stored rows: resolve when reading, do not rewrite

Two ways to make old `artist_genres` rows follow a merge:

- **A. Rewrite the stored styles** on every merge, alias and rename, through `writeArtistGenres` with actor `system:genre-merge`.
- **B. Store what the source gave, and resolve when reading.** (Recommended.)

Why B:

- music-story and MusicBrainz send their own spellings again on every upload or lookup. Under A each upload would bring "Electro-House" back until the next rewrite. Under B it resolves the same way every time.
- Undo of a merge is one vocabulary change. Under A it would also have to undo hundreds of artist rows, each with a changed-since check that a later upload breaks.
- The artist change log stays about artists. A merge does not flood `artist_genre_changes`.
- Members' additions resolve the same way, with no write to their personal rows.

The cost of B: every reader must resolve. So there is one resolver, used in one place on each side:

- Browser: `genresByArtist(rows, vocab, map)` in `src/services/genres.ts` resolves every style before ranking and before adding a member's additions. Every screen and `genreMix` read from it, so they all agree.
- Server: `knownGenres`, `knownGenreMap` and `typedGenreRow` (`genres.ts`) resolve, and the genres file export and preview use the resolved names.

New typed values are stored resolved: when the owner or a member types "electrohouse", or a genres file says it, the row stores "electro house" and its group. That is a choice of spelling at the moment of typing, not a rewrite.

`GET /api/artist-genres` adds `vocabulary` (every scope) and `map` (the genre map, now for members too; this closes the known gap in `.spec/SESSION_HANDOFF.md` where a member's typed genre kept its own capitals).

## 5. Collisions for the owner to pick

`genreCollisions(rows, vocab, map)` (pure) lists every key that has two or more different spellings on shared rows or in the genre map, and no chosen spelling yet. Each item shows the spellings, how many artists use each, and the one shown today. "Use this spelling" saves a `genres` row with that name (operation `spelling`, actor `owner`), and the item leaves the list.

It never lists different keys that look alike. That is the owner's job, with aliases.

## 6. Manage > Global archive > Genres

A new tab in the Global archive tabs (`ARCHIVE_TABS` in `ManageView.tsx`), after Brands: "Genres". The Global archive is owner-only today, so the tab is too. Members never see it.

**The list** (`GenresPanel.tsx`):

- One row per genre: the shown spelling, its group, its umbrellas, and "N artists" (shared rows only, after resolving).
- Search by name or alias. Filter by group, and "Not grouped".
- At the top, when there are any: "N genres have more than one spelling. Pick one." It opens the collision list (section 5).
- "New genre": a name and a group. For an umbrella that no artist has yet, such as "melodic bass".

**A genre's record** (`GenreRecord.tsx`), opened from the list:

- **Name.** Rename changes the shown spelling everywhere. The old spelling becomes an alias, as with series. A new name whose key is another genre's is refused with "That is already a genre: <name>. Merge instead."
- **Other spellings (aliases).** Add one; remove one. An alias whose key is a genre or another genre's alias is refused with the same "Merge instead" line. The list also shows, greyed, the spellings folded in by the key, with the note "Same letters; joined on its own."
- **Group.** A menu of the genre map's groups, plus "From music-story" (clears the owner's choice).
- **Under these umbrellas.** Add or remove umbrella genres (a search box over the list). **Genres under this one.** Read-only list of the genres that point here, each a link. A link that would make a loop is refused with "That would put <name> under itself."
- **Merge into another genre.** Pick the genre to keep. The preview shows: how many artists move, the spellings that become aliases of the kept genre, the umbrella links that move, and any that are dropped because they would point at themselves. Then "Merge". The merged genre's spelling and aliases become aliases of the kept one; its umbrellas and the genres under it move to the kept one; the kept genre keeps its own group.
- **History.** Every change to this genre, newest first, with "Undo" on the newest one not undone. Undo is refused with "Those genres changed after this. Undo the later change first." when the current rows no longer equal the change's `after`, as for series.

After each change a notice shows the summary and "Undo", like the series and brands tabs (`CanonicalArchive.tsx`).

Server side (`src/server/events/genreVocabularyManage.ts`): `createGenre`, `renameGenre`, `addGenreAlias`, `removeGenreAlias`, `planGenreMerge`, `mergeGenres`, `setGenreParent`, `addGenreUmbrella`, `removeGenreUmbrella`, `pickGenreSpelling`, `undoGenreChange`. Each builds the `after` images and calls `writeGenreVocabulary` with actor `owner`. A genre with no vocabulary row gets one the first time the owner changes it.

Routes, all in `genreRoutes.ts`:

- `GET /api/artist-genres` adds `vocabulary`, `map`, and for the owner only `vocabularyChanges` (latest 100) and `collisions`.
- `POST /api/artist-genres/vocabulary/<operation>` for every write, and `POST /api/artist-genres/vocabulary/undo/:id`.

Every write is a POST under `/api/artist-genres/`, which `OWNER_ONLY` in `requestScope.ts` already covers (`['POST', /^\/api\/artist-genres\//]`). So the auth file does not change. Slice 36.7's route tests prove a member gets 403 on each.

## 7. Stats: umbrellas without double counting

`genreMix` (`src/services/genres.ts`) keeps its two lists and adds a third:

- **Genre** (groups): unchanged rule, now over resolved groups. Each set is split across its act's genres by weight, so the bars add up to 100% of sets with a genre. "Not grouped" is a bar when it has sets.
- **Style**: over resolved genres. "electro house" and "Electro-House" are one bar.
- **Including related genres** (new, `umbrellas`): for each umbrella, the share of sets whose act has the umbrella itself or any genre under it, at any depth. Per set, an umbrella gets the sum of the weights of the act's genres that fall under it, each genre counted once even when it reaches the umbrella by two paths. So it is never more than one set. Example: an act with "tech house" 0.5 and "electro house" 0.5 adds 1 set to "house", not 2. A genre under two umbrellas counts in both, so this list does not add up to 100%. Its heading says so: "A set counts once under each umbrella it falls in."

The same rule serves "seen recently" and trends: StatsView already filters events by year before calling `genreMix`.

The Artists filter (`ArtistsView.tsx`) gains umbrellas: picking "house" shows artists with house or any genre under it. An artist's pills still show only its own genres.

## 8. Members

- They read the vocabulary and the map with their genre rows. They cannot write it (403).
- Their own additions resolve through the same aliases at read time. When they type a genre, it is stored in the resolved spelling.
- Their additions never reach the collision list, the counts in the Genres tab, the vocabulary or its log.

## 9. The genres file

- **Export:** the Genres column lists resolved names. The version stamp (`genreStamp`) is computed over resolved rows, so an alias or merge made after download does make the row stale (the owner sees "changed since" and can tick "Replace anyway"), and a pure re-spelling of the same key does not.
- **Preview and Apply:** each typed genre resolves. The preview shows "Electro-House → electro house" on the row. A row whose genres, resolved, equal the current ones is "No change".
- **music-story upload** is unchanged: its rows are stored as sent and resolved when read.

## 10. Red tripwires

- **Red, migration:** Slice 36.4 adds `supabase/migrations/0060_genre_vocabulary.sql`. Its pull request is held until Charlie says 0060 is applied. Slices 36.5 onward call the new tables or function, so they merge only after that.
- **Auth:** no change (section 6). If review moves the routes out of `/api/artist-genres/`, `requestScope.ts` becomes a red tripwire for that slice.
- **AGENTS.md:** the genre rule gains one sentence (Slice 36.1, before any code):

  > Genre spellings that differ only in capitals, accents, spaces, hyphens or punctuation are one genre (`genreKey`, `src/server/events/genreVocabulary.ts`); code never joins different words, stems or drops words. The owner's genre vocabulary (shown spelling, group, aliases, merges, umbrella genres) is shared, holds no personal fields, is changed only by the owner through `writeGenreVocabulary`, is recorded in `genre_changes` and can be undone. Stored genres are resolved through it when read, never rewritten by it, and an umbrella never adds a genre to an act.

- **REQUIREMENTS.md:** no requirement changes. ARCHITECTURE.md's genres line and `docs/architecture/07-artist-genres.md` are updated (36.1 marks "being built", 36.12 removes the note).

## 11. Slices

Issues not yet opened: add `Issue: #N` before starting each slice. RED = red tripwire.

- [ ] **Slice 36.1: Rule wording for the genre vocabulary** [UI / VISUAL] Docs only: the AGENTS.md sentence from spec section 10 (why: Charlie's 2026-11-26 requirements); ARCHITECTURE.md genres line and 07-artist-genres.md marked "being built in 36.2 to 36.12". Target files: AGENTS.md, ARCHITECTURE.md, docs/architecture/07-artist-genres.md | Coords: [400, 07-artist-genres] | Verify: npm run lint --silent
- [ ] **Slice 36.2: Loose-match key and resolver (pure)** [CORE / DATA] `genreKey` exactly as spec section 1 (table of examples as tests, including the "never joins" rows); `resolveGenre`, shown-spelling and group order (section 3); umbrella closure with loop check; `genreCollisions` (section 5); vocabulary types in genreTypes.ts. No store, no migration. Target files: src/server/events/genreVocabulary.ts, src/server/events/genreTypes.ts, tests/genreVocabulary.test.ts | Coords: [400, 07-artist-genres] | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 36.3: Spellings fold everywhere (works with an empty vocabulary)** [CORE / DATA] `genresByArtist` resolves styles and adds weights of the same genre in one act; `withAdditions` dedupes by key; `knownGenres`, `knownGenreMap`, `typedGenreRow` compare by `genreKey` and store the resolved spelling; a style with no letter or digit refused; `genreMix` over resolved groups with "Not grouped". Ships before 0060: requirement 1 is met here. Target files: src/services/genres.ts, src/server/events/genres.ts, tests/genres.test.ts | Coords: [400, 07-artist-genres] | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 36.4: Migration 0060 genre vocabulary (RED: migration; PR held until Charlie says applied)** [CORE / DATA] The SQL in spec section 2 with the full write function, append-only trigger, check query and rollback; static test: RLS on with no policies, function security definer with execute revoked from anon and authenticated, loop and alias-key refusals present, no personal columns. Target files: supabase/migrations/0060_genre_vocabulary.sql, tests/migration0060.test.ts, docs/architecture/12-data-model.md | Coords: [400, 12-data-model, supabase/migrations/0059_canonical_genres.sql] | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 36.5: Store: read and write the vocabulary** [CORE / DATA] `getGenreVocabulary` (every scope, service client), `writeGenreVocabulary` (rpc `genre_vocabulary_write`), `listGenreVocabChanges`, `markGenreVocabChangesUndone`, the last three refused in a member scope; file store parity. Needs 0060 applied. Target files: src/server/lineup/store/types.ts, src/server/lineup/store/supabaseStore.ts, src/server/lineup/store/fileStore.ts, tests/genreVocabularyStore.test.ts | Coords: [400, 12-data-model, 19-multi-user] | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 36.6: Owner operations on genres** [CORE / DATA] `createGenre`, `renameGenre` (old spelling becomes an alias), `addGenreAlias`/`removeGenreAlias` ("Merge instead" refusals), `planGenreMerge` (preview counts, aliases, moved and dropped umbrella links) and `mergeGenres`, `setGenreParent`, `addGenreUmbrella`/`removeGenreUmbrella` (loop refused), `pickGenreSpelling`, `undoGenreChange` with the changed-since check; all actor `owner`. Target files: src/server/events/genreVocabularyManage.ts, tests/genreVocabularyManage.test.ts | Coords: [400, 07-artist-genres, src/server/entities/canonicalManage.ts] | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 36.7: Routes and client calls** [CORE / DATA] `GET /api/artist-genres` adds `vocabulary` and `map` (every scope) and `vocabularyChanges` and `collisions` (owner only); `POST /api/artist-genres/vocabulary/<operation>` and `/vocabulary/undo/:id`; route tests: a member gets 403 on every write, a member's response holds no change log or collisions; `genresApi` vocabulary calls. Target files: src/server/events/genreRoutes.ts, tests/genreVocabularyRoute.test.ts, src/services/lineupApi.ts | Coords: [400, 13-api, 19-multi-user] | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 36.8: Genres file resolves aliases** [CORE / DATA] Export lists resolved names; `genreStamp` over resolved rows; preview resolves each typed genre and shows "typed → stored"; a row equal after resolving is "No change". Target files: src/server/events/genreCsv.ts, src/server/events/genreCsvApply.ts, tests/genreCsv.test.ts, tests/genreCsvApply.test.ts | Coords: [400, 07-artist-genres, docs/archive/genres-csv.md] | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 36.9: Screens read the vocabulary** [CORE / DATA] Pass `vocabulary` and `map` from the genres response into every `genresByArtist` call; `genreMix` gains `umbrellas` (section 7: per set, each genre once per umbrella, never above one set) with tests. Target files: src/services/genres.ts, tests/genres.test.ts, src/components/StatsView.tsx, src/components/ArtistsView.tsx | Coords: [400, 07-artist-genres, 15-shared-ui] | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 36.10: Manage > Global archive > Genres list** [UI / VISUAL] "Genres" tab after Brands; list with group, umbrellas and artist counts; search by name or alias; group filter with "Not grouped"; "N genres have more than one spelling. Pick one." with "Use this spelling"; "New genre". Target files: src/components/GenresPanel.tsx, src/components/ManageView.tsx, src/components/CanonicalArchive.tsx | Coords: [400, 15-shared-ui] | Verify: npm run lint --silent
- [ ] **Slice 36.11: A genre's record: rename, aliases, group, umbrellas, merge, history** [UI / VISUAL] Spec section 6 screens and exact refusal lines; merge preview then "Merge"; History with Undo on the newest change; notice with Undo after each change; uses shared `src/components/ui/` parts. Target files: src/components/GenreRecord.tsx, src/components/GenresPanel.tsx | Coords: [400, 15-shared-ui] | Verify: npm run lint --silent
- [ ] **Slice 36.12: Stats copy and genres docs** [UI / VISUAL] StatsView "Including related genres" bars with the line "A set counts once under each umbrella it falls in."; 07-artist-genres.md describes the vocabulary; "being built" notes removed from ARCHITECTURE.md. Target files: src/components/StatsView.tsx, docs/architecture/07-artist-genres.md, ARCHITECTURE.md | Coords: [400, 07-artist-genres] | Verify: npm run lint --silent

Order: 36.1, then 36.2 and 36.3 (no migration; requirement 1 done), 36.4 (held), then 36.5 to 36.12.

## 12. Open questions for Charlie

1. **Genres with no group.** Today a genre you typed that music-story does not know becomes its own group in the "Genre" bars. Should it show as "Not grouped" until you give it a group? Recommended: yes. The 13 groups stay clean and the Genres tab lists what needs a group.
2. **Umbrellas inside umbrellas.** May an umbrella sit under another umbrella (for example "melodic bass" under "bass music")? Recommended: yes, with loops refused. Stats count a set once per umbrella at any depth.
3. **Accents.** Should "électro" and "electro" be one genre on their own? Recommended: yes. It is the same word with a mark, not a different word.

## Not in scope

- Suggesting aliases (for example "dnb" for "drum and bass"). The owner adds them.
- Members proposing aliases or umbrellas.
- New top-level groups beyond the genre map's. The owner picks from the map's groups.
- Rewriting stored genre rows (section 4).
