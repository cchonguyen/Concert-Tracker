# System Specification & Contracts

The full spec already lives in the project docs. This file holds only what `/triage` and the `architect` subagent add for the feature in progress; it must not contradict them.

- Requirements and ranked principles: [REQUIREMENTS.md](../REQUIREMENTS.md)
- Architecture, data model and module boundaries: [ARCHITECTURE.md](../ARCHITECTURE.md)
- Hard rules for every change: [AGENTS.md](../AGENTS.md)

## 1. Core Scope & MVP Boundaries
Feature: **"What did you go to?" past-event suggestion** (triaged 2026-11-11, discovery brief, not yet approved).

- **Core user problem (revised 2026-11-11 by Charlie):** when someone types a line for an event that already exists as a canonical edition, the bar should offer that edition, so a friend who adds it after Charlie gets the same canonical details. Searching only your own log is not enough.
- **Proposed behavior:** as you type, the parsed line (name, venue, city via `parseEventInput`) is matched against canonical editions (`event_editions`, migration 0002). A match shows an "Is it this one?" offer under the bar. A tap links the new event to that edition (`logged_events.edition_id`, migration 0003), which brings its confirmed lineup and details. Nothing is saved or merged without a tap. Save stays first and never waits on the match.
- **Privacy:** the search returns only canonical edition facts (name, date, place, confirmed lineup). It never reveals who else logged an event or anything from another user's personal log.
- **Matching (proposed):** normalized exact match on series name (case, punctuation, leading "the") plus date or year. No fuzzy scoring.
- **Architecture (proposed):** a new server search route over `event_editions` (read-only, owner-scoped auth as today), called as the user types, debounced. The client renders the offer with `SuggestInput` or a small list, and reuses `matchNames` and `suggestionsFor` (`src/services/format.ts`). No migration is expected, because `event_editions` and `logged_events.edition_id` already exist. A new route is a new API contract, so this is a contract change.
- **Files-Touched (estimate):** about 6 to 8 (`CaptureBar.tsx`, a server search route, a store query, a pure matcher, a client hook, tests). Contract-Change: yes. Cross-Module: yes (client, server, database).
- **Decisions (Charlie, 2026-11-11):**
  1. A tap pre-fills the new event's fields from the canonical edition. Each filled field is sourced as the edition's source, not "you".
  2. The same series name in a different year can match, but every suggestion shows its year.
  3. A name alone is enough to match. Each suggestion shows its date.
  4. Events in Recently deleted never match.
- **R1.9 relevance:** venue and city already suggest what you have entered before, and city suggests real places as you type. Venue-to-place links apply to edition matches. Applies to typed fields only, so the suggestion feature stays separate from R1.9.
  5. A pre-fill copies everything canonical: date, location, venue, lineup, weather.
- **Plan:** `/mnt/project-files/canonical-autocomplete/plan.md` (stages A to C, slices A1 to B3). Open: lineup vs who you saw (AGENTS.md tap rule), weather source, members creating editions.

## Prev 1. Manage section (shipped, kept for reference)
Feature: **Manage section** (triaged 2026-10-28). Full design: [../docs/manage-section-design.md](../docs/manage-section-design.md).

- **Core user problem:** artists, people, venues, places and series are free text copied onto each event, so fixing a spelling means editing events one by one, and the copies drift apart. Charlie wants one place to rename, merge and describe each of them once.
- **MVP deliverables:**
  1. **Records with permanent IDs** (migration 0014): `entities`, `entity_aliases`, `entity_links`, `entity_history`; events point at them by ID; backfill from current names (only exact matches after normalization are grouped; others become "possible duplicate" offers); old text columns kept and written alongside for one release. Sheets and CSV become one-way outputs from the app.
  2. **Manage tab:** a list per category (Artists, People, Venues, Places, Series, Organizations), entry view with its events, Rename everywhere, Merge (old name kept as AKA), AKA, change history with undo. Series panel moves in; Organizations with "Hosted by" right after Series. Artists tab cards link to their Manage entry and back.
  3. **Venue carries its place:** an event at a venue with a place takes that city, state and country everywhere, with no confirm step. On backfill, a venue whose events disagree stays empty and Data health asks Charlie to pick.
- **Later slices, in order (not MVP):** people first/last name, note and width-adaptive display (full, First L., initials, longer when they would collide); labels as records (Indoor/Outdoor) with category fields, linked suggestions and the full Data health view; the "Do first" insights in the design doc.
- **Blocking questions:** None. Assumed reading of "Sheets and CSV pull from the app": Sheet sync stops reading sheet edits back; "Import a list" stays for adding new events only.

## 2. Strictly Out of Scope ("Do NOT Build" List)
Past-event suggestion:
- No fuzzy, similarity or model matching. It would be guessing (AGENTS.md: never infer; principle 1).
- No auto-merge, auto-fill or auto-add. Every change needs a tap (AGENTS.md: one-tap offers).
- No waiting on the match before save (AGENTS.md: stage 1 never waits).
- No model call or second parser. `parse.ts` stays code (AGENTS.md).
- No new field on capture. The line stays one line.
- No hardcoded venue or artist lists.
- No writes to canonical lineup data from this feature. The personal log and canonical data stay separate.
- No writes from sample mode.

## Prev 2. Manage section Do NOT Build (shipped, kept for reference)
- Anything AGENTS.md forbids (guessed data, hardcoded festival/venue/artist lists, model calls in parsing or saving, demo data, AXS scraping).
- Manage section:
  - Venue location lookup (finding a venue's address or city from a source). It is a separate, later requirement.
  - Artist genres and anything from music-story, until that data has been checked.
  - Showing a venue's name as it was on the night. Always show the current name; old names are AKA only.
  - Contact links for people.
  - Reading edits back from Google Sheets or CSV into existing events.
  - Automatic merges of names that only look alike. These are offers only.
  - Dropping the old text columns in the same release as the ID backfill.
  - No Labels category, category-attribute gap prompts or linked label suggestions in the MVP (step 5).
  - No People first/last name split or adaptive display in the MVP (step 4). In the MVP a person is one record with a single name plus AKA, like the other kinds.
  - No hard delete of entities. A record goes away only by being merged into another one.
  - The "hidden complexity" ideas (discovery story, MusicBrainz home city, lineup source per series, timezones, sourced capacity/status) and the "Do next" ideas (home city distance, spend per organization, crew view, B2B network).

## 3. Data Models & Module Boundaries
- See ARCHITECTURE.md. Feature contracts for the Manage section (from the Gemini audit, 2026-10-28; see DECISIONS.md ADR-002):

**Entities and aliases**
- `entities`: `id uuid` primary key, `kind`, `name`, `name_normalized`, `attrs jsonb`, `merged_into_id uuid null references entities(id)` with `check (merged_into_id is distinct from id)`, timestamps. `unique (kind, name_normalized)` over rows that are not merged.
- `entity_aliases`: `entity_id`, `kind`, `alias_normalized`, with `unique (kind, alias_normalized)`. The same name may exist under different kinds (an artist and a series can share a name), never twice within one kind.
- Resolving or creating a record checks primary names and aliases of that kind together, using the same normalizer the app already uses for artist keys.
- Merges are flattened. If A was merged into B and B is then merged into C, A is repointed to C, so `merged_into_id` never chains. Readers follow `merged_into_id` once.
- No hard delete (see section 2).

**Links**
- `entity_links`: `primary key (from_id, to_id, role)`, `check (from_id <> to_id)`. Allowed `(from kind, role, to kind)` triples are listed in code and checked on write: venue `in` place, series `hosted_by` organization, and later labels and `introduced_me_to`. A merge moves links to the kept record and drops any that become duplicates.
- `logged_events.venue_id`, `series_id` and `place_id` are real foreign keys. Person and artist IDs inside `companions` and `seen` JSON cannot have foreign keys, so the store checks they point at live (not merged) records on every write, and merge rewrites them.
- `src/server/lineup/store/fileStore.ts` enforces the same rules as Supabase. Tests run against the file store.

**Dual-write release (0014)**
- The legacy text columns (`venue`, `city`, `region`, `country`, `series`, `companions`, seen act names) stay. Rename, Merge and venue → place changes **also rewrite those columns** on every affected event in the same operation, so a rollback to text-only reading loses nothing. "A rename touches no event rows" holds only after the later migration that drops the text columns.

**History and undo**
- `entity_history` rows hold a manifest in JSON (`HistoryEntry` in `src/server/entities/types.ts`): the operation and its records, the full before and after state of the touched records, their aliases and their links, and for each event the fields the change rewrote, before and after (empty fields as null). It is written before anything else changes. Undo applies `before` exactly.
- Undo is refused while a touched record, its aliases or its links differ from `after` (undo the later change first). An event changed since (its rewritten fields differ from `after`) is left as it is and listed; the rest are put back. Adding an organization is recorded but not undoable (records are never deleted).
- When two merged artists (or people) are both on one event, the entries are combined into one. Marks are unioned: favourite, set type and B2B, and solo set. The event's prior list is saved in the manifest first.

**Venue → place provenance**
- When an event's venue has a place, the event's `city`, `region` and `country` come from it with `sources.city/region/country = { sourceType: 'venue' }`. Stage 1 research and import location values are not applied to such an event; they stay offers on the event's venue instead.
- If a venue's place changes later, events with stored weather for the old city are flagged (`weather.cityChanged`; weather is not re-fetched on its own, per AGENTS.md).
- Labels (M5a): kind `label` needs migration 0016 (widens the `entities.kind` check). Links `has_label` from venue and series; one label per group on a record (adding one replaces the other in its group). Per-kind details in `src/server/entities/attrs.ts`, set with `updateAttrs` (history `details`).
- Built in M3a (`src/server/entities/venuePlace.ts`): applied on every save by the linking store; the replaced location is kept in the venue's `attrs.placeOffers` (newest per place, at most 20). A venue first saved with a city is put in it. The first backfill does not do that; a one-time pass afterwards (`venue_places_backfill` setting) puts in a place only venues whose events all use one city, as one undoable history entry, and `GET /api/entities/health` lists the venues whose events disagree. Merging venues keeps the target's place.

**Sheets, CSV and list import**
- Sheet sync is one-way: the app writes the sheet, and nothing is read back from it.
- In `src/services/listImport.ts`, a row that matches an event by the app's ID column uses `fillPatch` only (empty fields, plus acts or people not already there). `editPatch` and its three-way merge are retired. Acts and people are matched by resolved entity ID through aliases, so a different spelling of someone already on the event is not added twice.

**Canonical edition suggestions** (plan: `/mnt/project-files/canonical-autocomplete/plan.md`; slices 9.1 to 9.5; no migration)

- `GET /api/editions/suggest?q=<text>`, any signed-in member (mounted in `src/server/lineup/routes.ts`; not under `/manage/canonical`, which is owner-only). Response: `{ editions: EditionSuggestion[] }` with `EditionSuggestion = { id: string; name: string; year?: number; startDate?: string; endDate?: string; venue?: string; city?: string; country?: string; actCount: number }`. Canonical facts only; never who else logged it, and nothing from another member's log. Missing facts are omitted, never defaulted.
- Rules: confirmed editions only (never `draft`); `q` under 2 letters returns `[]`; editions linked to the caller's live events (`listEvents()`, which already skips deleted) are excluded, so the caller's Recently deleted events are ignored and do not hide an edition; limit 5 to 8 (default 5); match on normalized words of the edition name and series, each typed word a word prefix (case, punctuation and leading "the" normalized as elsewhere); year is not matched on, only used to rank (a typed year ranks equal-year first, then newest); no fuzzy, similarity or model matching.
- Store method on `LineupStore` (`src/server/lineup/store/types.ts`), implemented in `fileStore.ts` and `supabaseStore.ts`: `suggestEditions(query: string, opts: { excludeIds: string[]; limit: number }): Promise<EditionSuggestion[]>`. Supabase narrows with `ilike` on name or series, then applies the word-prefix test in code so both stores agree; tests run against the file store.
- `POST /api/events { text: string; editionId?: string }`. Without `editionId`: unchanged (`newEvent`). With it: 404 if the edition is missing or not `confirmed`. Otherwise `newEventFromEdition(edition, text, now)` in `src/server/events/service.ts` copies name, year, startDate, endDate, venue, city, country (only those the edition has), each sourced `{ sourceType: 'edition', editionId }`; sets `editionId` (the link); sets `details.status = 'matched'` so no stage 1 research runs; the lookup job is created through the existing `createLookup`, which finds the confirmed edition by key and goes to review with no network calls. The venue's place still fills city, region and country on save as today (`venuePlace.ts`). Personal fields are never copied: seen stays empty, companions, rating, price, notes, format, own series name, Concert or Festival choice. The lineup shows through the edition link only.
- New `FieldSource` type in `src/server/events/types.ts`: `sourceType: SourceType | 'venue' | 'edition'`, plus optional `editionId?: string`. The UI label reads "from the canonical edition".
- Weather (B3, option 2a): after a pre-filled save, `lookupWeather` runs once, server-side, for the saved event, only when it has a city and a start date. It stores the result with its URL only when Open-Meteo places the city exactly; otherwise it stores nothing and returns the usual note. Never re-run automatically; never copied from another member's event. A failure never fails the save.
- "I saw everyone" (B2): a button in `LineupReview.tsx` that, on tap, adds the edition's billed acts to the event's `seen`. It is never automatic, never run on save, and only ever follows a person's tap. It writes through the existing seen-patch path, so the rules for set type and billing role are unchanged.
- No suggestions and no writes in sample mode. No writes to `event_editions` or `performances`.
