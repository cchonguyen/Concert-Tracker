# Quieter tips and a leaner Table

Charlie's request, 2026-11-26: the tips on each page take too much space and attention, and the Table's options should be consolidated. Mockups (round 2 holds his picks): https://claude.ai/artifact/TvGYzA1Y9Ty96vbZxPYWwy. He picked tips B + C and Table Option 3, and said "Go" on 2026-11-25 PT.

## What exists

- Home shows seven feature cards ("What LiveArchive can do"), folded at 5 or more shows, each hideable, saved on the account (`tips` setting, `src/server/auth/prefs.ts`).
- Summary, Table and Manage show a boxed tip (`Callout`, wording in `src/services/copy.ts`), hidden per browser in localStorage. The Global archive Changes list and an artist's catalog entry have their own boxed tips.
- The Menu and About have "Show tips again", which brings back only the Home cards.
- The Table has a search row (Search, Sort, Filters) and under it a totals line ("212 events you went to · 640 acts seen · 88 venues · 2009 to 2026 · rating · spend · 3 upcoming · 2 to confirm · N hidden") with six links: Fill gaps, Series, Genres (owner), Import a list, Google Sheets (owner), Export as CSV.
- Stats has no all-time totals.

## Tips: a quiet line, brought back by the ?

1. Each tip is one quiet grey line (bulb icon, text, ×) under the page title. The Home cards keep their layout but follow the same rule as one tip.
2. Each tip has a key: `home`, `summary`, `table`, `manage`, `archive-changes`, `canonical-artist`.
3. Opening a page counts a visit for its tips. A tip shows on its first 3 visits, then folds away. The first time a tip folds, the ? in the header gives a short nudge (a ring), once.
4. The ? button in the header shows when the current screen has a tip. It is lit while a tip is showing. Tapping it shows the screen's tips (slide in with a short glow on the bulb) or hides them. The × on a tip hides it the same way. Your choice for a tip wins over the visit rule.
5. A "Show all tips" switch in the Menu (and About) replaces "Show tips again". On: every tip shows and stops folding; earlier hides are cleared. Hiding a tip while it is on hides that one. Off: earlier choices are cleared and the visit rule applies again.
6. Everything is saved on the account (`tips` setting, no migration), so it holds on every device. An older saved choice still reads: Home hidden (`allHidden`) becomes a hide of `home`.
7. All motion is off under Reduce Motion.

## Table: Option 3

1. One row: Search, Sort, Filters, Fill gaps.
2. Beside the filter chips: the "42 of 212" count, and "Export these 42" only when a filter is on. The Menu's Export covers everything.
3. Under the chips, small tappable chips appear only when above zero: "3 upcoming", "2 to confirm", "4 didn't go, hidden · Show". Each sets its filter.
4. The totals line leaves the Table.
5. Import a list and Google Sheets leave the Table (the Menu, Quick add and Home have them). The empty Table keeps its "Import a list" link.
6. Series leaves the Table; it is in Manage. Genres (owner) moves to Manage, opened from the Artists list.

## Stats: All time

A strip at the top of Stats: Shows, Acts, Venues, Years, Average rating and Spent, each with what it covers ("you went to", "seen live", "in 31 cities", "2009 to 2026", "from 160 rated", "on 130 priced"). Rating and spend show only when at least one show has them. Counted over shows you went to, like the rest of Stats.

## Slices

- 32.1 Tip rules and account storage [CORE / DATA]: `src/services/tips.ts` (pure rules), `src/server/auth/prefs.ts` (accept the new fields), `src/services/prefs.ts`, tests.
- 32.2 Quiet tips on screen [UI / VISUAL]: the tip line, the header ?, the Menu and About switch, Home cards, the admin tips; ARCHITECTURE.
- 32.3 Stats All time strip [CORE / DATA]: totals in `src/services/stats.ts` with tests, the strip in `StatsView`.
- 32.4 Lean Table toolbar [UI / VISUAL]: `TableView`, Genres in Manage; ARCHITECTURE.
