# The edition panel: aligned rows (2026-11-25)

Charlie asked for this in the project thread on 2026-11-25 and approved the plan the same evening. It replaces the right-anchored source and inferred tags from `docs/specs/event-detail-polish.md` (item 3).

## What changes

1. One field per row, in shared columns (`ReadRow`): row icon, label, value, an optional action, and a right slot. Icons, labels, values and the right-hand icons line up down the list.
2. Where a value came from, inferred values (with Confirm or Verify) and notes (such as "You typed", "Shows as …", how Type was worked out) open from one generic "i" icon (2026-11-25: Charlie asked for one plain icon rather than source glyphs). From `sm` up it sits beside the label and the right slot holds the edit icon, shown on hover. On phones the whole row is the edit target, so there is no edit icon and the info icon sits in the right slot.
3. The Date row lists each day on its own line. Once you went (or said you didn't), each day has a checkbox, ticked unless you missed it, even for a one-day event. Unticking the only day left asks "Did you not go to this event?"; confirming marks the event missed, which takes it out of counts and history while the Table still finds it. The separate "Went on" row is gone.
4. There is no separate end-date row (2026-11-25: the Date row carries every day). The Date row's editor holds the date and the last day; its "+" (2026-11-26) takes the edit icon's place at the right edge, always shown, and offers "Edit dates" (opens the date and last-day fields) and, for a series, "Edit weekends". The Weekend row shows only when the edition has several weekends, one is picked, or it was opened from the "+". Rows get a soft hover tint; from `sm` up no column is kept for the edit icon, which overlays a square at the row's right edge on hover, one row at a time.
5. Type is one two-part control (`Segmented`), Festival or Concert. Until you pick, the worked-out type is lit.

## Files

`src/components/ui/ReadRow.tsx`, `src/components/ui/Popover.tsx` (`align="start"`, `closeOnPick`), `src/components/ui/Segmented.tsx` (`compact`), `src/components/EventDetail.tsx`, `docs/architecture/02` and `15`, `docs/README.md`.
