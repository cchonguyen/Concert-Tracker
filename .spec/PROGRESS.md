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
- [x] **Slice 42.1: Landing page 2** [UI / VISUAL] Direction D landing page (docs/specs/landing-page-2.md). Target files: index.html, src/landing/home.jpg, src/landing/timeline.jpg, src/landing/ranking.jpg, src/landing/detail.jpg, docs/specs/landing-page-2.md, docs/architecture/18-public-pages.md | Issue: #1083 | Verify: npm run lint --silent && npm test --silent

## Genre taxonomy, Release 3 (docs/specs/genre-taxonomy-release-3.md, plan approved by Charlie 2026-11-27 PT with the AGENTS.md line; migration 0064, held until applied)
- [ ] **Slice 42.5: Bill links maths** [IN_PROGRESS] [CORE / DATA] lineupCooccur NPMI over stage or edition bills (section 6). Target files: src/server/events/lineupCooccur.ts, tests/lineupCooccur.test.ts | Issue: #1088 | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 42.6: Bill links job** [CORE / DATA] owner preview and apply of lineup_cooccur links, undoable (section 7). Target files: src/server/events/genreRoutes.ts, src/components/GenresPanel.tsx, src/services/lineupApi.ts, tests/lineupCooccurRoute.test.ts | Issue: #1089 | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 42.7: One step outside your lane** [CORE / DATA] outsideLane and its card (section 8). Target files: src/services/genreInsights.ts, src/components/GenreStory.tsx, tests/genreInsights.test.ts | Issue: #1090 | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 42.8: Constellation** [UI / VISUAL] opt-in radial genre map (section 9). Target files: src/components/GenreConstellation.tsx, src/components/GenreStory.tsx | Issue: #1091 | Verify: npm run lint --silent
- [ ] **Slice 42.0: Rule wording for orbits** [CORE / DATA] (section 1). Target files: AGENTS.md, ARCHITECTURE.md | Issue: #1092 | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 42.1: Migration 0064** [CORE / DATA] artist orbits tables, held until applied (section 2). Target files: supabase/migrations/0064_artist_orbits.sql, tests/migration0064.test.ts | Issue: #1093 | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 42.2: Orbit store and write path** [CORE / DATA] (section 3). Target files: src/server/events/artistOrbits.ts, src/server/lineup/store/fileStore.ts, src/server/lineup/store/supabaseStore.ts, src/server/lineup/store/types.ts, src/server/events/genreRoutes.ts, tests/artistOrbits.test.ts | Issue: #1094 | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 42.3: Orbits CSV** [CORE / DATA] (section 4). Target files: src/server/events/artistOrbitsCsv.ts, src/components/GenresPanel.tsx, src/services/lineupApi.ts, tests/artistOrbitsCsv.test.ts | Issue: #1095 | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 42.4: Orbit pills and sheet** [UI / VISUAL] (section 5). Target files: src/components/ArtistsView.tsx, src/components/OrbitSheet.tsx | Issue: #1096 | Verify: npm run lint --silent
- [ ] **Slice 42.9: Release 3 docs** [UI / VISUAL] (section 10). Target files: docs/architecture/07-artist-genres.md, docs/architecture/12-data-model.md, ARCHITECTURE.md | Issue: #1097 | Verify: npm run lint --silent && npm test --silent
