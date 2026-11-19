# DB, Logs & Production Improvement Spec (2026-11-18)

Status: **Approved & implementing (Slices 21.1 to 21.4)**
Measured against: Live Supabase (`mybwchgqhrpvdczqigma`), Supabase Logs & Advisors, Cloudflare Workers Observability (`concert-tracker`, 7-day + post-PR #585 windows), and `origin/main` at PR `#585` (`52d8d76`).

> **Privacy & scope note:** All database figures below are strictly aggregates. No personal fields (companions, notes, ratings, ticket prices), OAuth tokens, or member identities are reproduced. Follow-up to the earlier baselines in [2026-11-17-event-data-entry-and-correction.md](../audits/2026-11-17-event-data-entry-and-correction.md) and [2026-11-17-external-event-fetch.md](../audits/2026-11-17-external-event-fetch.md); governed by [REQUIREMENTS.md](../../REQUIREMENTS.md), [ARCHITECTURE.md](../../ARCHITECTURE.md), and [AGENTS.md](../../AGENTS.md).

---

## 1. What Concert Tracker Is Doing Well

1. **Zero Supabase HTTP errors & clean relational integrity:**
   - `0` 4xx/5xx errors across `26,369` Supabase `edge_logs` requests in the trailing 24h; `0` Supabase health advisor lints.
   - `0` orphaned `performer_claims`, `0` orphaned `performances`, `0` dangling `logged_events.edition_id` references, and `0` orphan `event_series`.
   - `100%` of `public` schema tables have RLS enabled (`relrowsecurity = true`).
2. **Reader model accuracy, cost discipline & invariants hold in production:**
   - `ai_calls` (2026-11-13 to 2026-11-18): `lineup_extract` returned **182 names with 181 verbatim (99.45%)** and 1 rejected; `details_extract` executed **36 calls** (avg 965 ms); total November Gemini spend is **\$0.25** (\$0.122 details + \$0.130 lineup).
   - **AXS guard active:** `lookup_jobs` on `2026-11-18T18:40:31Z` logged `"AXS pages are never fetched."`
   - **Calendar-link venue cleanup succeeded:** `0` active and `0` deleted rows in `logged_events` carry `"Add to Google · Outlook · iCal · Yahoo"` (down from 60 on Nov 17).
3. **Nov 17–18 fixes measurably improved production reliability:**
   - **Clashfinder Stage 0 (`#427`):** `0` `"Invalid JSON"` failures across 63 Nov 18 research runs (down from 132/171 pre-Stage 0).
   - **setlist.fm + Stage 3.3 cascade (`#535`):** `setlistfm` is active; Brave Search was skipped on **8 of 63** Nov 18 runs (`12.7%`) where free sources already answered.
   - **`/api/manage/canonical/name-matches` CPU fix (`#577`):** dropped from ~555 ms avg CPU (`exceededCpu` 503s) to 22–36 ms CPU (200/304 OK) after `19:05Z`.
   - **Learned 403 refusal list (`#560`):** automatically recorded 9 refusing domains (`ra.co`, `tixr.com`, `bandsintown.com`, `concertarchives.org`, `everout.com`, `rateyourmusic.com`, etc.).
   - **Queue stability:** `106` `concert-tracker-lookups` consumer invocations in the trailing 24h all completed `outcome: ok` (avg 1.97s wall, p95 4.86s).
4. **Source quality & MusicBrainz resolution:**
   - `source_stats`: Clashfinder has **99.5%** acceptance (`5,832` accepted / `28` rejected).
   - `canonical_artists`: **2,385 of 2,486 (95.9%)** resolved, **1,646 (66.2%)** with MBIDs; all `76` `resolve_artists` jobs confirmed.

---

## 2. Prioritized Improvement Spec (P0–P3)

### P0 — Live Failures, Exhausting Quota & Security/Privacy Gaps

#### P0.1 Batch `GET /api/canon/lineup-offers` (Eliminate Live HTTP 500s)
- **Observed evidence:** 3 live **HTTP 500** errors (`2026-11-18T21:16–21:19Z`, 7.08s–8.01s wall) on `/app?view=table`. Supabase `edge_logs` at `21:19:32Z` show 45+ individual `GET /rest/v1/event_editions?id=eq.<uuid>` requests followed by `performances?edition_id=eq.<uuid>`, exhausting Cloudflare Workers' 50-subrequest limit.
- **Root cause (`src/server/entities/routes.ts`):** `Promise.all(ids.map((id) => store.getEdition(id)))` makes 2 queries per edition (`2 * N > 50` whenever a user has >22 linked editions; owner has 45).
- **Spec (Slice 21.1):** Deduplicate `ids` and replace the per-id loop with `store.getEditions(ids)` (batched 100 IDs at a time in `supabaseStore.ts`), returning early when `ids.length === 0`.

#### P0.2 Protect Monthly Brave Quota & Enable Ticketmaster Response Cache
- **Observed evidence:** `app_settings.brave_monthly` jumped from `62 / 200` (Nov 16) to **`187 / 200` (93.5%)** by `2026-11-18T18:50Z` after `research_batch_members` turned on (`06:50Z`). Nov 18 `ingest_traces` (63 research runs, mostly year-only club/EDM events):
  - `ticketmaster`: 63 runs, `0` hits (**0.0%**), 303 ms avg
  - `clashfinder`: 63 runs, `4` hits (6.3%), 1,315 ms avg
  - `setlistfm`: 63 runs, `4` hits (6.3%), `2` HTTP 429 failures, 711 ms avg
  - `discovered` (Brave): 55 runs, `36` hits (**65.5%**), 1,913 ms avg
  Because `setlistfm` + `clashfinder` matched only 12.7% of these events, 87.3% cascaded into Brave, leaving 13 queries for 12 remaining days in November. Meanwhile `source_response_cache` has `0` rows because `SOURCE_CACHE` is unset in [wrangler.jsonc](../../wrangler.jsonc).
- **Spec (Slice 21.1):**
  1. Reserve **60 / 200** Brave queries (`BRAVE_INTERACTIVE_RESERVE = 60` in `src/server/events/braveBudget.ts`) so background batch research (`backfillResearch.ts`) skips `'discovered'` once `used >= 140`, preserving interactive saves, "Look again", and Stage 2 discovery.
  2. Add optional source attribution (`bySource`) to `BraveCount` when callers pass a `source` label, preserving `{ month, used }` backwards compatibility.
  3. Short-circuit `ticketmasterFinder` in `src/server/events/details.ts` when `now` is supplied and the event's year/endDate is strictly before `now.getUTCFullYear()` (Discovery rarely holds past years).
  4. Enable `"SOURCE_CACHE": "on"` in [wrangler.jsonc](../../wrangler.jsonc) so Ticketmaster responses cache in `source_response_cache` (24h TTL; Brave remains uncached per terms).

#### P0.3 Security, Privacy & `refused_hosts` Scoping Lockdown
- **Observed evidence:**
  1. Supabase Security Advisor flagged **4 `SECURITY DEFINER` RPCs executable by `authenticated`**: `canonical_apply_artist_change`, `canonical_artist_fingerprint`, `canonical_undo_artist_change`, and `owner_user_id`. Inspection of `src/server/lineup/store/supabaseStore.ts` (`canonicalClient()`) confirms all three `canonical_*` RPCs are intentionally called via the owner's `authenticated` JWT and enforce `canonical_assert_owner(p_user_id)` (`42501`) inside Postgres, while `owner_user_id()` is required by `owner_read` RLS policies. Revoking `authenticated` would break Global Archive artist edits/undo and `owner_read` policies.
  2. **4 dead `0001` tables** (`events`, `venues`, `artists`, `event_appearances`) have open `roles: ["public"], cmd: ALL, qual: true` policies.
  3. **6 obsolete pre-multi-user rows in global `app_settings`:** `google_sheets_base` (37.2 KB personal event snapshot), `google_sheets` (refresh token), `gmail`, `gmail_oauth`, `google_sheets_oauth`, `email_scan`. Active per-user rows already live in `user_settings`.
  4. **`refused_hosts` scoping bug:** `backfillResearch.ts` called `loadRefusals(store, now)` / `saveRefusals(store, ...)` using user-scoped `store`, writing the 9 learned 403 hosts into `user_settings` instead of shared `app_settings`.
- **Spec (Slices 21.1 & 21.4):**
  - **Slice 21.1 (`backfillResearch.ts`):** Pass `opts.catalogStore ?? store` to `loadRefusals`/`saveRefusals`.
  - **Slice 21.4 (`0054_db_perf_rls_and_lineup_flag.sql`):** Re-affirm `REVOKE EXECUTE ... FROM PUBLIC, anon` on `owner_user_id()` and the 3 `canonical_*` RPCs while explicitly retaining `authenticated` (required by `owner_read` RLS and `canonicalClient()` owner calls); drop the 4 open `public` policies on `0001` tables; copy `refused_hosts` from `user_settings` into `app_settings`; include commented operator SQL for dropping the 4 empty `0001` tables and deleting the 6 obsolete `app_settings` keys after Charlie's confirmation.

---

### P1 — Egress, Idle Cron Polling, DB Performance & CPU Spikes

#### P1.1 Eliminate Cold-Start Schema Probes in Production (`~5,083 queries/day`)
- **Observed evidence:** `edge_logs` shows `GET /rest/v1/lookup_jobs?select=id&limit=1` (1,695×/day, 332 ms avg), `GET /rest/v1/entities?select=id&limit=1` (1,694×/day, 137 ms avg), and `GET /rest/v1/logged_events?select=id&limit=1` (1,694×/day, 158 ms avg) on Worker cold starts (~19.3% of all Supabase API calls).
- **Spec (Slice 21.2):** In `src/server/lineup/service.ts` (`createStore`), skip the 3 `select('id').limit(1)` schema probes when `opts.requireSupabase` is `true` and construct `withEntityLinks(new SupabaseLineupStore(client))` directly (keeping probes only for local dev fallback when `!opts.requireSupabase`).

#### P1.2 Eliminate Idle Cron N+1 Loops (`~6,500+ queries/day`)
- **Observed evidence:** `* * * * *` cron runs `1,439×/day` (1,728 ms avg wall, p95 5,607 ms). Both `canon_backfill` and `canon_member_backfill` have `complete: true` since Nov 16 and active `details.status = 'pending'` count is `0`, yet every 5 minutes the cron fires ~3,432×/day `user_settings?...&key=eq.notice_accepted` calls and ~2,500×/day `logged_events?select=*&...&details->>status=eq.pending` full-row queries (`33,780` seq scans).
- **Spec (Slice 21.2):**
  1. Add optional `listUserSettingsByKeys(keys)` to `LineupStore` / `SupabaseLineupStore` and prefetch `[NOTICE_SETTING, MEMBER_BACKFILL_SETTING]` in 1 query in `src/server/canon/memberBackfill.ts`.
  2. Add optional `listPendingResearchUserIds()` (`select('user_id')...eq('details->>status', 'pending')`) so `worker/index.ts` skips listing members and skips the per-member research loop whenever `0` pending events exist.
  3. Record `trace.subrequests(b.used)` on cron traces (`backfill` / `research_backfill`) and `runQueuedResearch` (`research`).

#### P1.3 Database Indexes, RLS Initplan & Primary Keys (`0054`)
- **Observed evidence:** Supabase Performance Advisors flagged **19 `auth_rls_initplan` policies**, **11 unindexed FKs** (`logged_events.edition_id`, `event_editions.series_slug`, `event_editions.venue_id`, `performances.artist_key`, `performer_claims.document_id`, `review_queue.event_id`, `venue_aliases.venue_id`, etc.), **4 keyless tables** (`venue_aliases`, `edition_external_ids`, `entity_aliases`, `user_entity_aliases`), and `schema_migrations` tracking only 2 of 53 migrations.
- **Spec (Slice 21.4):** Add idempotent migration `0054_db_perf_rls_and_lineup_flag.sql` rewriting the 19 RLS policies to wrap `auth.uid()`/`owner_user_id()` in `(select ...)`, adding covering FK indexes + `idx_logged_events_pending_research`, and adding composite PKs on the 4 keyless tables.

#### P1.4 Future Follow-Ups: ETag `304` Fast-Paths & `performances` Diff Writes
- **Observed evidence:** High-poll routes (`/api/events` 1,228 ms avg on 304; `/api/canon/review` 1,322 ms on 304) serialize full payloads before ETag comparison; `performances` has `72,594` inserts and `68,766` deletes for `3,821` live rows (~19× churn from delete-all + insert-all on `upsertEdition`).
- **Deferred follow-up:** Add `MAX(updated_at)` pre-checks for hot GET ETags and diff-based `performances` updates in `upsertEdition` after this stabilization PR ships.

---

### P2 — Data Quality, Canonical Archive Integrity & Email Funnel

#### P2.1 Sync `has_lineup`, Normalize Country Display, Repair Drift
- **Observed evidence:**
  - `149 of 157` editions with rows in `performances` still have `has_lineup IS NULL`.
  - Only `45 of 427` active `logged_events` (`10.5%`, owner-only) have `edition_id` set, while `122` unlinked events match an existing edition on exact `start_date` + normalized `name` (`100` verified, `22` provisional); `10 of 11` members remain on `notice_accepted` v1.
  - Country variants in active `logged_events`: `"United States"` (217), `"USA"` (139), `"United States Of America"` (4), `<null>` (42); `event_editions` has 1 row with `country = 'WA'`; `"lost in dreams 2025"` has 2 duplicate verified editions on `2025-07-11`.
  - `0 / 203` editions have canonical weather (`101` active `logged_events` do); `0 / 118` series have `clashfinder_slugs`.
- **Spec:**
  - **Slice 21.2:** Update `upsertEdition` (`supabaseStore.ts` + `fileStore.ts`) so `has_lineup` is automatically `true` whenever `performances.length > 0`.
  - **Slice 21.3:** Export `normalizeCountryDisplay` in `src/server/events/regions.ts` and apply in `src/server/events/service.ts` so `USA`/`US`/`United States Of America` normalize consistently to `"United States"`.
  - **Slice 21.4 (`0054`):** Backfill `event_editions.has_lineup = true` for populated editions, normalize existing `logged_events.country` variants, and fix `event_editions` `country = 'WA'`.
  - **Follow-up (with Charlie's direction):** Merge duplicate `"lost in dreams 2025"` edition, wire `clashfinder_slugs` capture on match, decide auto-link vs. Fill-gaps offer for the `122` exact-match unlinked events, and surface a non-blocking Notice v2 re-consent banner for v1 members.

#### P2.2 Email Import Funnel Cleanup & Eventbrite Calendar-Venue Guard
- **Observed evidence:** `email_imports` (`1,835` rows) includes `~700+` non-ticket retail/shipping messages (`livingsocial.com` 278, `bestbuy.com` 35, `usps.com` 22, `amazon.com` 22, `newegg.com` 16, `michaels.com` 16), `34` remaining Eventbrite rows carrying `"Add to Google · Outlook · iCal · Yahoo"` as `venue` (`30` in `status = 'new'`), `68` unreadable `Sickening.events` emails (82% fail rate), and `100%` missing city on `Tixr` (`30/30`).
- **Spec:**
  - **Slice 21.3:** Harden `src/server/events/email/eventbrite.ts` (`isCalendarLine` matching both token lines and combined `"Add to Google · Outlook · iCal · Yahoo"` lines) and strip calendar-footer `venue` values in `src/server/events/email/imports.ts` when staging or materializing events.
  - **Slice 21.4 (`0054`):** Clean `data->>'venue'` on the remaining `34` legacy Eventbrite rows in `email_imports`.
  - **Follow-up:** Tighten Gmail forward query (`scan.ts`) to require seller domains with ticket keywords/exclusions for retail blasts, investigate `Sickening.events` templates, and inherit city from `venue_aliases` -> `canonical_venues` during email import.

#### P2.3 Lineup Normalization & Stale `needs_review` Jobs
- **Observed evidence:** In `corrections` (`608` `renamed` rows), `418 (68.8%)` are case/whitespace-only, `90 (14.8%)` strip parenthetical modifiers, and `36 (5.9%)` are punctuation-only — only `64 (10.5%)` are substantive renames. Also `20 of 48` `needs_review` `lookup_jobs` point to editions that already have confirmed `performances`.
- **Spec (Slice 21.3):** Seed `spellings` in `src/server/lineup/pipeline.ts` from `canonical_artists` before overlaying `yourSpellings(seenNames)` (user spelling still wins; catalog artists stop surfacing as ALL-CAPS from Clashfinder). Follow-up: auto-reconcile superseded `needs_review` jobs.

---

### P3 — Observability & Operational Hygiene

1. **Silent public door auth check (Slice 21.2):** In `src/server/share/door.ts` (`isSignedIn`), return `false` when no `CF_Authorization` cookie is present before invoking `verify`, eliminating `Access token refused: no Access token on the request` warnings on `/` and `/demo`.
2. **Trace `subrequests` everywhere (Slices 21.1 & 21.2):** Populate `trace.subrequests(...)` in `runQueuedResearch` (`details.ts`) and cron backfill traces (`worker/index.ts`).
3. **Operator Worker & observability toggles (manual):**
   - Enable Cloudflare Workers **Issues** detection on `concert-tracker`.
   - Extend `concert-tracker-lookups-dlq` retention beyond 24h or alert on non-empty DLQ.
   - Pin `GEMINI_EXTRACTION_MODEL` in [wrangler.jsonc](../../wrangler.jsonc) to an explicit dated model version (rather than `-latest`) per [REQUIREMENTS.md](../../REQUIREMENTS.md) R2.10.
   - Confirm Undo affordance discoverability in Global Archive (`0 of 593` `edition_changes` have been undone).
   - Standardize on `supabase db push` / `schema_migrations` tracking so production schema state matches `supabase/migrations/`.

---

## 3. Confidence Tiers & Telemetry Blind Spots

- **Directly proven (code + live logs/DB):** `GET /api/canon/lineup-offers` 500s (`N+1` `getEdition`); Brave `187/200` burn from member batch (`55/63` runs); `5,083` daily `createStore()` cold-start probes; `SOURCE_CACHE` off (`0` rows); `refused_hosts` written to `user_settings`; obsolete `app_settings` rows + `SECURITY DEFINER` RPCs + open `0001` policies; all table/column/drift counts.
- **Strong link with caveats:** Total Supabase call reduction from idle cron + probe fixes is estimated at **~53% on active days (~13,900 of 26,369 calls)** and higher on idle days. Root cause of earlier `lineup/status` & `editions/:id` `exceededCpu` 503s cannot be stack-traced because Cloudflare `traces.enabled` is `false`, though 0 recurred after PRs `#577`/`#579`.
- **Blind spots to close next:**
  1. Cloudflare Issues disabled + 24h DLQ retention.
  2. No accept/dismiss precision attribution per research finder in `ingest_traces` or `logged_events`.
  3. `brave_monthly` lacks per-feature breakdown (addressed incrementally in `BraveCount.bySource` in Slice 21.1).
  4. `activity_log` lacks an `actor` column (human vs. system); `logged_events` lacks `origin` and `delete_reason`.
  5. `schema_migrations` tracks only 2 of 53 applied migrations.
  6. No client-side error reporting for blank renders or silent frontend fetch failures.

---

## 4. Rollout Breakdown (Slices 21.1–21.4)

- **Slice 21.1 (P0 Stability):** Save this spec + batch `/canon/lineup-offers` + reserve 60 interactive Brave queries + skip past-year Ticketmaster calls + scope `refused_hosts` globally + trace `research` subrequests + turn on `SOURCE_CACHE=on`.
- **Slice 21.2 (P1 Egress & P3 Hygiene):** Remove `createStore({ requireSupabase: true })` startup probes + batch `memberBackfill` settings & pre-check pending research IDs + sync `has_lineup` on write + silence anonymous `isSignedIn` warnings + cron `subrequests` traces.
- **Slice 21.3 (P2 Quality):** Harden Eventbrite `isCalendarLine` & strip legacy calendar venues on import + seed lineup `spellings` from `canonical_artists` (preferring scoped `getArtists(claimKeys)`) + normalize country display aliases (`USA`/`US` -> `United States`).
- **Slice 21.4 (Migration `0054` & Docs):** Write additive SQL migration `supabase/migrations/0054_db_perf_rls_and_lineup_flag.sql` (for Charlie to review & apply) + update [02-stage-1-capture-and-details.md](../architecture/02-stage-1-capture-and-details.md), [12-data-model.md](../architecture/12-data-model.md), and [16-hosting.md](../architecture/16-hosting.md).

---

## 5. Execution Checkpoint (Interrupt / Restart Log)

- **Branch & worktree:** `feat/db-logs-improvement-pass` in `.worktrees/db-logs-improvement-pass` (off `origin/main` `52d8d76`; keeps root repo's untracked `lookup-audit.md` untouched).
- **Slice 21.1 (committed `fad7a47`, `Referee-Verdict: VERIFIED`):** Saved spec, batched `/api/canon/lineup-offers` (`getEditions`), added Brave 60/200 interactive reserve + 140 batch cap + `bySource`, skipped past-year Ticketmaster searches when `now` given, scoped `refused_hosts` to `catalogStore`, traced `research` subrequests, set `SOURCE_CACHE=on`, added `tests/improvementPassP0.test.ts`.
- **Slice 21.2 (committed `88c690e`, `Referee-Verdict: VERIFIED`):** Skipped 3 cold-start probes when `requireSupabase: true`, returned `false` early in `isSignedIn` without `CF_Authorization`, added `listUserSettingsByKeys` + `listPendingResearchUserIds` cron fast-paths, synced `has_lineup` in `upsertEdition`, recorded cron `subrequests`, added `tests/improvementPassP1.test.ts`.
- **Slice 21.3 (committed `bea0d54`, `Referee-Verdict: VERIFIED`):** Hardened Eventbrite `isCalendarLine` + `imports.ts` calendar-venue stripping on both parse and materialization/merge, seeded lineup `spellings` in `stageMerge` from `canonical_artists` via `getArtists(claimKeys)` (member seen spellings still win), exported `normalizeCountryDisplay` and applied on `country` patches in `applyPatch`, updated spec RPC & checkpoint docs, and added `tests/improvementPassP2.test.ts` (`full npm test` pass).
- **Slice 21.4 (`[x]`, anchored `1609c6c`):** Added additive idempotent `supabase/migrations/0054_db_perf_rls_and_lineup_flag.sql` (retaining `authenticated` on `canonical_*` & `owner_user_id()`, dropping 4 open `0001` policies, rewriting 19 RLS initplan policies with `(select ...)`, adding 12 indexes, adding 4 guarded composite PKs, running 5 safe data repairs, and commenting out optional operator drops/deletes), updated architecture docs (`02-stage-1-capture-and-details.md`, `12-data-model.md`, `16-hosting.md`), and added `tests/migration0054.test.ts` (all verified before commit via lint + full test suite).
- **Operator apply remaining (manual post-merge):**
  1. Review and run [0054_db_perf_rls_and_lineup_flag.sql](../../supabase/migrations/0054_db_perf_rls_and_lineup_flag.sql) in the Supabase SQL Editor.
  2. Decide & optionally run the commented cleanup block at the bottom of `0054` (4 empty `0001` tables + 6 obsolete `app_settings` keys).
  3. Enable Cloudflare Workers Issues detection on `concert-tracker` and pin `GEMINI_EXTRACTION_MODEL` in [wrangler.jsonc](../../wrangler.jsonc).
