# Task Progress & Single-Slice Work Lock

> Rule: Mark only ONE task line at a time with the active work tag.

Finished slices move to `.spec/archive/HISTORY.md`. Earlier feature sections (share page, Manage, Tier 3, Global archive, ingest canon, canon review, series, Global Editions, harness rollout) have no open slices and were removed on 2026-11-23; their slices are in HISTORY.md and their specs are listed in `docs/README.md`.

## LiveArchive 2.0 design refresh (spec: `docs/specs/design-refresh-2.md`, approved by Charlie 2026-11-25)
Stage 0 (Claude) goes first. After it, Track A (Claude) and the Gemini package "Ledger & Lobby" (`docs/specs/design-refresh-2-ledger-and-lobby.md`) run in parallel. Each slice gets its issue when it starts.
- [x] **Slice 22.1: Tokens, fonts, phone bar colour and contrast test** [CORE / DATA] Target files: src/index.css, src/services/theme.ts, app.html, tests/themeContrast.test.ts | Issue: #672 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 22.2: Ink on accent, part 1** [UI / VISUAL] Target files: src/components/ui/Button.tsx, src/components/CaptureBar.tsx, src/components/PosterHeader.tsx, src/App.tsx | Issue: #674 | Verify: npm run lint --silent
- [x] **Slice 22.3: Ink on accent, the remaining screens** [UI / VISUAL] Target files: src/components/ | Issue: #676 | Verify: npm run lint --silent
- [x] **Slice 22.4: Reduced-motion sweep** [CORE / DATA] Target files: src/index.css, src/services/motion.ts, src/components/, tests/motion.test.ts | Issue: #678 | Verify: npm run lint --silent && npm test --silent
- [x] **Slice 22.5: Shared Tabs** [UI / VISUAL] Target files: src/components/ui/Tabs.tsx, docs/architecture/15-shared-ui.md | Issue: #680 | Verify: npm run lint --silent
- [x] **Slice 22.6: Shared Ledger, KindPill, HintPill, Stars and Equalizer** [UI / VISUAL] Target files: src/components/ui/Ledger.tsx, src/components/ui/KindPill.tsx, src/components/ui/HintPill.tsx, src/components/ui/Stars.tsx, src/components/ui/Equalizer.tsx, docs/architecture/15-shared-ui.md | Issue: #682 | Verify: npm run lint --silent
- [x] **Slice 24.1: Track A1: one hover card look; heatmap on the refresh tokens** [UI / VISUAL] Target files: src/components/ui/Popover.tsx, src/components/timeline/HeatmapView.tsx | Issue: #694 | Verify: npm run lint --silent
- [x] **Slice 24.2: Track A2: top bar and page rows on the shared Tabs** [UI / VISUAL] Target files: src/App.tsx, src/components/ui/Tabs.tsx | Issue: #696 | Verify: npm run lint --silent
- [x] **Slice 24.3: Track A3: Summary page on cards, folder tabs and the shared Ledger** [UI / VISUAL] Target files: src/components/EventsHome.tsx | Issue: #698 | Verify: npm run lint --silent
- [ ] **Track A (Claude):** A4 poster, A5 two-column detail (2-3 slices), A6 DetailShell motion, A7 Stats and heatmap.
- [ ] **Slice 23.1: Gemini G1a: Table tool row and header** [UI / VISUAL] Brief: docs/specs/design-refresh-2-ledger-and-lobby.md Target files: src/components/TableView.tsx | Issue: #684 | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 23.2: Gemini G1b: Table rows on the shared Ledger** [UI / VISUAL] Brief: docs/specs/design-refresh-2-ledger-and-lobby.md Target files: src/components/TableView.tsx | Issue: #685 | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 23.3: Gemini G2: Agenda, Month and River** [UI / VISUAL] Brief: docs/specs/design-refresh-2-ledger-and-lobby.md Target files: src/components/timeline/AgendaView.tsx, src/components/timeline/MonthView.tsx, src/components/timeline/RiverView.tsx, src/components/timeline/parts.tsx | Issue: #686 | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 23.4: Gemini G3: Capture box halo and suggestion fades** [IN_PROGRESS] [UI / VISUAL] Brief: docs/specs/design-refresh-2-ledger-and-lobby.md Target files: src/components/CaptureBar.tsx | Issue: #687 | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 23.5: Gemini G4: Home bento tiles and year card** [UI / VISUAL] Brief: docs/specs/design-refresh-2-ledger-and-lobby.md Target files: src/components/HomePage.tsx, src/components/YearTile.tsx, src/components/FeatureTiles.tsx | Issue: #688 | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 23.6: Gemini G5: Celebrations read the accent** [UI / VISUAL] Brief: docs/specs/design-refresh-2-ledger-and-lobby.md Target files: src/components/ui/confetti.ts, src/components/ui/Burst.tsx, src/components/MilestoneCard.tsx | Issue: #689 | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 23.7: Gemini G6: Landing page on the app's look** [UI / VISUAL] Brief: docs/specs/design-refresh-2-ledger-and-lobby.md Target files: index.html | Issue: #690 | Verify: npm run lint --silent && npm test --silent
- [ ] **Slice 23.8: Gemini G7: Share page and emails on the same palette** [UI / VISUAL] Brief: docs/specs/design-refresh-2-ledger-and-lobby.md Target files: src/server/share/page.ts, src/server/email/templates.ts | Issue: #691 | Verify: npm run lint --silent && npm test --silent
