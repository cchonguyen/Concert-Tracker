# Shared artist genres (genres become canonical)

Status: scope approved by Charlie 2026-11-26 (five decisions in the project thread; decision 4 revised by him the same day: members may add genres of their own on top). Design written 2026-11-26. Built: Slices 35.1 to 35.12 merged (now in `.spec/archive/HISTORY-2026-11.md`), and Charlie applied migration `0059_canonical_genres.sql`.

## In plain English

Today every member keeps their own genres for the acts they saw, and only the owner's genres come from music-story. After this change an artist has one set of genres, the same for everyone.

- **Everyone sees the same genres.** Stats, the Artists cards, the Genres list under "Who you saw" and an artist's record in Manage all show the shared genres. When the owner set them, the screen says "Set by the site owner" (the owner sees "Set by you").
- **Only the owner changes the shared genres.** A member can still use "Add genre" to add genres of their own to an artist. Those are added on top of the shared ones, never hide or replace them, and show only on that member's own screens. Genres a member typed before this change are kept and read the same way: as their additions.
- **The spreadsheet covers every artist.** The owner's "Download artists and genres (CSV)" now lists every artist in the shared lineup catalog plus every act any member ticked as seen that the catalog does not have. Each act appears once, by name only. The file never says who saw an act, at which event, or how many people did.
- **Every change is written down and can be undone.** Each change records what the genres were, what they became, who or what changed them and why. "Undo this upload" puts back the whole latest upload; an artist's record in Manage has "Undo" for the owner's last change to that artist. A row in an upload that was changed in the app after the file was downloaded is left alone unless the owner ticks "Replace anyway".
- **music-story and MusicBrainz keep working.** They now fill genres for every artist on the list, not only the owner's own.

## Rules this feature keeps

- No model call, no inferred genre. A genre exists only because music-story, MusicBrainz (through music-story's genre map, when asked) or the owner gave it.
- Matching never guesses: MusicBrainz ID first, then the exact normalized name with the catalog's renames (`artist_aliases`); ambiguous or unknown rows are skipped and listed (unchanged from `docs/archive/genres-csv.md`).
- Sync never overwrites newer: the version stamp check stays, recomputed at preview and at apply.
- Shared tables hold no personal fields. `artist_genres` and `artist_genre_changes` hold an act key, a name, genres, a source, a MusicBrainz ID or page, and for changes an actor (`owner` or `system:<job>`), a reason and a batch id. No user id, event id, date seen, companion, note, rating, price or attendance.
- Public pages untouched. All routes stay under `/api/artist-genres`.

## 1. The export: every artist, names only

### Which acts

`genreUniverse(store)` (new, `src/server/events/genreCatalog.ts`) builds the list once by key, in this order (first name wins):

1. Every row in `canonical_artists` (`listArtists`). A catalog merge removes the merged-away row (`deleteArtists` in `canonicalManage.ts`), so what remains is the live catalog. Its MusicBrainz ID comes along.
2. Every act in any member's "Who you saw" that is not already listed (`listSeenActNames`, below). No MusicBrainz ID (none is stored for an act outside the catalog).
3. The owner's own artist records (`listEntities`, `kind === 'artist'`, not merged, not encrypted), so every act `setOwnerGenres` accepts is exportable, as before.

The CSV columns, the file name, the BOM, formula-safe cells and the version stamp are unchanged (`genreCsv.ts`). The `Source` column says `owner`, `music-story`, `MusicBrainz` or `none`.

### How the server reads every member's seen acts

Requests run with a store scoped to the caller (`requestScopedStore`, `LineupStore.forUser`), so `listEvents()` returns the caller's events only. The export does **not** widen that. Instead migration 0059 adds one database function, `seen_act_names()`, following the pattern of `canonical_community_counts()` (0033):

- `security definer`, `search_path` set, `stable`, execute revoked from `public`, `anon` and `authenticated`, granted to `service_role` only. The member's 60-second token cannot call it; only the server's service client can.
- It returns `(artist_key, name)` and nothing else: no user id, event id, date or count. One row per key; the name is `min(name)` among the spellings.
- It skips deleted events, empty keys and names, and vault ciphertext (`v1:%`).

The store method `listSeenActNames()` calls it through the service client (`this.db.rpc`, as `communityCounts` does) and refuses in a member scope (`scope.role !== 'owner'` throws), so the owner check is in three places: `OWNER_ONLY` in `requestScope.ts` (the route), the store method, and the database grant.

### Privacy rules this touches

- REQUIREMENTS.md, Scope: "nobody sees another member's rows, and the owner has no extra view of them." The file is an extra (unattributed) view, so this sentence changes (wording below).
- The member notice (`NoticeModal.tsx`, "What is shared") does not mention it, so its text changes and `NOTICE_VERSION` goes from 3 to 4; members accept again.
- AGENTS.md, "Shared tables, traces, logs and the review queue never hold personal fields": still kept (act names are not on that list and no personal field is stored), but the export is stated explicitly in AGENTS.md.
- AGENTS.md genre rule ("or you ... yours win"): changes (wording below).
- A caveat to say plainly: with few members, an act only one member ever saw can still be recognised by the owner as "someone saw this". The file removes who, when and how many, but not existence. The approved decision accepts this; the notice says it.

### Members see only rows for their own acts

`artist_genres` is now read for everyone, but a genre row keyed to an act only member B saw must not reach member A. `GET /api/artist-genres` for a member returns only rows whose key is in that member's seen acts or their artist records (`listEvents` plus `listEntities`, both already scoped). The `known` genre list is built from the genre map and those filtered rows. The owner gets every row.

## 2. Upload, preview, Apply, Undo

The flow, screens and pure rules stay (`genreCsv.ts`, `genresCsvFile.ts`, `ArtistGenresPanel.tsx`, `GenresCsvPreview.tsx`). One flow remains: the personal-scope CSV is replaced, not kept beside it.

- **Catalog.** `loadCatalog` in `genreCsvApply.ts` uses `genreUniverse` instead of the caller's events and entities.
- **Saving.** Apply writes source `owner` rows (was `you`) through `writeArtistGenres(rows, { actor: 'owner', reason: 'Genres file upload', batchId })`. `ownGenreRow` is renamed `ownerGenreRow` and returns source `owner`; equal weights, known spelling and parent, limits unchanged.
- **Stamp.** `genreStamp` treats `you` and `owner` as the same token, so a file downloaded before 0059 is not suddenly stale after the migration turns the owner's `you` rows into `owner` rows.
- **Stale rows.** Unchanged: the stamp is recomputed at preview and apply; a stale row is skipped unless ticked.
- **Undo of an upload.** The undo record moves from `app_settings` (`genres_csv_undo`) to the change log. The latest upload is the newest `batch_id` among changes with reason `Genres file upload` that are not undone. Undo restores each change whose current row still equals its `after` (else "changed since, left as it is"), writes the restore through `writeArtistGenres` (actor `owner`, reason `Undo genres file upload`), and sets `undone_at` on the originals. `GET /api/artist-genres` reports `csvUndo: { at, count }` from the log (owner only; members get `null`). The old setting is ignored and cleared on the first undo or apply.
- **Undo of one change.** `POST /api/artist-genres/:key/undo` undoes the owner's newest not-undone change for that act if the current row still equals its `after`; else 409 "Changed since; nothing undone".

## 3. Storage: migration 0059

The shared table stays `artist_genres` (one row per act and source). The owner's genres get their own source, `owner`, and every write goes through one database function that writes the row and its log entry in one transaction.

Draft (`supabase/migrations/0059_canonical_genres.sql`; Slice 35.5 writes it with a check query and a rollback; Charlie applies it):

```sql
-- 0059 canonical genres (docs/specs/canonical-genres.md). Apply only on Charlie's go.
-- Adds the 'owner' source, an append-only change log, one atomic write function,
-- the owner's seen-act list function, and moves the owner's 'you' rows to 'owner'.

-- 1. The owner's shared genres get their own source.
alter table public.artist_genres drop constraint if exists artist_genres_source_check;
alter table public.artist_genres add constraint artist_genres_source_check
  check (source in ('music-story', 'musicbrainz', 'you', 'owner'));

-- 2. Every change to a shared genre row: old, new, who or what, why. No personal fields.
create table if not exists public.artist_genre_changes (
  id uuid primary key default gen_random_uuid(),
  artist_key text not null,
  source text not null,                 -- which artist_genres row changed
  at timestamptz not null default now(),
  actor text not null check (actor = 'owner' or actor like 'system:%'),
  reason text not null,
  batch_id text,                        -- one genres file upload
  before jsonb,                         -- the row as it was (null: there was none)
  after jsonb,                          -- the row as it became (null: removed)
  undone_at timestamptz
);
create index if not exists artist_genre_changes_key_idx on public.artist_genre_changes (artist_key, at desc);
create index if not exists artist_genre_changes_batch_idx on public.artist_genre_changes (batch_id) where batch_id is not null;

create or replace function public.artist_genre_changes_append_only() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'artist_genre_changes is append-only: rows are never deleted';
  end if;
  if (new.id, new.artist_key, new.source, new.at, new.actor, new.reason, new.batch_id, new.before, new.after)
       is distinct from (old.id, old.artist_key, old.source, old.at, old.actor, old.reason, old.batch_id, old.before, old.after)
     or old.undone_at is not null or new.undone_at is null then
    raise exception 'artist_genre_changes is append-only: only undone_at may be set, once';
  end if;
  return new;
end $$;
drop trigger if exists artist_genre_changes_append_only on public.artist_genre_changes;
create trigger artist_genre_changes_append_only before update or delete on public.artist_genre_changes
  for each row execute function public.artist_genre_changes_append_only();

alter table public.artist_genre_changes enable row level security;   -- no policies: server only
revoke all on public.artist_genre_changes from anon, authenticated;

-- 3. One write: upsert or delete each row and log it, in one transaction.
--    p_rows: [{ artist_key, source, row: {name, mbid, genres, source_url, inputs, checked_at} | null }]
create or replace function public.artist_genres_write(p_rows jsonb, p_actor text, p_reason text, p_batch text default null)
returns setof public.artist_genre_changes
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r jsonb; v_key text; v_source text; v_before jsonb; v_after jsonb; v_change public.artist_genre_changes;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    v_key := r->>'artist_key';
    v_source := r->>'source';
    select to_jsonb(g) into v_before from public.artist_genres g
     where g.artist_key = v_key and g.source = v_source for update;
    if jsonb_typeof(r->'row') = 'object' then
      insert into public.artist_genres (artist_key, source, name, mbid, genres, source_url, inputs, checked_at)
      select v_key, v_source, x.name, x.mbid, coalesce(x.genres, '[]'), x.source_url, coalesce(x.inputs, '{}'), x.checked_at
        from jsonb_populate_record(null::public.artist_genres, r->'row') x
      on conflict (artist_key, source) do update
        set name = excluded.name, mbid = excluded.mbid, genres = excluded.genres,
            source_url = excluded.source_url, inputs = excluded.inputs, checked_at = excluded.checked_at;
      select to_jsonb(g) into v_after from public.artist_genres g where g.artist_key = v_key and g.source = v_source;
    else
      delete from public.artist_genres where artist_key = v_key and source = v_source;
      v_after := null;
    end if;
    -- A re-check that changes only checked_at is not a change.
    if (v_before - 'checked_at') is distinct from (v_after - 'checked_at') then
      insert into public.artist_genre_changes (artist_key, source, actor, reason, batch_id, before, after)
      values (v_key, v_source, p_actor, p_reason, p_batch, v_before, v_after)
      returning * into v_change;
      return next v_change;
    end if;
  end loop;
end $$;
revoke all on function public.artist_genres_write(jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.artist_genres_write(jsonb, text, text, text) to service_role;

-- 4. The owner's genres file: every act any member ticked as seen, names only.
create or replace function public.seen_act_names()
returns table(artist_key text, name text)
language sql stable security definer set search_path = public, pg_temp as $$
  select x.k, min(x.n)
  from (
    select btrim(s->>'key') as k, btrim(s->>'name') as n
    from (select seen from public.logged_events
           where deleted_at is null and jsonb_typeof(seen) = 'array') e
    cross join lateral jsonb_array_elements(e.seen) s
    where coalesce(btrim(s->>'key'), '') <> ''
      and coalesce(btrim(s->>'name'), '') <> ''
      and s->>'name' not like 'v1:%'
  ) x
  group by x.k;
$$;
revoke all on function public.seen_act_names() from public, anon, authenticated;
grant execute on function public.seen_act_names() to service_role;

-- 5. The owner's own genres become the shared ones: copy 'you' to 'owner', log both, then drop 'you'.
insert into public.artist_genre_changes (artist_key, source, actor, reason, before, after)
select g.artist_key, 'owner', 'system:migration-0059', 'The owner''s genres became the shared genres',
       null, to_jsonb(g) || jsonb_build_object('source', 'owner')
  from public.artist_genres g
 where g.source = 'you'
   and not exists (select 1 from public.artist_genres o where o.artist_key = g.artist_key and o.source = 'owner');
insert into public.artist_genres (artist_key, source, name, mbid, genres, source_url, inputs, checked_at)
select artist_key, 'owner', name, mbid, genres, source_url, inputs, checked_at
  from public.artist_genres where source = 'you'
on conflict (artist_key, source) do nothing;
insert into public.artist_genre_changes (artist_key, source, actor, reason, before, after)
select artist_key, 'you', 'system:migration-0059', 'Moved to the owner source', to_jsonb(g), null
  from public.artist_genres g where g.source = 'you';
delete from public.artist_genres where source = 'you';

-- user_artist_genres (members' own genres, 0020) is not touched: kept, no longer read.

-- Check: select source, count(*) from public.artist_genres group by source;  -- no 'you' left
--        select count(*) from public.artist_genre_changes where actor = 'system:migration-0059';
-- Rollback (restores the 'you' rows from the log, then removes what 0059 added):
--   insert into public.artist_genres select (jsonb_populate_record(null::public.artist_genres, before)).*
--     from public.artist_genre_changes where actor = 'system:migration-0059' and source = 'you'
--     on conflict do nothing;
--   delete from public.artist_genres where source = 'owner';
--   drop function if exists public.seen_act_names();
--   drop function if exists public.artist_genres_write(jsonb, text, text, text);
--   drop table if exists public.artist_genre_changes;
--   (then restore the three-value source check from 0035)
```

Order of shipping matters: Slices 35.3 and 35.4 (code that already ranks `owner` above everything and stamps `you` and `owner` the same) merge before 0059 is applied, so the minutes between applying 0059 and deploying the rest show the same genres. The migration test (`tests/migration0059.test.ts`) checks: copy before delete, append-only trigger, both functions `security definer` with execute revoked from `anon` and `authenticated`, `seen_act_names` selects no `user_id`, and `user_artist_genres` is not mentioned outside comments.

### Store contract (`LineupStore`, `store/types.ts`)

- `listArtistGenres()`: every scope reads `artist_genres` through the service client. A member's store also returns their own `user_artist_genres` rows, now mapped to the new client-side source `added` (was `you`), so they can never be mistaken for the owner's or legacy `you` rows. `user_artist_genres` has no source column, so `added` needs no database change.
- `writeArtistGenres(rows: Array<{ key; source; row: ArtistGenres | null }>, meta: { actor: 'owner' | \`system:${string}\`; reason: string; batchId?: string }): Promise<GenreChange[]>`: Supabase calls `artist_genres_write`; the file store does the same in memory. Refused in a member scope.
- `listGenreChanges(q: { key?: string; batchId?: string; latestBatchReason?: string; limit?: number }): Promise<GenreChange[]>` and `markGenreChangesUndone(ids: string[], at: string)`: owner and system only.
- `listSeenActNames(): Promise<Array<{ key: string; name: string }>>`: owner and system only.
- `putArtistGenres` and `deleteArtistGenres`: in a member scope they write and delete only that member's `user_artist_genres` row (source `added`; any other source throws), as today. Outside a member scope they stay for tests and the file store; every shared write in the app moves to `writeArtistGenres`.

`GenreChange` (in `genreTypes.ts`): `{ id, key, source, at, actor, reason, batchId?, before: ArtistGenres | null, after: ArtistGenres | null, undoneAt? }`.

### Who writes, with which actor

| Writer | Source | Actor | Reason |
| --- | --- | --- | --- |
| Owner in the event panel or Manage (`setOwnerGenres`, `PUT /api/artist-genres/:key`) | `owner` | `owner` | `Set in the app` (reset: `Reset to found genres`, row null) |
| Member in the event panel or Manage (`setMemberAdditions`, same `PUT`) | `added`, in `user_artist_genres` | not logged (personal, like today) | not logged |
| Genres file Apply | `owner` | `owner` | `Genres file upload` + `batchId` |
| Undo (file or one change) | as undone | `owner` | `Undo genres file upload` / `Undo` |
| music-story upload (`importMusicStory`) | `music-story` | `system:music-story` | `music-story file upload` + `batchId` |
| MusicBrainz lookup (`musicBrainzGenres`) | `musicbrainz` | `system:musicbrainz` | `MusicBrainz lookup` |
| Catalog rename or merge (Slice 35.12) | each source | `system:catalog-rename` / `system:catalog-merge` | `Artist renamed` / `Artist merged` |

music-story and MusicBrainz now match against `genreUniverse` (the catalog plus every seen act), not only the owner's events, so their genres reach members' acts. Their rules (genre map, exact match, 15% share cut) are unchanged.

## 4. Display: which genres show

`genresByArtist` (`src/services/genres.ts`) works in two steps per act.

**Step 1, the shared base.** One shared row, by this order:

1. `owner` (the owner set them; an empty list means the owner says none),
2. `you` (legacy; only in the shared table until 0059 moves it, so it reads as the owner's),
3. music-story with genres, 4. MusicBrainz with genres, 5. music-story checked with none, 6. MusicBrainz checked with none.

**Step 2, the member's additions on top** (members only; the owner has none, because the owner's edits are the shared ones). Take the member's `added` row for the act, drop every style already in the base (compared lower-cased, trimmed), and keep the rest in the member's order. Then:

- No additions left: the base as it is.
- No base genres (no row, or a checked-with-none row): the additions alone, equal weights.
- Both: with `n` base genres and `m` additions, each addition gets weight `1 / (n + m)` and every base genre keeps its share scaled by `n / (n + m)`. Weights still sum to 1, the shared order is kept, and additions come after. Example: shared rock 0.7, pop 0.3, plus jazz: rock 0.467, pop 0.2, jazz 0.333.

The result row keeps the base's `source` (or `added` when there is no base) and gains `added: string[]` (the styles the member added), so screens can tell them apart. An empty `added` row (a member who once said "none") adds nothing and hides nothing.

**Stats** (`genreMix`, `StatsView.tsx`): unchanged code; it already splits each seen set across the act's genres by weight, so it uses the combined weights above. An act counts as "with a genre" when the combined list is not empty.

Where it is read:

- Artists cards and filter (`ArtistsView.tsx`): the first three combined styles; the tooltip says "Set by the site owner" (owner: "Set by you"), "From music-story" or "From MusicBrainz", and "Added by you: ..." for additions. The parent-genre filter includes additions.
- Event panel Genres list (`SeenGenres.tsx`): the owner edits as before (writes `owner`). A member sees the shared genres as plain pills with no remove button, their own additions with a remove button, and the "Add genre" field, which appends to their additions (`PUT /api/artist-genres/:key` with the additions list). One line: "Shared genres are set by the site owner. Genres you add show only to you." "Remove my genres" sends `reset` and drops their additions.
- Manage artist record (`ManageEntry.tsx`): the same split; for the owner, "Last change: <date>. Undo" from `listGenreChanges({ key, limit: 1 })`.
- Genres panel and CSV (owner only): shared rows only; additions never enter the export, the stamp or the log.
- `knownGenres` for a member: the genre map, their filtered shared rows and their own additions.

Members' old `user_artist_genres` rows were, under the old rule, a full copy of what showed plus their edits. Read as additions, the copied shared styles drop out in step 2, so what remains is what they added. A style they had removed from music-story's list shows again: the shared genres are never hidden.

## 5. Red tripwires

- **Red, auth:** Slice 35.9 edits `src/server/auth/requestScope.ts` (`OWNER_ONLY` gains `['GET', /^\/api\/artist-genres\/csv\//]`; the export GET is open to members today). `PUT /api/artist-genres/:key` stays open: `genreRoutes.ts` sends the owner to `setOwnerGenres` (shared, logged) and a member to `setMemberAdditions` (their own row only), by `currentMember().role`; the comment above `OWNER_ONLY` is updated. Slice 35.2 edits `src/server/auth/routes.ts` (`NOTICE_VERSION` 4).
- **Red, migration:** Slice 35.5 adds `supabase/migrations/0059_canonical_genres.sql`. Its pull request is held until Charlie says 0059 is applied. Slices 35.6 onward call the new functions, so they merge only after that too.
- **Privacy-sensitive, not red:** Slice 35.6 changes member scoping in `supabaseStore.ts` and `fileStore.ts`. Its tests cover: a member reads shared rows; a member's write throws; `listSeenActNames` throws for a member.
- music-story and MusicBrainz: Slice 35.7 keeps every existing test in `tests/genres.test.ts` passing and adds universe matching.

## 6. Exact rule wording to change (Slices 35.1 and 35.2, before any other code)

AGENTS.md says to change REQUIREMENTS.md or ARCHITECTURE.md first and say why. Why: Charlie approved genres becoming shared on 2026-11-26, which changes who sets genres and gives the owner an unattributed list of members' seen act names.

**AGENTS.md**, replace the genre bullet with:

> - Artist genres are shared: one set per artist, the same for everyone (approved 2026-11-26, `docs/specs/canonical-genres.md`). They come only from the music-story export, MusicBrainz read through music-story's genre map when asked, or the owner (`src/server/events/genres.ts`); the owner's win and are labelled as set by the owner. Only the owner changes them. Every change goes through `writeArtistGenres`, is recorded in `artist_genre_changes` (old value, new value, who or what, why) and can be undone. A member may add genres of their own to an act (`user_artist_genres`): added on top of the shared ones, never hiding or replacing them, shown only on that member's screens and never in shared tables, the export or the log. Never infer a genre from a name, an event or a model; an act with none stays without one.
> - The owner's genres file lists every act any member marked as seen, once by name, read only through the `seen_act_names()` database function: no member, event, date or count. A member is sent genre rows only for acts in their own events or records.

and in the shared-edition rules, change "so the member notice version is now 3 and members accept it again." to "the member notice version is now 4 (2026-11-26: act names in the owner's genres file), and members accept it again."

**REQUIREMENTS.md**, Scope, replace "nobody sees another member's rows, and the owner has no extra view of them." with:

> nobody sees another member's rows, and the owner has no extra view of them, with one exception (approved 2026-11-26): the owner's artist genres file lists the names of acts members marked as seen, once each, with no member, event, date or count, so the owner can set shared genres for them.

and "The member notice is at version 3" becomes "version 4".

**Member notice** (`NoticeModal.tsx`, "What is shared"), add after the provisional-edition sentence:

> The names of acts you tick as seen may appear, without your name, in the site owner's list of artists, so genres can be set for them. Genres are shared: everyone sees the same ones.

**19-multi-user.md** ("Genres for members", "Owner-only") and **ARCHITECTURE.md** (genres summary line): rewritten in Slice 35.1 to describe shared genres, marked "approved 2026-11-26, being built in Slices 35.2 to 35.12". **docs/architecture/07-artist-genres.md** is rewritten in Slice 35.11, which also removes that note.

## Not in scope

- Letting members' additions reach the shared genres (a later spec could let the owner adopt them, like inferred values).
- Copying members' old personal genres into the shared ones. They stay in `user_artist_genres`, read as additions.
- A member hiding a shared genre. Not offered: additions only.
- A history screen for all genre changes. The log is complete; Manage shows the latest change per artist.
