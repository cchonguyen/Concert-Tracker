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
- [x] **Slice 44.1: Ticket style picker** [UI / VISUAL] Per-device ticket style: Original, Box office, Hard ticket, Raffle, Riso. Target files: src/services/theme.ts, src/components/ThemePicker.tsx, src/index.css, src/styles/ticket-styles.css, app.html, tests/theme.test.ts, tests/ticketStyles.test.ts, docs/specs/ticket-stub-styles.md, docs/README.md | Issue: #1099 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 45.1: Landing look shared parts and heartbeat logo** [UI / VISUAL] docs/specs/landing-look.md. Target files: src/styles/landing-look.css, src/index.css, src/components/ui/PosterHeading.tsx, src/components/ui/PostIt.tsx, src/components/ui/AppBackdrop.tsx, src/components/ui/Logo.tsx, src/components/ui/Button.tsx, src/App.tsx, index.html, public/logo-heartbeat.svg, src/server/site/publicPaths.ts, tests/landingLook.test.ts, docs/specs/landing-look.md, docs/README.md, docs/architecture/15-shared-ui.md, docs/architecture/18-public-pages.md, docs/design-system/README.md | Issue: #1103 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 45.2: Landing look on Home** [UI / VISUAL] docs/specs/landing-look.md. Target files: src/components/HomePage.tsx, src/components/FeatureTiles.tsx, docs/specs/landing-look.md | Issue: #1105 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 45.3: Landing look on Event detail** [UI / VISUAL] docs/specs/landing-look.md. Target files: src/components/EventDetail.tsx, docs/specs/landing-look.md | Issue: #1108 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 45.4: Landing look on Library and Explore pages** [UI / VISUAL] docs/specs/landing-look.md. Target files: src/App.tsx, src/components/ui/StubHeader.tsx, src/components/StatsView.tsx, src/components/PeopleRanking.tsx, src/components/GenresRanking.tsx, src/components/MapView.tsx, src/components/LogView.tsx, docs/specs/landing-look.md | Issue: #1111 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 45.5: Landing look on Manage, panels and dialogs** [UI / VISUAL] docs/specs/landing-look.md. Target files: src/components/ManageView.tsx, src/components/ui/Sheet.tsx, src/components/ui/Confirm.tsx, src/components/ImportReview.tsx, src/components/AccountPanel.tsx, src/components/ListImport.tsx, src/components/SeriesPanel.tsx, src/components/FillGaps.tsx, src/components/ArtistGenresPanel.tsx, src/components/EmailCard.tsx, src/components/AboutDialog.tsx, src/components/LegalDialog.tsx, src/components/MembersPanel.tsx, src/components/SheetSync.tsx, src/components/NoticeModal.tsx, src/components/GenreStory.tsx, src/components/QuickAdd.tsx, docs/specs/landing-look.md | Issue: #1114 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 45.6: Home page links as post-its** [UI / VISUAL] docs/specs/landing-look.md. Target files: src/components/HomePage.tsx, src/components/ui/PostIt.tsx, docs/specs/landing-look.md, docs/design-system/design-system.json | Issue: #1123 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 45.7: Summary count tiles as post-its** [UI / VISUAL] docs/specs/landing-look.md. Target files: src/components/EventsHome.tsx, docs/specs/landing-look.md | Issue: #1129 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 45.8: Ranking and Stats count tiles as post-its** [UI / VISUAL] docs/specs/landing-look.md. Target files: src/components/ArtistsView.tsx, src/components/StatsView.tsx, src/components/GenreStory.tsx, docs/specs/landing-look.md | Issue: #1133 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 46.1: Button glow and pop** [UI / VISUAL] docs/specs/landing-look.md. Target files: src/styles/landing-look.css, src/components/QuickAdd.tsx, src/components/ui/IconButton.tsx, src/components/ui/MenuButton.tsx | Issue: #1135 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 46.2: Sliding highlight on Agenda order and Ranking sort and view** [UI / VISUAL] docs/specs/landing-look.md. Target files: src/components/ui/Segmented.tsx, src/components/timeline/AgendaView.tsx, src/components/ArtistsView.tsx, docs/specs/landing-look.md | Issue: #1139 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 46.3: Sliding highlight on Stats years, Event weekends and things left** [UI / VISUAL] docs/specs/landing-look.md. Target files: src/components/StatsView.tsx, src/components/EventDetail.tsx, src/components/PosterHeader.tsx, docs/design-system/design-system.json | Issue: #1140 | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 46.4: Playful tabs** [IN_PROGRESS] [UI / VISUAL] docs/specs/landing-look.md. Target files: src/components/ui/Tabs.tsx, docs/specs/landing-look.md, docs/design-system/design-system.json | Issue: #1147 | Verify: npm run lint --silent && npm test --silent

## Global Archive & Table sync
- [x] **Slice 38.996: Match verified editions by seriesSlug/aliases and refresh events after Global Archive edits** [CORE / DATA] Pass seriesSlug through LookupInput/startLineupLookup, match verified editions by seriesSlug/seriesName/seriesAliases in findVerifiedEdition, fall back from job.editionId in confirmLookup, and refresh App events after Global Archive edits. Target files: src/server/lineup/types.ts, src/server/lineup/pipeline.ts, src/server/canon/match.ts, src/server/events/service.ts, src/server/lineup/learning.ts, src/components/ManageView.tsx, src/components/CanonicalArchive.tsx, tests/canonMatch.test.ts | Coords: [400, 12-data-model, 13-api] | Verify: npm run typecheck --silent && npm run lint --silent && npm test --silent
- [x] **Slice 47.1130: Stop Library Table page scrolling past the table** [UI / VISUAL] On-the-fly: Charlie reported endless scroll below Library Table Target files: src/components/TableView.tsx | Issue: #1130 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 47.1137: Series sync: auto-link events that exactly match one verified edition** [CORE / DATA] On-the-fly: Charlie 2026-11-27: Link automatically, undoable; Everyone's, start building Target files: src/server/canon/autoLink.ts, src/server/events/inherit.ts, worker/index.ts, tests/autoLink.test.ts, src/server/events/types.ts | Issue: #1137 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 48.1: Count B2B sets as whole viewings per artist or named combo** [CORE / DATA] Count each B2B artist as 1 viewing (or 1 for the combo when alias has genres), and format Ranking/Stats subtitles with formatSets. Target files: src/services/genres.ts, src/services/genreInsights.ts, src/components/GenreConstellation.tsx, src/components/GenresRanking.tsx, src/components/StatsView.tsx, src/server/events/genreRoutes.ts, src/services/lineupApi.ts, tests/genres.test.ts, tests/genreInsights.test.ts, docs/architecture/07-artist-genres.md, docs/specs/genre-taxonomy-release-1.md, docs/specs/genre-taxonomy-release-2.md | Verify: npm run typecheck --silent && npm run lint --silent && npm test --silent
