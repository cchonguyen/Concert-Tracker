# Docs index

Specs, plans and backlogs for LiveArchive. What the app is for is in [REQUIREMENTS.md](../REQUIREMENTS.md), how it works is in [ARCHITECTURE.md](../ARCHITECTURE.md) (sections in [architecture/](architecture/)), and the rules are in [AGENTS.md](../AGENTS.md). Harness state is in `.spec/`.

Statuses were checked against the code on 2026-11-28.

## Current

Active specs, backlog items, and `AGENTS.md`-referenced specs:

| Doc | Status |
| --- | --- |
| [auto-verify-spec.md](auto-verify-spec.md) | Built (slices 2 to 5). `AGENTS.md` links its rules here. |
| [ingest-canon-plan.md](ingest-canon-plan.md) | Built (Slices 11.0 to 11.25). Personal-field encryption is still on hold. |
| [specs/canonical-genres.md](specs/canonical-genres.md) | Built (Slices 35.1 to 35.12, migration 0059). `AGENTS.md` links its rules here. |
| [specs/genre-taxonomy-phase-a.md](specs/genre-taxonomy-phase-a.md) | Built (Slices 39.1 to 39.10, migration 0063). `AGENTS.md` links its rules here. |
| [specs/genre-taxonomy-release-3.md](specs/genre-taxonomy-release-3.md) | Built (Slices 43.0 to 43.9, migration 0064). `AGENTS.md` links its rules here. |
| [specs/inferred-values.md](specs/inferred-values.md) | Built. `AGENTS.md` links its rules here. |
| [specs/landing-look.md](specs/landing-look.md) | Built (Slices 45.1 to 46.10). `AGENTS.md` links its rules here. |
| [specs/neon-cleanup.md](specs/neon-cleanup.md) | Built 2026-11-28 (Slices 51.1 to 51.8). Soft solid pills and chips, at most two neon pieces per page. |
| [specs/pasted-set-times.md](specs/pasted-set-times.md) | Built (slices 1 to 4). `AGENTS.md` links its rules here. |
| [specs/series-sync.md](specs/series-sync.md) | Built (auto-link, member ticks, series health). `AGENTS.md` links its rules here. |
| [specs/venue-location-fill.md](specs/venue-location-fill.md) | Built. `AGENTS.md` links its rules here. |
| [specs/event-fetch-upgrade-prd.md](specs/event-fetch-upgrade-prd.md) | Stages 0 to 4 built. Stage 4b and Stage 5 not started. |
| [specs/global-editions-admin-spec.md](specs/global-editions-admin-spec.md) | Slices 1 to 4 built. Slice 5 (component reuse) not planned yet. |
| [specs/series-type-fix.md](specs/series-type-fix.md) | Slices 1, 2, 3 and 5 merged. Slice 4 (the nine tours) not recorded as done. |
| [tier3-specs.md](tier3-specs.md) | TECH-04 and FETCH-01 built. The other Tier 3 tickets not started. |
| [engineering-ticket-bank.md](engineering-ticket-bank.md) | Backlog of open tickets. Closed ones are in [archive/engineering-ticket-bank-closed.md](archive/engineering-ticket-bank-closed.md). |
| [social-features-spec.md](social-features-spec.md) | Not started. Discussion draft. |

## Reference

| Doc | What it is |
| --- | --- |
| [design-system/README.md](design-system/README.md) | Design system export for new apps (tokens, components, voice, agent rules, screenshot archive). |
| [CONTEXT_ATLAS.md](CONTEXT_ATLAS.md) | What the harness's Context Atlas is. The atlas itself is `.spec/ATLAS.md`. |
| [audits/2026-11-17-event-data-entry-and-correction.md](audits/2026-11-17-event-data-entry-and-correction.md) | Production audit of event entry and corrections (2026-11-17). |
| [audits/2026-11-17-external-event-fetch.md](audits/2026-11-17-external-event-fetch.md) | Production audit of event fetching (2026-11-17). |

## Archive

Finished or replaced specs. Each one starts with a line saying why it was archived.

| Doc | Why archived |
| --- | --- |
| [archive/ai-reader-spec.md](archive/ai-reader-spec.md) | Built (Slices 10.1 to 10.20). |
| [archive/artist-entity-cleanup.md](archive/artist-entity-cleanup.md) | Built (migration 0061, Slices 37.x). |
| [archive/b2b-and-solo-performances-spec.md](archive/b2b-and-solo-performances-spec.md) | Built. |
| [archive/b3b-and-collaboration-aliases-spec.md](archive/b3b-and-collaboration-aliases-spec.md) | Built. |
| [archive/brave-rung3-spec.md](archive/brave-rung3-spec.md) | Built (Slice 2 dropped). |
| [archive/canonical-archive-ux-spec.md](archive/canonical-archive-ux-spec.md) | Replaced by the Global archive rework. |
| [archive/canonical-curation-and-unified-artists-spec.md](archive/canonical-curation-and-unified-artists-spec.md) | Built (Slices 1 to 8). |
| [archive/canonical-weather.md](archive/canonical-weather.md) | Built (all five slices). |
| [archive/collab-aliases-manage-design.md](archive/collab-aliases-manage-design.md) | Replaced by the B3B and collaboration aliases spec. |
| [archive/2026-11-18-db-logs-improvement-spec.md](archive/2026-11-18-db-logs-improvement-spec.md) | Built (Slices 21.1 to 21.5). |
| [archive/design-refresh-2.md](archive/design-refresh-2.md) | Built (2.0 design refresh). |
| [archive/design-refresh-2-back-office.md](archive/design-refresh-2-back-office.md) | Built (2.0 stage 2). |
| [archive/design-refresh-2-detail-gaps.md](archive/design-refresh-2-detail-gaps.md) | Built (2.0 stage 3). |
| [archive/design-refresh-2-ledger-and-lobby.md](archive/design-refresh-2-ledger-and-lobby.md) | Built (2.0 ledger & lobby). |
| [archive/docs-and-text-cleanup.md](archive/docs-and-text-cleanup.md) | Done (all ten slices merged). |
| [archive/edition-lineup-from-name-spec.md](archive/edition-lineup-from-name-spec.md) | Built; member proposals replaced by auto-verify ticks. |
| [archive/edition-panel-rows.md](archive/edition-panel-rows.md) | Built. |
| [archive/email-notifications-plan.md](archive/email-notifications-plan.md) | Built. |
| [archive/engineering-ticket-bank-closed.md](archive/engineering-ticket-bank-closed.md) | Closed tickets from the ticket bank. |
| [archive/event-detail-polish.md](archive/event-detail-polish.md) | Built. |
| [archive/event-fetch-stage-1-2-plan.md](archive/event-fetch-stage-1-2-plan.md) | Built. |
| [archive/event-fetch-upgrade-review.md](archive/event-fetch-upgrade-review.md) | Review taken into the event fetch PRD. |
| [archive/genre-explore.md](archive/genre-explore.md) | Built (Slices 38.2 to 38.13). |
| [archive/genre-taxonomy-release-1.md](archive/genre-taxonomy-release-1.md) | Built (Slices 40.1 to 40.7). |
| [archive/genre-taxonomy-release-2.md](archive/genre-taxonomy-release-2.md) | Built (Slices 41.1 to 41.6). |
| [archive/genre-vocabulary.md](archive/genre-vocabulary.md) | Built (Slices 36.1 to 36.12, migration 0060). |
| [archive/genres-csv.md](archive/genres-csv.md) | Built (Slices 34.1 to 34.5). |
| [archive/global-archive-rework-spec.md](archive/global-archive-rework-spec.md) | Built (Slices 8.1 to 8.10). |
| [archive/global-archive-series-weekends.md](archive/global-archive-series-weekends.md) | Built (Slices 2.1 to 2.4). |
| [archive/hide-didnt-go.md](archive/hide-didnt-go.md) | Built. |
| [archive/landing-page-2.md](archive/landing-page-2.md) | Built (direction D landing page). |
| [archive/manage-section-design.md](archive/manage-section-design.md) | Built (Slices M1a to M6). |
| [archive/motion-whimsy.md](archive/motion-whimsy.md) | Built. |
| [archive/poster-lineups-and-notches.md](archive/poster-lineups-and-notches.md) | Built. |
| [archive/quiet-tips-table.md](archive/quiet-tips-table.md) | Built. |
| [archive/row-hover.md](archive/row-hover.md) | Built. |
| [archive/series-cleanup.md](archive/series-cleanup.md) | Built and one-time list run/emptied. |
| [archive/streamlining-plan.md](archive/streamlining-plan.md) | Built. |
| [archive/ticket-stub.md](archive/ticket-stub.md) | Built (Slices 29.x). |
| [archive/ticket-stub-styles.md](archive/ticket-stub-styles.md) | Built (Slices 44.1, 46.9). |
| [archive/tier2-ticket-review.md](archive/tier2-ticket-review.md) | Findings written into the ticket bank. |
| [archive/unified-set-field-and-clashfinder-extraction-spec.md](archive/unified-set-field-and-clashfinder-extraction-spec.md) | Built (PR #192). |
