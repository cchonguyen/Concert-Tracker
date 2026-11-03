# Collaboration Aliases in Manage & Lineup Review: Complete Specification

## 1. Overview & Objectives
Provide an intuitive, design-system-aligned workflow for creating, viewing, and editing multi-artist collaborative aliases (e.g. `Subjohnics = John Summit B2B Subtronics`, `Kx5 = Kaskade B2B deadmau5`, `ISOKNOCK = ISOxo B2B Knock2`, `Hivemind = Kayzo B2B Space Laces B2B Must Die!`).

---

## 2. Detailed UX & Interaction Specifications

### A. Edit Lineup (Lineup Review)
1. **Auto-Expand on Alias Selection**:
   - Typing or picking a known collaboration alias (e.g. `Subjohnics`) in the "Add act" input or any act row immediately expands into constituent artists (`John Summit` + `Subtronics`), linking them with a shared `slotId` and attaching `alias = "Subjohnics"`.
2. **Modern Badge & Chip Presentation**:
   - Monikers are highlighted with an accent `Pill` (`tone="accent"`).
   - Set indicators use `Pill tone="info"` (`B2B set`, `B3B set`).
   - Partners are displayed in editable chips with their days and stages.
3. **Partner Management & Unlinking**:
   - Each partner in a multi-act slot features an `IconButton` (`X`) to remove that specific artist from the set.
   - Removing down to 1 artist smoothly reverts the slot to a standard solo act row.
   - `+ Partner` button uses design system `Button` (`variant="quiet"`).

### B. Manage Tab Integration (`ManageView.tsx` & `ManageEntry.tsx`)
1. **Collapsible Section Above Artists List**:
   - Embedded above the artist directory in `ManageView.tsx` when viewing `Artists` (matching the `Series` pattern).
   - Shows active collaborations with partner `Pill` badges and past event counts.
   - Search bar in Manage matches both project monikers and any constituent member's name.
2. **Collaborative Project Builder (`+ New Collaboration`)**:
   - Moniker input field (e.g. `Everything Always`).
   - Autocomplete partner picker adding 2, 3, or more artists as dismissible chips.
   - Save / Edit / Delete actions with confirmation.
3. **Individual Artist Profile (`ManageEntry.tsx`)**:
   - Opening an individual artist (e.g. **John Summit**) displays a "Collaborative Projects" card listing their projects (`Subjohnics`, `Everything Always`).
   - Clicking a partner's pill navigates directly to that partner's Manage profile.
4. **History & Undo**:
   - Creating, editing, or deleting a collaboration creates a `HistoryEntry` in the Manage History log with a one-click Undo button.

---

## 3. Data & Sync Flow
1. **Registry Sync**: Updates `artist_aliases` table (`alias_normalized` $\leftrightarrow$ `canonical_name`).
2. **Event Propagation**: Updates matching performance slots and seen acts on existing events where those artists performed together.
3. **History Logging**: Emits `HistoryEntry` for all mutations to support undo.
