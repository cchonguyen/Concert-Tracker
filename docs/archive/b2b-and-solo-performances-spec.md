# Specification: B2B and Solo Performance Architecture

> **Archived 2026-11-23.** Built: acts carry `slotId`, `b2b` partner keys and `set` (see `src/server/events/types.ts`).

**Status:** Proposed  
**Author:** Pair Programming (Agent & Operator)  
**Date:** 2026-11-02  
**Target Areas:** Lineup Ingestion & Merging, Lineup Review UI, Event Log (`LoggedEvent.seen`), Metrics & Stats, Artist Summaries  

---

## 1. Context & Motivation

In electronic and multi-genre festivals (e.g. EDC, Coachella, Portola, Lost in Dreams), it is standard for popular DJs/producers to perform multiple sets during the same festival:
1. **Solo sets** (e.g. John Summit at Circuit Grounds on Friday).
2. **B2B (Back-to-Back) sets** (e.g. John Summit b2b Dom Dolla at Kinetic Field on Sunday).
3. **Multiple B2B sets** with different collaborators across different days/stages.

### Problems in the Current Codebase:
1. **Lineup Merging Collapses Performances**:
   In `src/server/lineup/merge.ts`, all performer claims are keyed strictly by normalized artist name (`key = normalizeName(name)`). If a festival has both `"John Summit"` and `"John Summit b2b Dom Dolla"`, both claims are collapsed into a single `CandidatePerformer` whose `days` and `stages` are merged, and which is tagged with `b2b: ['dom dolla']`. The solo set is completely erased as an independent candidate.
2. **Review UI Disconnect**:
   In `src/components/LineupReview.tsx`, candidate performers in a B2B appear as separate rows (e.g. `John Summit` with a badge `b2b Dom Dolla` in one row, and `Dom Dolla` with a badge `b2b John Summit` in another row). Checking "Saw it" on one does not tick the other, and there is no way to accept or mark both a solo set and a B2B set.
3. **The `solo: true` Workaround in `SeenAct`**:
   `SeenAct` currently attempts to model solo sets by attaching a boolean flag (`solo?: boolean; soloSet?: SetKind`) to the B2B `SeenAct`. This is hidden behind a toggle switch inside the B2B act's detail sheet ("Also played a solo set"), cannot support multiple B2Bs or distinct stages/times, and creates ambiguous data.
4. **Edition Persistence Gap**:
   When an edition is confirmed, `EditionPerformance` in `src/server/lineup/types.ts` drops `b2b`. Once saved, the canonical lineup in `event_editions` loses the B2B relationship.

---

## 2. Core Principles & User Requirements

1. **Independent Performance Slots in Lineups**:
   A solo performance and a B2B performance are distinct scheduled slots on a festival timetable (different stages, times, and days). They must be represented as distinct slots in the lineup and review UI.
2. **Unified B2B Slots in Lineup Display**:
   In the Lineup Review table and the Event Detail quick-pick, a B2B performance appears as a **single slot** (`Artist A b2b Artist B`).
   - Ticking "Saw it" on that slot automatically resolves into separate artist records for `Artist A` and `Artist B` with reciprocal `b2b` links.
3. **First-Class Performance Entries in "Who you saw"**:
   Both the B2B slot and the solo slot can be added to "Who you saw" as separate entries for the same event:
   - Entry 1: John Summit (Solo set)
   - Entry 2: John Summit (b2b Dom Dolla)
   - Entry 3: Dom Dolla (b2b John Summit)
4. **Intuitive, Linear Counting for Metrics**:
   - **Viewings / Sets Count**: Each instance counts as one viewing (seeing John Summit solo at 6pm and B2B at 8pm counts as 2 sets seen). No complex aggregation or deduplication rules.
   - **Unique Artists**: Distinct artist count continues to use `artistKey` (`new Set(acts.map(a => a.key)).size`), so John Summit is counted as 1 unique artist.
   - **Events Attended**: Count of distinct events remains based on `event.id`, so EDC 2024 is 1 event attended.

---

## 3. Data Model Changes

### 3.1. `SeenAct` (`src/server/events/types.ts`)
Add an optional instance `id` so multiple performances of the same artist within the same event have unique identifiers:
```ts
export interface SeenAct {
  id?: string;        // Unique instance ID (UUID) to disambiguate multiple sets by the same artist on one event
  key: string;       // Normalized artist key ('john summit')
  name: string;      // Display name ('John Summit')
  from: 'you' | 'lineup';
  role?: Billing;
  roleFrom?: 'you' | 'lineup';
  favourite?: boolean;
  set?: SetKind;     // 'dj' | 'live'
  b2b?: string[];    // Normalized keys of partners in this specific B2B set
  artistId?: string;
  // Deprecated legacy fields, retained for backward-compatibility migration:
  solo?: boolean;
  soloSet?: SetKind;
}
```

### 3.2. `CandidatePerformer` & `EditionPerformance` (`src/server/lineup/types.ts`)
Ensure `EditionPerformance` retains `b2b` and distinguish slots:
```ts
export interface EditionPerformance {
  slotId?: string;    // Groups performers sharing a single scheduled slot (e.g. B2B partners)
  artistKey: string;
  name: string;
  mbid?: string;
  days: string[];
  stages: string[];
  status: 'billed' | 'performed' | 'cancelled';
  billing?: Billing;
  confidence: number;
  b2b?: string[];     // Partners in this performance
  sources: CandidateSource[];
}
```

---

## 4. Subsystem Breakdown

### 4.1. Lineup Merging (`src/server/lineup/merge.ts`)
- Currently, `groups` is `Map<artistKey, PerformerClaim[]>`.
- Update grouping logic so claims for **solo performances** (`parts.length === 1 && !partners`) and **B2B performances** (`parts.length > 1`) do not overwrite each other into a single performer.
- When an artist has both a solo claim and a B2B claim, `mergeLineup` creates:
  1. A solo `CandidatePerformer` for that artist (with the solo stages/days).
  2. A B2B `CandidatePerformer` for that artist (linked with their B2B partners and the B2B stages/days).

### 4.2. Lineup Review UI (`src/components/LineupReview.tsx`)
- Group candidate performers sharing reciprocal `b2b` keys and matching days/stages into a unified slot row:
  - Display: `A-Trak b2b Craze` (cosmicMeadow, 2022-05-22).
  - Toggling "Saw it" on the slot marks both `A-Trak` and `Craze` as seen with `b2b` reciprocal links.
  - Toggling "Keep" accepts/rejects the slot as a whole.
- Solo sets for artists who also have a B2B appear as their own standalone row in the table, with their own "Saw it" checkbox.

### 4.3. Event Detail & Quick-Pick (`src/components/EventDetail.tsx`)
- In "From the lineup, tap to mark who you saw":
  - Group `lineupActs` using `lineupSlots` (similar to `seenSlots`).
  - Renders B2B pairings as a unified pill: `[A-Trak b2b Craze]`.
  - Tapping `[A-Trak b2b Craze]` adds both `A-Trak` and `Craze` to `event.seen` with mutual `b2b` tags.
  - Tapping a solo pill `[John Summit]` adds the solo set to `event.seen`.
- In "Who you saw":
  - `seenSlots` renders the B2B slot as `A-Trak [B2B] Craze`, and the solo set as `John Summit`.
  - Clicking on a slot to edit opens the specific instance using `s.id ?? s.key`.

### 4.4. Set Grouping & Slot Helpers (`src/server/events/seen.ts`)
- Update `seenSlots` to group by `b2b` and preserve multiple distinct sets for the same artist.
- Seamlessly unpack legacy `solo: true` acts so any previously logged events with `solo: true` automatically render as two distinct set items without data loss.

### 4.5. Stats & Metrics (`src/services/stats.ts`, `src/services/artists.ts`)
- **Top Artists / Artist Summary**:
  - `viewings`: Counts every instance seen in `e.seen` (e.g. 2 viewings if John Summit was seen solo and B2B at EDC).
  - `events`: Counts unique events (`new Set(instances.map(s => e.id)).size`).
  - Artist page displays: `"X sets across Y events"` (e.g. "2 sets at EDC Las Vegas 2024").
- **Unique Artists**:
  - `new Set(events.flatMap(e => e.seen.map(s => s.key))).size` continues to count distinct artist keys.

---

## 5. Verification Plan

1. **Unit Tests**:
   - `tests/actName.test.ts`: Verify `readActName` on multi-artist B2Bs (`A b2b B`, `A B2B B B2B C`, `A vs B`).
   - `tests/mergeLineup.test.ts`: Verify that an artist with both a solo set and a B2B set produces both a solo candidate and a B2B candidate with separate days/stages.
   - `tests/seenSlots.test.ts`: Verify that multiple sets by the same artist (1 solo, 1 B2B) render into 2 distinct slots without key collision.
   - `tests/stats.test.ts`: Verify that stats count sets linearly (2 sets) while unique artists remains 1.
2. **Database Verification**:
   - Test on live EDC 2022/2024/2026 data using `recheck-lineups.ts` to verify B2B slots and solo slots are properly recognized.
3. **Linter & Test Suite**:
   - Run `npm run lint` and `npm test` to ensure zero regressions across the codebase.
