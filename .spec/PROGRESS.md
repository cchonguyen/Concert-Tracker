# Task Progress & Single-Slice Work Lock
> Rule: Mark only ONE task line at a time with the active work tag.
Finished slices move to `.spec/archive/HISTORY.md`. Earlier feature sections (share page, Manage, Tier 3, Global archive, ingest canon, canon review, series, Global Editions, harness rollout) have no open slices and were removed on 2026-11-23; their slices are in HISTORY.md and their specs are listed in `docs/README.md`.
## LiveArchive 2.0 design refresh
Stage 0, Track A and "Ledger & Lobby" are done (22.x, 23.x, 24.x); those slices are in `.spec/archive/HISTORY-2026-11.md`.
## LiveArchive 2.0 stage 2 (spec section 8, approved by Charlie 2026-11-24 PT)
Track C (Claude) and the Gemini package "Back Office" run in parallel. Claude's slices get their issue when they start.
Every stage 2 slice (25.x, 26.x) is done; they are in `.spec/archive/HISTORY-2026-11.md`.
## Ticket stub (docs/specs/ticket-stub.md, design approved by Charlie 2026-11-25 PT; waiting on his go for the plan)
Its 21 finished slices (29.x) are in `.spec/archive/HISTORY-2026-11.md`.
## Artist genres CSV (docs/specs/genres-csv.md)
Every slice (34.x) is done; see `.spec/archive/HISTORY-2026-11.md`.
## Shared artist genres (docs/specs/canonical-genres.md)
Every slice (35.x) is done; see `.spec/archive/HISTORY.md`.
## Phase 1 Artist Entity Cleanup (docs/specs/artist-entity-cleanup.md, approved by Charlie 2026-11-26; migration 0061, Charlie applied it)
Every slice (37.x) is done; see `.spec/archive/HISTORY-2026-11.md`.
## Genres in Explore (docs/specs/genre-explore.md, ideas and tab changes approved by Charlie 2026-11-26 PT; planned for Gemini; no migration; issues opened before each slice starts)
Every slice (38.x) is done; see `.spec/archive/HISTORY-2026-11.md`. 38.5 and 38.8 are replaced in Release 1 (40.3, 40.5).
## Genre taxonomy, Phase A (docs/specs/genre-taxonomy-phase-a.md, plan approved by Charlie 2026-11-27 PT; migration 0063, held until applied; 39.1 waits on his OK for the rule wording)
Finished slices (39.x) are in `.spec/archive/HISTORY-2026-11.md`.
## Genre taxonomy, Release 1 (docs/specs/genre-taxonomy-release-1.md, plan approved by Charlie 2026-11-27 PT; no migration)
Every slice (40.x) is done; see `.spec/archive/HISTORY-2026-11.md`.
## Genre taxonomy, Release 2 (docs/specs/genre-taxonomy-release-2.md, plan approved by Charlie 2026-11-27 PT; no migration; 41.0 not needed)
Every slice (41.x) is done; see `.spec/archive/HISTORY-2026-11.md`.

## Landing page 2 (docs/specs/landing-page-2.md, approved by Charlie 2026-11-27)
Done; see `.spec/archive/HISTORY-2026-11.md`.

## Genre taxonomy, Release 3 (docs/specs/genre-taxonomy-release-3.md, plan approved by Charlie 2026-11-27 PT with the AGENTS.md line; migration 0064, held until applied)
Every slice (43.x, plus its re-verify slices) is done; see `.spec/archive/HISTORY-2026-11.md`.

## Genre charts by family (Charlie 2026-11-27: macros too broad; no migration)
- [x] **Slice 47.1: Group genre charts by scene family** [CORE / DATA] shareGroup returns the family under a taxonomy; Stats genre map lists families. Target files: src/server/events/genreVocabulary.ts, src/components/StatsView.tsx, src/components/ArtistsView.tsx, src/components/PeopleRanking.tsx, src/services/genres.ts, tests/genreInsights.test.ts, tests/genreTaxonomy.test.ts, docs/architecture/07-artist-genres.md | Issue: #1121 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 47.1125: Colour dots beside genre names in Ranking** [UI / VISUAL] On-the-fly: Charlie asked for colour dots next to genre names in Ranking Target files: src/components/GenresRanking.tsx | Issue: #1125 | Verify: npm run lint --silent

## Ticket stub styles (docs/specs/ticket-stub-styles.md, approved by Charlie 2026-11-27)

## Global Archive & Table sync
- [x] **Slice 38.996: Match verified editions by seriesSlug/aliases and refresh events after Global Archive edits** [CORE / DATA] Pass seriesSlug through LookupInput/startLineupLookup, match verified editions by seriesSlug/seriesName/seriesAliases in findVerifiedEdition, fall back from job.editionId in confirmLookup, and refresh App events after Global Archive edits. Target files: src/server/lineup/types.ts, src/server/lineup/pipeline.ts, src/server/canon/match.ts, src/server/events/service.ts, src/server/lineup/learning.ts, src/components/ManageView.tsx, src/components/CanonicalArchive.tsx, tests/canonMatch.test.ts | Coords: [400, 12-data-model, 13-api] | Verify: npm run typecheck --silent && npm run lint --silent && npm test --silent
- [x] **Slice 47.1130: Stop Library Table page scrolling past the table** [UI / VISUAL] On-the-fly: Charlie reported endless scroll below Library Table Target files: src/components/TableView.tsx | Issue: #1130 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 47.1137: Series sync: auto-link events that exactly match one verified edition** [CORE / DATA] On-the-fly: Charlie 2026-11-27: Link automatically, undoable; Everyone's, start building Target files: src/server/canon/autoLink.ts, src/server/events/inherit.ts, worker/index.ts, tests/autoLink.test.ts, src/server/events/types.ts | Issue: #1137 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 48.1: Count B2B sets as whole viewings per artist or named combo** [CORE / DATA] Count each B2B artist as 1 viewing (or 1 for the combo when alias has genres), and format Ranking/Stats subtitles with formatSets. Target files: src/services/genres.ts, src/services/genreInsights.ts, src/components/GenreConstellation.tsx, src/components/GenresRanking.tsx, src/components/StatsView.tsx, src/server/events/genreRoutes.ts, src/services/lineupApi.ts, tests/genres.test.ts, tests/genreInsights.test.ts, docs/architecture/07-artist-genres.md, docs/specs/genre-taxonomy-release-1.md, docs/specs/genre-taxonomy-release-2.md | Verify: npm run typecheck --silent && npm run lint --silent && npm test --silent
- [x] **Slice 48.1145: Series sync: linked events contribute back to shared editions** [CORE / DATA] On-the-fly: Charlie 2026-11-27: information that lines up goes to shared editions Target files: src/server/canon/autoLink.ts, src/server/events/inherit.ts, src/server/events/types.ts, tests/autoLink.test.ts | Issue: #1145 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 48.1149: Series sync: show automatic links with Unlink** [UI / VISUAL] On-the-fly: Charlie 2026-11-27: Link automatically, undoable Target files: src/components/EventDetail.tsx, src/components/DataHealth.tsx, src/services/dataHealth.ts, src/services/lineupApi.ts, tests/dataHealthAutoLinks.test.ts, docs/specs/series-sync.md | Issue: #1149 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 48.1160: Series sync: two members ticking the same act verify it** [CORE / DATA] On-the-fly: Charlie chose: Yes, two members verify it Target files: src/server/canon/memberTick.ts, src/server/canon/autoLink.ts, tests/autoLink.test.ts | Issue: #1160 | Verify: npm run lint --silent && npm test --silent
