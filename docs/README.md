# Docs index

Specs, plans and backlogs for LiveArchive. What the app is for is in [REQUIREMENTS.md](../REQUIREMENTS.md), how it works is in [ARCHITECTURE.md](../ARCHITECTURE.md) (sections in [architecture/](architecture/)), and the rules are in [AGENTS.md](../AGENTS.md). Harness state is in `.spec/`.

Statuses were checked against the code on 2026-11-23.

## Current

| Doc | Status |
| --- | --- |
| [auto-verify-spec.md](auto-verify-spec.md) | Built (slices 2 to 5). AGENTS.md links its rules here. |
| [ingest-canon-plan.md](ingest-canon-plan.md) | Built (Slices 11.0 to 11.25). Personal-field encryption is still on hold. |
| [specs/event-fetch-upgrade-prd.md](specs/event-fetch-upgrade-prd.md) | Stages 0 to 4 built. Stage 4b and Stage 5 not started. |
| [specs/global-editions-admin-spec.md](specs/global-editions-admin-spec.md) | Slices 1 to 4 built. Slice 5 (component reuse) not planned yet. |
| [specs/series-type-fix.md](specs/series-type-fix.md) | Slices 1, 2, 3 and 5 merged. Slice 4 (the nine tours) not recorded as done. |
| [specs/landing-page-2.md](specs/landing-page-2.md) | Approved and built 2026-11-27: new landing page (direction D). |
| [specs/series-cleanup.md](specs/series-cleanup.md) | Approved 2026-11-26: one series list, one naming rule, brand/series/edition words stored once. 5 slices, none built yet. |
| [specs/series-sync.md](specs/series-sync.md) | Proposed 2026-11-27: auto-link events that exactly match a shared edition (undoable), and series health with one-tap fixes in Data health. |
| [specs/streamlining-plan.md](specs/streamlining-plan.md) | Built 2026-11-24: duplicate code removed and auto-verify switched on. |
| [specs/docs-and-text-cleanup.md](specs/docs-and-text-cleanup.md) | Done 2026-11-24 (all ten slices merged). |
| [specs/venue-location-fill.md](specs/venue-location-fill.md) | Built 2026-11-24 (all slices merged). Member entries sharing the state waits on Charlie's notice decision. |
| [specs/pasted-set-times.md](specs/pasted-set-times.md) | Built 2026-11-25 (slices 1 to 4). Slice 5 is data entry for Together As One. |
| [specs/inferred-values.md](specs/inferred-values.md) | Principle approved 2026-11-24 (replaces "never guess"). Build not started. |
| [specs/design-refresh-2.md](specs/design-refresh-2.md) | Approved 2026-11-25. Not started: Stage 0 (Claude), then Track A (Claude) and the Gemini package in parallel. |
| [specs/design-refresh-2-ledger-and-lobby.md](specs/design-refresh-2-ledger-and-lobby.md) | Gemini package for the design refresh. Starts after Stage 0. |
| [specs/design-refresh-2-back-office.md](specs/design-refresh-2-back-office.md) | Gemini package for design refresh stage 2: global archive, Manage, admin, Artists, map, imports, sharing and log. |
| [specs/design-refresh-2-detail-gaps.md](specs/design-refresh-2-detail-gaps.md) | Gemini package for design refresh stage 3: event detail lineup table, sources, tabs and read rows. Not started. |
| [specs/ticket-stub.md](specs/ticket-stub.md) | Design refresh stage 4: the ticket stub (event detail hero, list headers, Home, Stats, Share page in Library). Approved 2026-11-25. Not started. |
| [specs/event-detail-polish.md](specs/event-detail-polish.md) | Event detail polish: American spelling, "Went on", source and inferred tags at the right of each row, sources and Check details last, quiet set types, weekend button. Charlie's request 2026-11-25. |
| [specs/edition-panel-rows.md](specs/edition-panel-rows.md) | The edition panel: one field per aligned row, one info icon for source and notes, dates with checkboxes, Ends and Weekend behind "+", Type as a two-part control. Charlie's request 2026-11-25. |
| [specs/row-hover.md](specs/row-hover.md) | One stronger hover tint for every row, with a fade-out trail when you sweep across a list. Charlie's request 2026-11-25. |
| [specs/hide-didnt-go.md](specs/hide-didnt-go.md) | Hide events you didn't go to in the Table by default, with "Everything" to bring them back; milestone and Manage counts only count events you went to. Charlie's request 2026-11-26. |
| [specs/genres-csv.md](specs/genres-csv.md) | Artist genres as a CSV: download, edit "New genres" in a spreadsheet, check, apply, undo. Designed 2026-11-26; slice 34.1 (pure rules) in progress. |
| [specs/canonical-genres.md](specs/canonical-genres.md) | Shared artist genres: one set per artist for everyone, set by the owner, logged and undoable; the owner's genres file covers the catalog and every member's seen acts (names only). Migration 0059. Designed 2026-11-26; slices 35.1 to 35.12. |
| [specs/genre-vocabulary.md](specs/genre-vocabulary.md) | Genre vocabulary: spellings that differ only in capitals, accents, spaces or punctuation are one genre; Manage > Genres tab with rename, aliases, merge, groups and umbrella genres, logged and undoable. Migration 0060. Planned 2026-11-26; slices 36.1 to 36.12. |
| [specs/genre-explore.md](specs/genre-explore.md) | Genres in Explore: top genres with the artists behind them, on the rise lately, firsts and milestones, range and playful labels, genres over the years, year in genres card, genres by who you went with; Explore's four timeline tabs become one Timeline tab and Ranking gains Artists, Genres and People. Browser only, no migration. Built 2026-11-27 (slices 38.2 to 38.13); 38.5 and 38.8 are upgraded in Release 1 of the genre taxonomy. |
| [specs/genre-taxonomy-phase-a.md](specs/genre-taxonomy-phase-a.md) | Genre taxonomy, Phase A: 8 macro genres and 28 scene families replace music-story's groups; ranked owner genres (1.0, 0.70, 0.45, 0.25); genre relations (secondary families, adjacent, derived from); tree, relations and ranked artist uploads with preview, Apply and Undo. Migration 0063. Planned 2026-11-27; slices 39.1 to 39.10. |
| [specs/genre-taxonomy-release-1.md](specs/genre-taxonomy-release-1.md) | Genre taxonomy, Release 1: Multi-Zoom Breakdown (macro, family, genre, each adding up to 100%) and Sound Drift (yearly mix of families or macros, tap for the sets behind it), with B2B sets split across their acts. No migration. Planned 2026-11-27; slices 40.1 to 40.7. |
| [specs/genre-taxonomy-release-2.md](specs/genre-taxonomy-release-2.md) | Genre taxonomy, Release 2: Lineup DNA (an event bill's mix of scene families, per stage where the lineup has stages, with a coverage note) and Event Match (the bill scored against your own history with one-step adjacent smoothing, acts in your lane marked). No migration. Planned 2026-11-27; slices 41.0 to 41.6. |
| [specs/genre-taxonomy-release-3.md](specs/genre-taxonomy-release-3.md) | Genre taxonomy, Release 3: orbits (owner-curated scenes named by anchor acts, migration 0064), bill links learned from shared lineups (PMI, `lineup_cooccur`, owner preview and apply, undoable), One step outside your lane, and the opt-in Constellation map. Planned 2026-11-27; slices 42.0 to 42.9. |
| [specs/quiet-tips-table.md](specs/quiet-tips-table.md) | One-line page tips that fold away after 3 visits, a header ? to bring them back and a Show all tips switch; a lean Table toolbar; an All time strip on Stats. Charlie's request 2026-11-26. |
| [specs/motion-whimsy.md](specs/motion-whimsy.md) | Louder, playful motion on controls, tabs, menus, saves, toasts, stars and bursts, all off under reduced motion. Charlie's request 2026-11-25. |
| [specs/poster-lineups-and-notches.md](specs/poster-lineups-and-notches.md) | Acts listed with a diamond between names, like a lineup poster; ticket notches cut as real holes. Charlie's requests 2026-11-26. |
| [specs/artist-entity-cleanup.md](specs/artist-entity-cleanup.md) | Reusable single-transaction artist entity cleanup RPC (migration 0061) and Global Archive CSV upload/preview/apply UI. Approved 2026-11-26. |
| [tier3-specs.md](tier3-specs.md) | TECH-04 and FETCH-01 built. The other Tier 3 tickets not started. |
| [engineering-ticket-bank.md](engineering-ticket-bank.md) | Backlog of open tickets. Closed ones are in [archive/engineering-ticket-bank-closed.md](archive/engineering-ticket-bank-closed.md). |
| [social-features-spec.md](social-features-spec.md) | Not started. Discussion draft. |

## Reference

| Doc | What it is |
| --- | --- |
| [design-system/README.md](design-system/README.md) | Design system export for new apps (tokens, components, voice, agent rules). |
| [CONTEXT_ATLAS.md](CONTEXT_ATLAS.md) | What the harness's Context Atlas is. The atlas itself is `.spec/ATLAS.md`. |
| [audits/2026-11-17-event-data-entry-and-correction.md](audits/2026-11-17-event-data-entry-and-correction.md) | Production audit of event entry and corrections (2026-11-17). |
| [audits/2026-11-17-external-event-fetch.md](audits/2026-11-17-external-event-fetch.md) | Production audit of event fetching (2026-11-17). |

## Archive

Finished or replaced specs. Each one starts with a line saying why it was archived.

| Doc | Why archived |
| --- | --- |
| [archive/ai-reader-spec.md](archive/ai-reader-spec.md) | Built (Slices 10.1 to 10.20). |
| [archive/b2b-and-solo-performances-spec.md](archive/b2b-and-solo-performances-spec.md) | Built. |
| [archive/b3b-and-collaboration-aliases-spec.md](archive/b3b-and-collaboration-aliases-spec.md) | Built. |
| [archive/brave-rung3-spec.md](archive/brave-rung3-spec.md) | Built (Slice 2 dropped). |
| [archive/canonical-archive-ux-spec.md](archive/canonical-archive-ux-spec.md) | Replaced by the Global archive rework. |
| [archive/canonical-curation-and-unified-artists-spec.md](archive/canonical-curation-and-unified-artists-spec.md) | Built (Slices 1 to 8). |
| [archive/canonical-weather.md](archive/canonical-weather.md) | Built (all five slices). |
| [archive/collab-aliases-manage-design.md](archive/collab-aliases-manage-design.md) | Replaced by the B3B and collaboration aliases spec. |
| [archive/2026-11-18-db-logs-improvement-spec.md](archive/2026-11-18-db-logs-improvement-spec.md) | Built (Slices 21.1 to 21.5). |
| [archive/edition-lineup-from-name-spec.md](archive/edition-lineup-from-name-spec.md) | Built; member proposals replaced by auto-verify ticks. |
| [archive/email-notifications-plan.md](archive/email-notifications-plan.md) | Built. |
| [archive/engineering-ticket-bank-closed.md](archive/engineering-ticket-bank-closed.md) | Closed tickets from the ticket bank. |
| [archive/event-fetch-stage-1-2-plan.md](archive/event-fetch-stage-1-2-plan.md) | Built. |
| [archive/event-fetch-upgrade-review.md](archive/event-fetch-upgrade-review.md) | Review taken into the event fetch PRD. |
| [archive/global-archive-rework-spec.md](archive/global-archive-rework-spec.md) | Built (Slices 8.1 to 8.10). |
| [archive/global-archive-series-weekends.md](archive/global-archive-series-weekends.md) | Built (Slices 2.1 to 2.4). |
| [archive/manage-section-design.md](archive/manage-section-design.md) | Built (Slices M1a to M6). |
| [archive/tier2-ticket-review.md](archive/tier2-ticket-review.md) | Findings written into the ticket bank. |
| [archive/unified-set-field-and-clashfinder-extraction-spec.md](archive/unified-set-field-and-clashfinder-extraction-spec.md) | Built (PR #192). |
