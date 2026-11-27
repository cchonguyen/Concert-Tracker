# Phase 1 Artist Entity Cleanup & Remap Specification

Status: approved by Charlie 2026-11-26 (1B + reusable CSV upload UI, 2A `alter_ego_of` FK + `extraction_blocklist.reason`, 3A canonical catalog + owner's own records/events). Migration: `supabase/migrations/0060_artist_cleanup.sql` (apply in Supabase before running Apply in production).

## 1. Purpose & Execution Model

Allows the owner to upload any 15-column artist cleanup CSV (starting with `phase1-artist-cleanup-concentrated.csv`, 425 rows), run a live single-transaction `--dry-run` preview against the database, inspect the counts and any unresolved keys, and click **Apply** to execute the entire batch atomically inside one Postgres transaction (`public.canonical_artist_cleanup`).

- **Single-transaction atomicity:** Dry-run executes the full SQL mutation inside a sub-transaction and raises `SQLSTATE 'P0099'` to roll back while returning the exact JSON report. Apply commits all 6 stages together or rolls back everything on any error.
- **Privacy boundary:** Only canonical catalog tables (`canonical_artists`, `performances`, `artist_aliases`, `extraction_blocklist`, `artist_genres`, `artist_genre_changes`) and the **owner's own** records (`user_entities` / `entities`, `logged_events.seen` where `user_id = p_owner_user_id` or single-user) are updated. Other members' `logged_events` are never touched.
- **Genres excluded in Phase 1:** Genre enrichment runs in Phase 2 after re-exporting the cleaned active artists.

## 2. CSV Schema (15 Columns)

| Column | Required | Notes |
| --- | --- | --- |
| `Artist` | Yes | Exact original string currently stored in the DB. Preserves `\xa0` non-breaking spaces. |
| `MusicBrainz ID` | No | Preferred source-row lookup key when non-empty. |
| `Source` | No | `owner` or `none`. |
| `Version (leave as it is)` | No | Export state hash. |
| `Entity_Status` | Yes | `invalid_non_artist`, `merge_duplicate`, `remap_set`, `split_multi_artist`, `rename`, or `link_alter_ego`. |
| `Invalid_Reason` | On `invalid_non_artist` | Blocklist reason code (e.g. `silent_disco_channel`, `panel_talk`, `campground_activity`, `yoga_wellness`, `placeholder`, `truncated_scrape`, `cooking_demo`). |
| `Canonical_Artist` | On `merge_duplicate`, `remap_set`, `rename` | Clean display name of target or renamed artist. |
| `Canonical_Key` | On `merge_duplicate`, `remap_set`, `rename` | `mbid:<uuid>` or `artist:<Exact Artist Original>`. |
| `Set_Qualifier` | Optional | Stripped set/show/MC/tour label stored on event appearances (`performances.set`, `logged_events.seen[].set`), never on the artist entity. |
| `Split_Artists` | On `split_multi_artist` | `; `-separated constituent artist names (2 to 9). |
| `Split_Keys` | On `split_multi_artist` | Parallel `; `-separated lookup keys (`mbid:<uuid>`, `artist:<Exact Artist Original>`, or `NEW`). |
| `Combo_Alias` | Optional on `split_multi_artist` | Recognized B2B/project moniker (e.g. `Kx5`, `Worship`). Stored on appearance `alias`; standalone artists matching a `Combo_Alias` are never deleted. |
| `Alter_Ego_Of` | Optional on `link_alter_ego`, `rename` | Primary artist name for solo alter egos kept as distinct entities. |
| `Alter_Ego_Of_Key` | Optional on `link_alter_ego`, `rename` | `mbid:<uuid>`, `artist:<Exact Artist Original>`, or `NEW`. |
| `Cleanup_Notes` | No | Audit tag. |

## 3. Safe Execution Order & Key Resolution

Rows are sorted into the strict 6-stage order before execution:
1. `invalid_non_artist`
2. `merge_duplicate`
3. `remap_set`
4. `split_multi_artist`
5. `rename`
6. `link_alter_ego`

### Key Resolution Rules
1. **Source row lookup:** Match `canonical_artists` by `MusicBrainz ID` if non-empty; else exact `name = Artist` (preserving `\xa0`); else normalized `key = artistKey`.
2. **Pre-rename snapshot:** Before any mutation, capture `_orig_artists` (`key`, `name`, `mbid`) so `artist:<Exact Artist Original>` targets resolve pre-rename names (such as `DJ PEE .WEE (aka Anderson .Paak)` and `Manilla Killa`) even if referenced before or during the same batch.
3. **Target key resolution:**
   - `mbid:<uuid>` → resolve by `mbid`.
   - `artist:<Exact Artist Original>` → resolve via `_orig_artists` exact `name` (or normalized `artistTargetKey`).
   - `NEW` → insert a new `canonical_artists` row once, deduplicated case-insensitively by normalized key across the batch.

## 4. Action Handlers

1. **`invalid_non_artist`:** Upsert `(domain='*', normalized, rejections, reason)` into `extraction_blocklist`. Delete source `performances` and `artist_genres` (logging deletions to `artist_genre_changes` with `p_actor`). Delete source `canonical_artists` row. Remove matching `seen` entries from the owner's `logged_events` and mark the owner's matching `artist` entity merged/removed.
2. **`merge_duplicate`:** Resolve target. Migrate `performances` to target (deduplicating `(edition_id, artist_key)` by merging `days`, `stages`, `sources` and keeping target `billing`). Copy `artist_genres` from source to target **only where target lacks that `source`** (protecting `Lost Heroes` → `LAST HEROES`), then delete source `artist_genres` (all logged to `artist_genre_changes`). Upsert `artist_aliases` (`alias_normalized -> target.name`) and repoint existing aliases. Transfer `mbid` if target has none (freeing source `mbid` first). Delete source `canonical_artists`. Update owner's `logged_events.seen` and owner's artist entity.
3. **`remap_set`:** Resolve target. Migrate `performances` to target, setting `"set" = coalesce(nullif("set", ''), Set_Qualifier)` and deduplicating collisions. Delete source `artist_genres` **without** copying onto target (so set-specific genres like `Porter Robinson (DJ Set)` never overwrite the base artist). Upsert `artist_aliases`. Delete source `canonical_artists`. Update owner's `logged_events.seen` (re-keying and setting `set`) and owner's artist entity.
4. **`split_multi_artist`:** Zip `Split_Artists` and `Split_Keys`. Resolve each constituent (inserting `NEW` artists once). Replace each source performance with `N` constituent performances sharing a `slot_id`, reciprocal `b2b` partner keys, `alias = Combo_Alias` (if set), and `"set" = Set_Qualifier` (if set), deduplicating if a constituent already appears on that edition/slot. Delete source `artist_genres` and source `canonical_artists` (never deleting standalone artists whose name matches `Combo_Alias`). Update owner's `logged_events.seen` by expanding matching entries into `N` entries sharing `slotId` and reciprocal `b2b`.
5. **`rename`:** Rename `canonical_artists` in place to `Canonical_Artist` (and migrate `key` to `newKey` if normalized key changes, freeing `mbid` first, merging if `newKey` already exists, and repointing `performances`, `artist_genres`, `artist_aliases`, and `alter_ego_of`). Upsert old `Artist` string as an alias. If `Set_Qualifier` is non-empty, attach it to the artist's `performances` and owner's `logged_events.seen`. Update owner's artist entity and `logged_events.seen`. If `Alter_Ego_Of` is non-empty, also run `link_alter_ego`.
6. **`link_alter_ego`:** Keep the alter-ego row as its own distinct `canonical_artists` entry. Resolve parent via `Alter_Ego_Of_Key` (creating a `NEW` parent stub in `canonical_artists` when `Alter_Ego_Of_Key = 'NEW'`). Set `canonical_artists.alter_ego_of = parentKey`.

## 5. Verification & Post-Commit Assertions

The RPC returns:
- `counts`: processed row counts per `Entity_Status`.
- `performancesMigrated`, `performancesDeduped`, `newArtistsInserted`, `parentStubsInserted`, `ownerEventsUpdated`.
- `failedResolutions`: array of `{ line, artist, status, targetKey, reason }` (expected `0` before Apply).
- `assertions`: `{ remainingDeprecatedActive, orphanedPerformances, missingBlocklistEntries }` (all expected `0` post-commit).
