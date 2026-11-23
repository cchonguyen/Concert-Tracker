# B3B / B2B2B and Collaboration Aliases Specification

> **Archived 2026-11-23.** Built: three-way sets are read in `src/server/lineup/actName.ts`, acts carry `alias`, and Manage has the collaborations card.

## 1. Overview & Goals

This specification extends LiveArchive's performance slot architecture with two capabilities:
1. **B3B / B2B2B Support:** Expand parsing and slot grouping to support 3 or more artists performing back-to-back in a single performance slot (e.g., `A b3b B b3b C`, `A b2b2b B b2b2b C`, or multi-partner collaborations).
2. **Collaboration Aliases (AKA):** Provide first-class support for duo/supergroup monikers (e.g., `John Summit b2b Subtronics` AKA `Subjohnics`, `deadmau5 x Kaskade` AKA `Kx5`, `RL Grime x Knock2` AKA `ISOKNOCK`, `Skrillex x Boys Noize` AKA `Dog Blood`).

---

## 2. Capability 1: B3B / B2B2B Multi-Artist Linking

### 2.1 Delimiter Parsing (`src/server/lineup/actName.ts`)
Update the `B2B` regex in `actName.ts` to recognize:
- Explicit digit variants: `b3b`, `b4b`, `b/3/b`
- Repeated chains: `b2b2b`, `b2b2b2b`
- Extended English phrases: `back-to-back-to-back`, `back to back to back`
- Existing conventions: `b2b`, `vs`, `vs.`, `x`, `X`

Regex:
```ts
const B2B = /\s+(?:b(?:[2-9]|[/][2-9][/]|ack[\s-]+to[\s-]+)b(?:ack)?|b(?:[2-9]b)+|vs\.?|[xX])\s+/i;
```

### 2.2 Ingestion & Merging (`src/server/lineup/merge.ts`)
- `readActName(name).parts` produces $N \ge 3$ names.
- All $N$ artists are normalized into unique keys `allKeys`.
- All partners share a single generated `slotId`.
- Reciprocal partners: for each artist, `b2b = allKeys.filter(k => k !== artistKey)` holds all other $N-1$ partners.
- Set times, stages, and days state the performance slot.

### 2.3 Slot Grouping & UI (`src/services/reviewRows.ts`, `src/server/events/seen.ts`)
- In `groupReviewSlots` and `seenSlots`: Disjoint-Set Union (DSU) groups all $N$ performers.
- Default display label joins parts with ` b2b `: `Artist A b2b Artist B b2b Artist C`.
- In `LineupReview`: Displays all $N$ artists in the slot with individual name inputs and unified "Keep" and "Saw it" controls.

---

## 3. Capability 2: Collaboration Aliases (AKA)

### 3.1 Data Model Extensions
Add `alias?: string` to:
- `CandidatePerformer` (`src/server/lineup/types.ts`)
- `EditionPerformance` (`src/server/lineup/types.ts`)
- `SeenAct` (`src/server/events/types.ts`)
- `StartRow` / `Row` (`src/services/reviewRows.ts`, `src/components/LineupReview.tsx`)
- `ReviewSlot` (`src/services/reviewRows.ts`)
- `SeenSlot` (`src/server/events/seen.ts`)

### 3.2 Bidirectional Resolution & Storage
1. **Alias -> Decomposed Slot:**
   - When a source bills `Subjohnics`, or user types `Subjohnics`:
   - If `artist_aliases` maps `subjohnics` $\rightarrow$ `John Summit b2b Subtronics`:
   - `canonicalName("Subjohnics", aliases)` returns `John Summit b2b Subtronics`.
   - `readActName` decomposes it into `John Summit` and `Subtronics`.
   - The slot records `alias: "Subjohnics"`.
2. **Decomposed Slot -> Alias Assignment:**
   - In `LineupReview.tsx`, B2B slots show an optional alias field: `Alias / Moniker (e.g. Subjohnics)`.
   - When confirming, if an alias is set:
     - `perf.alias = alias` and `seenAct.alias = alias`.
     - The mapping `normalizeName(alias)` $\rightarrow$ canonical B2B string is saved to `artist_aliases`.

### 3.3 UI Presentation (`src/components/EventDetail.tsx`, `src/components/LineupReview.tsx`)
- **With Alias:**
  - In Quick-Pick pills: `[Subjohnics (John Summit b2b Subtronics)]`
  - In "Who you saw": Title **`Subjohnics`**, subtitle `John Summit b2b Subtronics`.
- **Without Alias:**
  - Displays as `Artist A b2b Artist B` (standard format).

---

## 4. Verification & Testing Plan
1. **Parser Tests (`tests/actName.test.ts`)**:
   - `A b3b B b3b C`, `A b2b2b B b2b2b C`, `A back-to-back-to-back B`.
2. **Slot Merging Tests (`tests/mergeB2bSolo.test.ts`)**:
   - 3-artist B3B shares `slotId` and has 2 reciprocal partner keys on each.
3. **Review & Display Tests (`tests/reviewRows.test.ts`, `tests/seenSlots.test.ts`)**:
   - 3-artist slot grouping and alias rendering.
4. **CI & Quick Checks**:
   - `npm run typecheck`
   - `npm run lint`
   - `npm test`
