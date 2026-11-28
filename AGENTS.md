# Rules for anyone changing this app

Read [REQUIREMENTS.md](REQUIREMENTS.md) (purpose and principles) and [ARCHITECTURE.md](ARCHITECTURE.md) before changing capture, lookup, storage, or review. If a change conflicts with them, update REQUIREMENTS.md or ARCHITECTURE.md first and explain why.

## Data, sourcing & AI reader
- **Never invent data:** Never default or guess a lineup, date, venue, stage, rating, or setlist, or let a model answer from memory. Missing data stays missing. Inferred values require a stated reason, named inputs, and the "Inferred" label—never over typed/verified values, never counted toward verification, and never for dates (`docs/specs/inferred-values.md`).
- **Verbatim citations:** Every stored act must reference a stored source document and quoted span. Reject any name not found verbatim after normalization; never loosen `isVerbatim`.
- **Guarded reader & quota:** Every model call goes through `src/server/reader/` (spend guards + circuit breaker first, one `ai_calls` row after, no page text logged, no provider switching). On quota errors, park the job and stop—never retry another model or fall back to regex.
- **Billing, scale & format:** Store billing roles only with explicit marker words and acts on each side (`src/server/lineup/billing.ts`), never from list order or font size (except display-only inferred Headliner when a concert is named after one act). Concert/Festival is worked out in code (`src/server/events/scale.ts`); store only the person's choice. Format is the person's own words.
- **Set times & weather:** Set times come only from timed sources or owner-pasted text (`src/server/lineup/pasted.ts`, never fetched). Weather is looked up only when asked or once per edition for an unambiguous city, stored with its URL, refreshed only by admin request, and skipped for month-only events.
- **No hardcoded lists & rate limits:** Never hardcode festivals, venues, or artists; update adapters under `src/server/lineup/adapters/`. Use the shared rate-limited fetcher (MusicBrainz 1 req/s). Never scrape AXS.

## Capture, email & sample mode
- **Two-stage capture:** Saving (stage 1) never waits on research, quota, or lineups; lineup lookup (stage 2) starts only when asked. Parse the one-line capture in code (`src/server/events/parse.ts`), never with a model. New personal fields go on event detail. Suggestions are one-tap offers.
- **Stage 1 AI bounds:** The reader model runs in stage 1 only via "Deep search with AI" or rung 4 of research (<=2 fetched pages, <30,000 chars each, inside spend guards, queued after save; dates read in code from quotes). Never call it during save, plain "Look again", or Fill gaps; never overwrite typed fields.
- **Ticket emails:** Parsed only by per-seller code under `src/server/events/email/`, never by Gemini. Imported shows become events or merge into empty fields only when picked (undoable), filling no personal fields except derived per-ticket price when unset/uncleared (`docs/architecture/04-stage-1-from-email.md`).
- **Sample mode & public pages:** No demo/seeded data in the real app. Sample mode (`src/demo/sampleData.ts`, dynamic import) runs only at start-up (`/demo` or uninvited account), never on network error, never writes to the DB, and labels every page as sample. List every public base-URL page in `PUBLIC_EXACT_PATHS` (`src/server/site/publicPaths.ts`); keep `/app` and `/api` off it.

## Shared catalog, verification & privacy
- **Strict separation:** Keep canonical lineups and personal logs (`logged_events`) separate. Shared tables, traces, logs, and the review queue never hold personal fields (companions, notes, rating, price, attendance). Linked events show edition values unless overridden; original input stays in `captured`.
- **Audited, undoable writes:** Every shared-edition change goes through `writeEdition` (logged in `edition_changes`, undoable). Member entries may create `provisional` shared editions (name, date, venue, city, state only). Ticket email imports that become events are verified sources.
- **Auto-verify & venue fill:** An act is verified by one trusted source (ticket email, fetched promoter/lineup page, pasted set times, API record), two agreeing fetched sources, or two different members ticking it (counted in memory only, `src/server/canon/memberTick.ts`); setlist.fm IDs or one tick alone never verify. Editions auto-verify only when name, act, location, venue, and date all come from verified sources; never overwrite owner values or auto-demote (`docs/auto-verify-spec.md`). Known venues fill only empty location fields (`docs/specs/venue-location-fill.md`).
- **Shared artist genres, taxonomy & orbits:** Genres are shared (`writeArtistGenres`, logged in `artist_genre_changes`, undoable), from music-story, MusicBrainz (via music-story's map), or the owner (owner wins, ranked 1.0/0.70/0.45/0.25; music-story and MusicBrainz weights stay as sent). Never infer a genre. Member additions (`user_artist_genres`) layer on top for that member only. Members receive genres/orbits only for their own acts; the owner's export uses `seen_act_names()` (names only). Vocabulary, taxonomy, and orbits change only via `writeGenreVocabulary` / `writeArtistOrbits` (logged, undoable): totals resolve through aliases to `primary_parent_key` at read time, never through a stored `parent`; umbrellas, orbits, and `genre_relations` never add to a total. System `artist_cooccur`/`lineup_cooccur` links are computed only from shared tables (`artist_genres`, `performances`), never over a `curated` row. No relation is computed from any member's events, attendance or companions. Details: [docs/architecture/07-artist-genres.md](docs/architecture/07-artist-genres.md).

## Engineering & design system
- **Design system:** Shared UI lives in `src/components/ui/` and styles in `src/styles/` (`docs/design-system/design-system.json`, `docs/specs/landing-look.md`). Use semantic `--la-*` tokens, `PosterHeading` for titles, `PostIt` for callouts, and `--la-second` (`text-second`) for the secondary color. Migrate inline copies when touched; update `docs/design-system/` in the same change.
- **Workflow & docs:** Run `npm run lint` and `npm test` before committing; add tests for new adapters/rules. Update `ARCHITECTURE.md` (and `REQUIREMENTS.md` if needed) in the same change. For new subsystems or >3 architectural areas, present the plan first and wait for confirmation. Store multi-step plans under `docs/` or `specs/`.

<!-- >>> harness >>> -->
## Harness Sector 000 Card Catalog (Falcon Protocol)

You are **THE FALCON (`fa`)**, the main session. Coordinate the work and hand slice-sized edits to subagents. The full rules are in `.claude/harness-rules.md` (Claude Code also loads `CLAUDE.md`); this block keeps only what an agent that reads nothing else needs.

### 1. Dispatch
- An `[IN_PROGRESS]` slice in `.spec/PROGRESS.md` with known `Target files:`: dispatch `gf-coder`.
- Requirements unclear, `Target files:` unknown, or `.spec/BLACK_BOX.md` exists: dispatch `el-architect`.
- Fast-path budget for the main session (`fa_fast_path` in `.harness/config/thresholds.json`): 3 source reads, 1 search, 1 single-file edit of at most 25 lines. Delegate before you go over; the hooks only warn.
- Antigravity: subagent payloads for `define_subagent` are in `.harness/agents/runtime-payloads.json`.

### 2. Slices and checks
- Start a slice with `node .harness/scripts/start-slice.mjs` and finish it with `node .harness/scripts/finish-slice.mjs "<msg>"`, which marks it `[x]` and stamps the Referee trailers.
- Run the project's typecheck, lint and test commands (see `CLAUDE.md`, Project-Specific Commands) once after the final edit.
- Open only the Atlas coordinates a slice's `Coords:` names (`.spec/ATLAS.md`).

### 3. Deploys and merges (mandatory)
- **Zero local deploys:** never run `npm run deploy` or `wrangler deploy` locally. Production deploys run only in GitHub Actions when a PR merges into `main`.
- **Up to date before merge:** if the branch is behind `main`, merge `origin/main` into it (never rebase or force-push a shared branch), then re-run the checks.
- **Definition of done:** do not report "done" after local edits alone—commit on a clean branch off `origin/main`, open a PR, wait for checks, merge to `main`, and verify the production deployment succeeds (unless asked for local-only or review first). Keep harness syncs separate from feature PRs.
<!-- <<< harness <<< -->
