# Hide events you didn't go to

**Archived (2026-11-28):** Built and shipped.

Charlie's request, 2026-11-26: "Auto-hide events that I did not go to (but they can be filtered to bring them back)." Scope confirmed in the project thread the same day. Issue #855.

## What exists

An event is "Didn't go" when you say so (the "I didn't go" button, or unticking the last day you went in the edition panel). It is stored as `attendance: 'missed'` on your own event only (`src/server/events/attendance.ts`); shared editions never hold it.

Already left out: the Summary tiles and Recent list, Stats, Ranking, the Map, the four timeline views, Share cards, and the people and artist insights in Manage. Still shown: the Table (its Went filter starts on everything), the milestone show count, the event count on a Manage record, and the CSV and sheet.

## Slice 31.1: Hide events you didn't go to in the Table [CORE / DATA]

1. With no Went filter (`went` absent from the address), the Table, and the timelines and Map that share its filters, leave out `missed` events. Event detail's previous and next follow the same list.
2. A new Went choice, "Everything" (`went=all`), shows every event. The other choices (Went, Upcoming, To confirm, Didn't go) are unchanged, so "Didn't go" still lists just those.
3. When events are hidden, the line under the filters says "N you didn't go to hidden" with a "Show them" button that sets `went=all`.
4. Nothing is remembered: opening the Table again from the menu starts hidden. The choice lives only in the page address, like every other filter.
5. Upcoming and "Did you go?" events stay visible.
6. The milestone show count (`milestoneCounts`) counts only events you went to, like the artist count.
7. A Manage record's header count ("12 events") counts only events you went to, matching "In the Table".
8. The CSV export and Google Sheets sync keep every event, with their `Went` column (your backup).

Tests: `tests/table.test.ts` (default hides missed, `went=all` shows them, `went=missed` lists only them, the address round-trips `all`), `tests/milestones.test.ts` (missed and upcoming events do not count as shows).
