# Unified `set` Field & Clashfinder Set Extraction Spec

## 1. Context & Motivation
Lineup sources (specifically Clashfinder) frequently bill artist performances with modifiers:
- Technical format modifiers: `Porter Robinson (DJ Set)`, `Bicep (Live)`
- Concept & special theme modifiers: `Adventure Club presents Throwback Set`, `Tiësto (Sunrise Set)`, `Seven Lions [100% 128 Set]`, `Eric Prydz pres. HOLO`, `Kaskade: Redux`

Previously, the app modeled `set` as a strict binary union (`'dj' | 'live'`), which forced special concepts to either stay jammed inside the artist name (polluting canonical artist identity, stats, and search) or be discarded.

This specification unifies format modifiers and custom performance descriptors into a single field: `set?: string`.

---

## 2. Architecture & Data Model

### 2.1 Unified Normalization & Backward Compatibility
Instead of separate `set` and `setDescription` columns:
- `set?: string` represents any performance modifier.
- **Normalization:**
  - `/(?:dj[\s-]?set|dj)/i` $\rightarrow$ `"DJ Set"`
  - `/(?:live[\s-]?set|live)/i` $\rightarrow$ `"Live"`
  - Custom concepts (`"Sunrise Set"`, `"Throwback Set"`, `"HOLO"`, `"Redux"`) $\rightarrow$ preserved verbatim (trimmed).
- **Backward Compatibility:**
  - In `src/server/events/seen.ts`, legacy values `'dj'` and `'live'` normalize transparently to `"DJ Set"` and `"Live"`.
  - Legacy `logged_events.seen` JSONB data continues to load seamlessly without manual data migration.

### 2.2 Interface Updates
- **`src/server/events/types.ts`:**
  - `export type SetKind = string;`
  - `SeenAct.set?: string;`
  - `SeenAct.soloSet?: string;`
- **`src/server/events/seen.ts`:**
  - `SeenInput.set?: string;`
  - `SeenInput.soloSet?: string;`
  - `SET_LABELS`: maps any set string to its display form (with default fallback).
  - `normalizeSet(raw?: string | null): string | undefined`.
- **`src/server/lineup/types.ts`:**
  - `ActName`: `{ parts: string[]; set?: string; }`
  - `CandidatePerformer.set?: string;`
  - `EditionPerformance.set?: string;`
- **`src/server/lineup/learning.ts`:**
  - `ReviewedPerformer.set?: string | null;`
- **Postgres Database:**
  - Migration `supabase/migrations/0030_performance_set.sql`:
    ```sql
    alter table performances add column if not exists set text;
    ```
  - `src/server/lineup/store/supabaseStore.ts` & `fileStore.ts`: map `set` when inserting/loading `performances`.

---

### 2.3 Extraction Pipeline in `src/server/lineup/actName.ts`
`readActName(name: string): ActName` is updated with ordered parsing rules:
1. **Trailing Modifier Extraction (Before B2B Splitting):**
   - **Parentheses & Brackets:** Trailing `/\s*[([](.*?)[)\]]\s*$/`.
   - **"Presents" / "Pres." Connector:** `/\s+(?:presents|pres\.?)\s+(.*)$/i`. The left side is `name`, right side is `set`.
   - **Clashfinder Colon / Hyphen Suffix:** `/\s+[-–:]\s+(.*)$/` **only** if the suffix contains recognized set keywords (`set`, `live`, `dj`, `redux`, `throwback`, `sunrise`, `sunset`, `acoustic`, `360`, `retrospective`), protecting hyphenated artist names (`Jay-Z`, `BLOND:ISH`).
2. **Disambiguation Guard:**
   - 2-letter ISO country codes or region identifiers in parentheses (e.g. `(BE)`, `(FR)`, `(UK)`, `(US)`) are ignored and left attached to the artist name.
3. **B2B Integration:**
   - Suffix modifiers are stripped **before** splitting on `b2b` / `vs.` delimiters (e.g. `"Slander b2b NGHTMRE (Gud Vibrations)"` yields `parts: ["Slander", "NGHTMRE"]` and `set: "Gud Vibrations"`).
4. **Verbatim Quote Integrity:**
   - Full raw strings remain stored in `quotedSpan` so `isVerbatim` checks remain strictly compliant with AGENTS.md rules.

---

### 2.4 Multi-Set Festival Deduplication
Artists often play multiple distinct sets at the same event (e.g., `Tiësto` solo and `Tiësto (Sunrise Set)`):
1. **`mergeLineup` (`src/server/lineup/merge.ts`):**
   - `groupKey` includes the normalized `set`:
     `${artistKey}::solo::${setKey}` or `${artistKey}::b2b::${allKeys}::${setKey}`.
   - Different sets by the same artist produce distinct `slotId`s and distinct candidate rows.
2. **`dedupe` (`src/server/lineup/learning.ts`):**
   - Retains performances as distinct if their `slotId` or `set` differs.
3. **Personal Log Sync:**
   - Lineup review propagates `performance.set` onto `seenAct.set`.
   - Multiple sets by the same artist in `seen` retain distinct instance `id`s.

---

### 2.5 UI & Display Changes
- **`EventDetail.tsx`:**
  - Unified Set input: quick-toggle chips for `"DJ Set"` and `"Live"`, and a text input with `SuggestInput` bound to `act.set`.
  - `SuggestInput` suggestions populated by `pastSets(events)` from `src/services/format.ts`.
- **`LineupReview.tsx`:**
  - Displays clean artist name alongside an editable `set` field for each performance row.
- **Labels & Exports:**
  - `slotLabel`: Formats as `Artist (Set)` (e.g., `Tiësto (Sunrise Set)`, `Porter Robinson (DJ Set)`, `Slander b2b NGHTMRE (Gud Vibrations)`).
  - `TableView.tsx`: Displays unified set tag/pill.
  - CSV: Exports formatted sets cleanly.
