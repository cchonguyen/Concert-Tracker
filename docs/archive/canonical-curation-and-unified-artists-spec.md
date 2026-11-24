# Canonical Curation, Unified Artists & Lineup Ingestion Spec

> **Archived 2026-11-23.** Built in Slices 1 to 8 (shared catalog and Manage).

**Status:** Draft Architecture Specification  
**Document Owner:** Antigravity (The Elephant) / Core Architecture  
**Target Audience:** Core Contributors, Admin Curators, AI Agents  
**Date:** November 2026  

---

## 1. Context & Motivation

LiveArchive was originally designed around single-player tracking: capturing personal concert history and extracting lineups for events the owner attended. In that paradigm, the **Manage** tab reflected the owner's personal `user_entities` (artists, venues, places, series), sorted by their personal attendance counts (`counts = eventsByEntity(events)`).

With the introduction of multi-user support (invited members with private trackers), this single-player model creates two structural limitations for the administrator:

1. **Uncurated Canonical Knowledge:** When members import ticket emails or run Stage 2 lineup lookups, extracted performer claims and stage/set time data land in `performer_claims` or private `seen` arrays, but never get promoted into the shared canonical layer (`event_editions`, `performances`, `canonical_artists`). New members logging the same festival or tour cannot benefit from automatic, high-quality suggestions.
2. **Inability to Curate World Facts Unattended by the Admin:** The administrator currently has no interface to review, normalize, or test extraction adapters on festivals and tours they did not personally attend, without creating artificial dummy events in their private event log.

This specification addresses both needs by:
- Adding an **Admin-Only Scope Switcher** inside the existing **Manage** tab (`My Records` vs. `Global Archive`).
- Unifying artist records with a distinct **Origin Provenance** badge (`From Me`, `Unmanaged Fetch`, `Community Import`).
- Introducing an **Editions & Sets** section in Manage, paired with a direct **Lineup Ingestion Tool** that reuses `LineupReview` in a dedicated canonical curation mode.

---

## 2. Core Architectural Invariants

Every change introduced in this feature must strictly adhere to the following invariants:

1. **Invariant 7: The world and you are separate.**
   - Canonical editions (`event_editions`), performances (`performances`), canonical artists (`canonical_artists`), and series (`event_series`) are objective facts about the world.
   - Personal attendance, personal ratings, ticket prices, companion notes, and "seen" marks are facts about individual users (`logged_events`).
   - Curation of canonical editions must never alter or inject events into any user's personal log.
2. **Member Privacy Quarantine:**
   - The Global Archive view aggregates facts about *artists and public events*.
   - Private member IDs, companion names (especially vault-encrypted entities), personal ticket prices, and personal event notes are strictly excluded from all admin aggregation queries.
3. **Invariant 1: Every fact has a source:**
   - Acts extracted by the automated pipeline retain their cited `source_documents` and `performer_claims` with verbatim quotes.
   - If an administrator manually adds or edits a canonical set without an external cited URL, the performance record is explicitly attributed to `source_type: 'admin_curation'`.
4. **Zero Impact on Regular Members:**
   - Regular members only ever see their own personal records in Manage. The Global Archive scope is accessible strictly when `me.role === 'owner'`.

---

## 3. Scope & Provenance Model

### 3.1 The Manage Scope Toggle
Located in the header of `ManageView`, visible only to administrators (`me.role === 'owner'`):

```
+-----------------------------------------------------------+
| Manage                                                    |
| The records behind your events and the canonical archive. |
|                                                           |
| [ My Records (Personal) ]    [ ★ Global Archive (Admin) ] |
+-----------------------------------------------------------+
```

* **`My Records` (Default):** The existing view. Shows `user_entities` filtered and counted against the admin's personal `logged_events`.
* **`Global Archive`:** Queries the unified catalog, displaying all known artists across personal, community, and background-fetched sources, and unlocks the **Editions & Lineups** section.

---

### 3.2 Unified Artist Provenance Taxonomy

In the Global Archive view, artists are drawn from a unified union across three layers, tagged with clear origin badges:

| Origin Badge | Meaning | Underlying Data Source |
| :--- | :--- | :--- |
| 🟣 **`From Me`** | Present in the administrator's personal event log or manually entered entities. | `user_entities` (owner) $\cup$ Owner's `logged_events.seen` |
| 🔵 **`Community Import`** | Added by other members via ticket imports, CSV imports, or manual event logging. | Non-owner `logged_events.seen` (anonymized names and counts) |
| 🟢 **`Unmanaged Fetch`** | Extracted by background Stage 1 / Stage 2 jobs, Clashfinder feeds, or Ticketmaster listings, but not personally attended or curated. | `canonical_artists` $\cup$ `performances` $\cup$ `performer_claims` |

#### Multi-Origin Resolution:
When an artist spans multiple layers (e.g., an artist you personally attended who is also billed at uncurated festival lookups), the UI displays a multi-tag badge (e.g., `From Me · Unmanaged Fetch`).

#### Frequency & Metrics:
In the Global Archive view, the primary sorting metric transitions from *"Times You Saw Them"* to *"Archive Footprint"*:
- **Total Billed Editions:** Count of canonical `performances` across all editions.
- **Community Events:** Count of member events listing this artist in `seen`.

#### Bidirectional Normalization (Renames, Merges & AKAs):
When an admin renames or merges an artist while in the Global Archive view:
- The change writes to the admin's `user_entities` (preserving personal consistency).
- The change writes to `canonical_artists` and `artist_aliases` (ensuring all future Stage 1/2 lookups and member suggestion algorithms resolve to the normalized name).

---

## 4. Editions, Lineup Ingestion & Sets Management

### 4.1 Editions & Lineups Section in Manage
Under the Global Archive scope, Manage gains an **Editions & Lineups** tab in the section menu (`SECTION_OPTIONS`), positioned alongside Artists, Venues, Places, and Series:

```
Section: [ Artists | Venues | Places | Series | ★ Editions & Lineups | Data Health | History ]
```

This section provides:
1. **Edition Catalog:** Searchable list of all `event_editions` (both `confirmed` and `draft`), showing Series Name, Year, Dates, Venue, City, and billed artist count.
2. **Unreviewed Community Lookups:** A sub-filter highlighting background lookup jobs initiated by members that produced candidate lineups waiting for canonical confirmation.
3. **Set Times & Stage Inspector:** Clicking an edition reveals its stages, set times, b2b combinations, and billing roles (`headliner` vs `support`).

---

### 4.2 The Lineup Ingestion Tool
At the top of the Editions view, an Ingestion Action Bar enables direct lineup research without creating a personal event:

```
+------------------------------------------------------------------------------------------+
| Ingest Canonical Lineup                                                                  |
| [ Event / Festival Name                     ] [ Year / Date ] [ Optional URL / Clashfinder ] [ Ingest ] |
+------------------------------------------------------------------------------------------+
```

#### Ingestion Workflow:
1. **Trigger:** The admin enters an event title (e.g., `"Portola Music Festival"`), a year (`2024`), and optionally a specific URL (Clashfinder or promoter page).
2. **Execution:** The server invokes the Stage 2 extraction pipeline (`runJob` / `discoverSources` / `extractFromDocuments`), executing structured adapters (Clashfinder, Ticketmaster) or Gemini verbatim scrapers into a temporary or draft `lookup_job`.
3. **Review Launch:** Upon pipeline completion, the UI launches `LineupReview`.

---

### 4.3 Reusing `LineupReview` in Canonical Curation Mode

The existing `LineupReview.tsx` component is augmented to operate in two modes:

```typescript
interface LineupReviewProps {
  job: LookupJob;
  event?: LoggedEvent;             // Optional! Undefined in Canonical Curation Mode
  edition?: Edition | null;
  mode?: 'personal' | 'canonical'; // Default: 'personal' if event is provided, else 'canonical'
  onClose: () => void;
  onSaved: (event?: LoggedEvent, edition?: Edition) => void;
}
```

#### Adaptations for Canonical Curation Mode:
- **Hide Personal Attendance:** The *"Seen"* checkbox column is hidden or replaced with an informative status column.
- **Stage & Set Time Verification:** Retains all existing controls for inspecting and editing stages, set times, B2B links, DJ set / Live set markers, and billing roles.
- **Evidence Inspection:** Hovering or tapping an act displays the verbatim quote span and source URL from `performer_claims`.
- **Primary CTA:** Instead of `"Save lineup (N seen)"`, the primary button reads:
  ```
  [ Save Canonical Edition (N billed acts) ]
  ```
- **Commit Logic:**
  - Calls `POST /api/lineup/canonical/confirm`.
  - Upserts the `event_editions` row (`status = 'confirmed'`).
  - Writes all accepted acts into `performances`.
  - Ensures all acts are registered in `canonical_artists`.
  - Records reviewer corrections into `source_stats` and `corrections` (teaching future extractions).

---

## 5. API Contracts & Endpoints

All canonical curation endpoints are protected by the `ownerOnly` middleware (`currentMember()?.role === 'owner'`).

### 5.1 `GET /api/manage/canonical/artists`
Retrieves the unified artist catalog with origin tags and frequency statistics.

**Response:**
```json
{
  "artists": [
    {
      "key": "porter-robinson",
      "name": "Porter Robinson",
      "mbid": "c4393710-1c09-41ef-8a36-398d5c4b815f",
      "origins": ["from_me", "unmanaged_fetch"],
      "editionsCount": 12,
      "communityCount": 5,
      "aliases": ["Virtual Self", "Air2Earth"]
    }
  ]
}
```

### 5.2 `GET /api/manage/canonical/editions`
Retrieves known editions, their confirmation status, and summary performance facts.

**Query Parameters:**
- `query`: Text search across series name, edition name, and venue.
- `status`: `'all' | 'confirmed' | 'draft'` (default: `'all'`).

**Response:**
```json
{
  "editions": [
    {
      "id": "edc-las-vegas-2024",
      "key": "edc-las-vegas/2024",
      "seriesSlug": "edc-las-vegas",
      "year": 2024,
      "name": "EDC Las Vegas 2024",
      "startDate": "2024-05-17",
      "endDate": "2024-05-19",
      "venue": "Las Vegas Motor Speedway",
      "city": "Las Vegas, NV",
      "status": "confirmed",
      "performanceCount": 238,
      "hasSetTimes": true
    }
  ]
}
```

### 5.3 `POST /api/manage/canonical/ingest`
Triggers an ad-hoc Stage 2 lineup extraction for canonical archiving.

**Request:**
```json
{
  "name": "Portola Music Festival",
  "year": 2024,
  "date": "2024-09-28",
  "venue": "Pier 80",
  "city": "San Francisco, CA",
  "url": "https://clashfinder.com/s/portola2024/"
}
```

**Response:**
```json
{
  "jobId": "job-uuid-1234",
  "status": "running"
}
```

### 5.4 `POST /api/manage/canonical/confirm`
Commits a reviewed lookup directly into the canonical layer without touching personal logs.

**Request:**
```json
{
  "jobId": "job-uuid-1234",
  "seriesSlug": "portola-music-festival",
  "editionKey": "portola-music-festival/2024",
  "year": 2024,
  "name": "Portola Music Festival 2024",
  "startDate": "2024-09-28",
  "endDate": "2024-09-29",
  "venue": "Pier 80",
  "city": "San Francisco, CA",
  "performers": [
    {
      "name": "Rüfüs Du Sol",
      "accepted": true,
      "billing": "headliner",
      "days": ["2024-09-28"],
      "stages": ["Pier Stage"],
      "set": "DJ Set"
    }
  ]
}
```

---

## 6. Implementation Plan & File Breakdown

The implementation is broken down into structured, isolated phases:

### Phase 1: Canonical Aggregation Service & Endpoints
- **File:** `src/server/entities/canonicalManage.ts`
  - Implement `getUnifiedArtists(store: LineupStore)` aggregating owner entities, member seen names (anonymized), and `canonical_artists`.
  - Implement `listCanonicalEditions(store: LineupStore)`.
- **File:** `src/server/entities/routes.ts`
  - Mount `/api/manage/canonical/artists` and `/api/manage/canonical/editions` behind `ownerOnly`.

### Phase 2: Canonical Ingestion & Confirmation Logic
- **File:** `src/server/lineup/canonicalIngest.ts`
  - Create `createCanonicalLookupJob` and `confirmCanonicalEdition`.
  - Update `performances` and `canonical_artists` with evidence attribution.
- **File:** `src/server/lineup/routes.ts`
  - Add routes for canonical ingestion and confirmation.

### Phase 3: Adapting `LineupReview.tsx` for Canonical Curation
- **File:** `src/components/LineupReview.tsx`
  - Parameterize `event?: LoggedEvent`.
  - Conditionally render personal attendance checkboxes.
  - Wire confirm action to canonical endpoint when in `mode === 'canonical'`.

### Phase 4: UI Integration in Manage
- **File:** `src/components/ManageView.tsx`
  - Add Admin Scope Switcher (`[ My Records | Global Archive ]`).
  - Wire unified artist query and pass origin data down.
- **File:** `src/components/ManageEntry.tsx`
  - Render origin provenance badges and archive appearance stats.
- **File:** `src/components/CanonicalEditionsPanel.tsx`
  - Implement the Ingestion Action Bar and the Editions list with launch hook to `LineupReview`.

---

## 7. Verification & Testing Strategy

1. **Unit & Integration Tests:**
   - Test unified artist aggregation across mock personal events, mock community events, and mock canonical artists (`tests/canonicalArtists.test.ts`).
   - Test that member-private fields (notes, prices, companions) are never exposed in canonical queries.
   - Test `confirmCanonicalEdition` commits to `event_editions` and `performances` without touching `logged_events`.
2. **Edge Cases:**
   - B2B sets and multi-set artists in canonical mode (verifying `performances.set` and slot groupings).
   - Ingesting an edition that already exists as confirmed (verifying merge/reopen behavior).
   - Unprivileged access: Ensure regular members receive 403 on all `/api/manage/canonical/*` routes.
3. **Quality Gates:**
   - `npm run lint` and `npm test` passing cleanly.
