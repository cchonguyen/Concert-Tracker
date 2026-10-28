# System Specification & Contracts

The full spec already lives in the project docs. This file holds only what `/triage` and the `architect` subagent add for the feature in progress; it must not contradict them.

- Requirements and ranked principles: [REQUIREMENTS.md](../REQUIREMENTS.md)
- Architecture, data model and module boundaries: [ARCHITECTURE.md](../ARCHITECTURE.md)
- Hard rules for every change: [AGENTS.md](../AGENTS.md)

## 1. Core Scope & MVP Boundaries
Feature: **Manage section** (triaged 2026-10-28). Full design: [designs/manage-section.md](designs/manage-section.md).

- **Core user problem:** artists, people, venues, places and series are free text copied onto each event, so fixing a spelling means editing events one by one, and the copies drift apart. Charlie wants one place to rename, merge and describe each of them once.
- **MVP deliverables:**
  1. **Records with permanent IDs** (migration 0014): `entities`, `entity_aliases`, `entity_links`, `entity_history`; events point at them by ID; backfill from current names (only exact matches after normalization are grouped; others become "possible duplicate" offers); old text columns kept and written alongside for one release. Sheets and CSV become one-way outputs from the app.
  2. **Manage tab:** a list per category (Artists, People, Venues, Places, Series, Organizations), entry view with its events, Rename everywhere, Merge (old name kept as AKA), AKA, change history with undo. Series panel moves in; Organizations with "Hosted by" right after Series. Artists tab cards link to their Manage entry and back.
  3. **Venue carries its place:** an event at a venue with a place takes that city, state and country everywhere, with no confirm step. On backfill, a venue whose events disagree stays empty and Data health asks Charlie to pick.
- **Later slices, in order (not MVP):** people first/last name, note and width-adaptive display (full, First L., initials, longer when they would collide); labels as records (Indoor/Outdoor) with category fields, linked suggestions and the full Data health view; the "Do first" insights in the design doc.
- **Blocking questions:** None. Assumed reading of "Sheets and CSV pull from the app": Sheet sync stops reading sheet edits back; "Import a list" stays for adding new events only.

## 2. Strictly Out of Scope ("Do NOT Build" List)
- Anything AGENTS.md forbids (guessed data, hardcoded festival/venue/artist lists, model calls in parsing or saving, demo data, AXS scraping).
- Manage section:
  - Venue location lookup (finding a venue's address or city from a source). It is a separate, later requirement.
  - Artist genres and anything from music-story, until that data has been checked.
  - Showing a venue's name as it was on the night. Always show the current name; old names are AKA only.
  - Contact links for people.
  - Reading edits back from Google Sheets or CSV into existing events.
  - Automatic merges of names that only look alike. These are offers only.
  - Dropping the old text columns in the same release as the ID backfill.
  - The "hidden complexity" ideas (discovery story, MusicBrainz home city, lineup source per series, timezones, sourced capacity/status) and the "Do next" ideas (home city distance, spend per organization, crew view, B2B network).

## 3. Data Models & Module Boundaries
- See ARCHITECTURE.md. Add feature-specific contracts here.
