# LiveArchive architecture

This is the source of truth for how LiveArchive captures events, finds lineups and stores what you have seen. Anyone changing the app, person or AI agent, should read it first and keep it current. What the app is for, and the principles behind it, are in [REQUIREMENTS.md](REQUIREMENTS.md); the rules an agent must follow are summarized in [AGENTS.md](AGENTS.md).

## Goal

You type one line about an event you went to. It is saved at once (stage 1), and the app looks up its date and place from structured sources, suggesting rather than overwriting. Later, whenever you like, you ask it to find who played (stage 2): it finds the lineup with a citation for every act, lets you confirm it and tick who you saw, and stores the result so the same edition never has to be looked up again. When an API has no capacity, the lookup waits in a queue. It never guesses.

## Invariants

These are enforced in code. A change that breaks one is a bug, even if the output looks more complete.

1. **No claim without evidence.** Every act in a lineup carries at least one source URL and the text it was found in (`PerformerClaim.quotedSpan`). Facts (dates, venue) carry their source too.
2. **The reader model is a reader, never a memory.** The reader model (Gemini today) only extracts names from text the app fetched and stored. A name is kept only if its quoted span occurs in the stored page and the name occurs in the span (`isVerbatim` in `src/server/lineup/text.ts`).
3. **Confidence is computed, never asked for.** It comes from which sources agree and how often each source has been right in your reviews (`src/server/lineup/merge.ts`). No model is asked for a confidence score, a URL it did not find, or a date it was not shown.
4. **Empty is a valid answer.** If no source lists a lineup, the lookup ends as `no_data` and you enter acts by hand. There are no default dates, cities, venues, stages, ratings or setlists anywhere.
5. **Resolve once, reuse forever.** An edition (series plus date, or year when the date is unknown) is confirmed once; later lookups read it from the database with zero network calls.
6. **Quota is a resource, not an error path.** Every model call passes the guarded reader (`src/server/reader/`), which tracks the call budget and a spend budget and parks a job with a retry time when capacity runs out (see [Quota and the queue](docs/architecture/10-quota-and-the-queue.md)). There is no fallback model cascade and no heuristic substitute.
7. **The lineup is a fact about the world; what you saw is a fact about you.** Canonical editions and your event log are stored separately. "Artists" counts only acts you marked as seen.
8. **No hardcoded knowledge.** No lists of festivals, venues or artists in code. Fix a data source or add an adapter instead.
9. **Your word wins.** Stage 1 suggestions never overwrite a field you typed. Every event field records its source (`LoggedEvent.sources`): you, or a source URL.

## Sections

Each section lives in its own file under `docs/architecture/`:

- [Two stages](docs/architecture/01-two-stages.md)
- [Stage 1: capture and details](docs/architecture/02-stage-1-capture-and-details.md)
- [Artist, Supporting and type](docs/architecture/03-artist-supporting-and-type.md)
- [Stage 1 from email](docs/architecture/04-stage-1-from-email.md)
- [Importing a list](docs/architecture/05-importing-a-list.md)
- [Google Sheets sync](docs/architecture/06-google-sheets-sync.md)
- [Artist genres](docs/architecture/07-artist-genres.md)
- [Sources](docs/architecture/08-sources.md)
- [Lookup pipeline](docs/architecture/09-lookup-pipeline.md)
- [Quota and the queue](docs/architecture/10-quota-and-the-queue.md)
- [Learning loops](docs/architecture/11-learning-loops.md)
- [Data model](docs/architecture/12-data-model.md)
- [API](docs/architecture/13-api.md)
- [Navigation and Home](docs/architecture/14-navigation-and-home.md)
- [Shared UI](docs/architecture/15-shared-ui.md)
- [Hosting](docs/architecture/16-hosting.md)
- [Share page](docs/architecture/17-share-page.md)
- [Public pages](docs/architecture/18-public-pages.md)
- [Multi-user](docs/architecture/19-multi-user.md)
- [Activity log and Recently deleted](docs/architecture/20-activity-log-and-recently-deleted.md)
- [Configuration](docs/architecture/21-configuration.md)
- [Testing](docs/architecture/22-testing.md)
- [Roadmap](docs/architecture/23-roadmap.md)
- [Release checks (S4)](docs/architecture/24-release-checks-s4.md)

Artist genres as a spreadsheet (Slices 34.1 to 34.5; see [docs/architecture/07-artist-genres.md](docs/architecture/07-artist-genres.md) and [docs/specs/genres-csv.md](docs/specs/genres-csv.md)): in the owner's Genres panel you download a CSV of the acts you can give genres, type genres in its "New genres" column and upload it back. The browser reads the file and the server matches rows only by MusicBrainz ID or exact name, flags acts changed in the app since the download, and saves nothing until Apply. Each upload can be undone once. No model is involved; the genres are the person's own (`you`).

Shared editions from member entries (Slice 11.23): the research queue message also saves a `provisional` edition from the person's own typed name, full date, venue and city (never personal fields; skipped on a verified match). The member notice is version 2. See docs/architecture/08-sources.md and 12-data-model.md. Owner review (Slices 12.1 to 12.5): Global archive > Editions & Lineups lists editions by status (All, Verified, Provisional, Drafts); "Verify for everyone" on a provisional edition (`POST /api/manage/canonical/editions/:id/verify`, through `writeEdition`, undoable) makes it `verified`, and only verified (and legacy confirmed) editions autofill for members. The owner sees provisional editions (name, date, venue, city) and never another member's private events or identity. Series saves (Global archive > series, `PATCH /api/manage/canonical/series/:slug`) are logged as one `canonical-series` history entry with the full record before and after, and can be undone (Series type fix, Slice 1; `saveSeriesLogged` in `src/server/entities/canonicalManage.ts`). A series with no type is "Not set" (migration 0053), never festival by default: a series created from an edition has no type until someone picks one (slice 3).

Auto-verify and member ticks (approved 2026-11-18; see [docs/auto-verify-spec.md](docs/auto-verify-spec.md)): acts carry a `candidate` or `verified` status, and a member's tick enters as a candidate with source `your entry`. A verified act comes from a fetched and stored source with the same name and date, and a complete edition (name, act, location, venue, date) becomes `verified` in code. Every change goes through `writeEdition` with a system actor and reason, and can be undone. The rules are in AGENTS.md (approved 2026-11-18). Built in slices 2 to 5: verification functions, writes and undo, Global Archive display (candidate pill), and the member tick from Who I Saw.
