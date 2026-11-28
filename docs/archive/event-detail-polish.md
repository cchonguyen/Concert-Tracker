# Event detail polish (2026-11-25)

**Archived (2026-11-28):** Built and shipped.

Charlie asked for this in the project thread on 2026-11-25 and confirmed two readings (weekend button, inferred tag at the row's right end, with the source in a tooltip when there is no room). One slice, one pull request, because most of it is in `EventDetail.tsx`.

## What changes

1. App text uses American spelling: Favorite, color, canceled, labeled, catalog. Stored values and code names (`favourite`, `cancelled`) stay as they are.
2. The days row under the dates is called "Went on".
3. In each read row the source link and the inferred tag sit at the right end. When the row is narrower than 23rem they show only their icon, and their words move to the tooltip. An inferred value shows in the row in italics; its tag opens the reason with Confirm or Verify.
4. Check details, its results and Deep search with AI move into "Where every detail came from", which is always the last card, full width below both columns, so it sits below Who you saw on phones too.
5. Who you saw rows no longer show a "Set type?" prompt; set type is set in the act's editor or in Edit lineup. Set type (DJ, Live, ...) and "B2B" show as quiet text, not bubbles, there and in the lineup table.
6. The weekend choices under Series show only when the edition has several weekends or a weekend is stored. Otherwise a small "Weekend" button opens them.

## Files

`src/components/EventDetail.tsx`, `src/components/EventSources.tsx`, `src/components/ui/ReadRow.tsx`, `src/components/ui/Popover.tsx` (end alignment), `src/components/ui/SourceIcon.tsx` (glyph lookup), `src/components/LineupTable.tsx`, the files with spelling changes, `REQUIREMENTS.md` (R3.6 wording) and `docs/architecture/02`, `08`, `15`.
