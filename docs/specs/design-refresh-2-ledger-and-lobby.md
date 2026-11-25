# Gemini package "Ledger & Lobby": LiveArchive 2.0 design refresh

Status: approved by Charlie on 25 Nov 2026. **Start only after Stage 0 has merged.** `.spec/PROGRESS.md` marks Stage 0 done, and `src/components/ui/Ledger.tsx` and `Tabs.tsx` exist on `main`.

This is half of the design refresh in `docs/specs/design-refresh-2.md`. Claude builds the other half (Track A) at the same time. "Ledger" covers the list screens: Table, Agenda, Month and River. "Lobby" covers the screens people meet first: the capture box, Home, the landing page, the share page and the emails.

## Before you start
1. Read `AGENTS.md`, `CLAUDE.md`, `.spec/EXTERNAL_AGENT_RULES.md` and `docs/specs/design-refresh-2.md` (sections 2 to 5 are the visual rules).
2. Read `docs/design-system/` for the Stage 0 tokens and shared parts.
3. Check that origin has no `harness-main-red` tag.
4. Work one slice at a time. Each slice is one branch named `antigravity/dr2-<slice id>` (for example `antigravity/dr2-g1a`) and one pull request into `main` with `Closes #N`.

## Rules that apply to every slice
- **Use the shared parts.** Every list row is `ui/Ledger`, every kind or hint badge is `ui/KindPill` or `ui/HintPill`, every rating is `ui/Stars`, and every busy mark is `ui/Equalizer`. Do not copy them inline.
- **Use tokens, not Tailwind colour names.** New code uses the plain token names (`surface-1`, `line`, `text-muted`, `accent`, `accent-fill`, `on-accent`, `accent-tint` and so on). It never uses `text-white` on an accent and never hard-codes a hex colour.
- **Type.**
  - Newsreader for page and section headings only.
  - Plus Jakarta Sans for everything people read or tap.
  - JetBrains Mono with tabular figures for dates, times, counts, prices and table headers.
  - Badges and small numbers are never serif.
- **Shape.**
  - Cards have 12 px corners.
  - Controls have 8 px corners.
  - Rows, tables, tabs and ledgers have square corners and straight borders, and rows join into one ledger.
- **Accent spend.** The solid accent fill is only for the main action on the screen.
- **No change to behaviour.** Sorting, filtering, editing, capture parsing, saving and what each screen shows stay exactly as they are. This package is visual only.
- **Missing stays missing.** Keep "Not known yet", "Venue not known", "No date yet" and similar text. Never fill a gap with a guess.
- **State is never shown by colour alone.** It always comes with an icon or a word.
- **Motion.** Use the `motion` package, keep it under 200 ms, and turn all of it off under `prefers-reduced-motion`. Nothing may delay typing or saving.
- **Touch targets.** 44 px on phones, and 36 px from 640 px up.
- **Do not edit Claude's files.** These belong to Track A or Stage 0:
  - `src/index.css` and `src/services/theme.ts`
  - `src/components/ui/Tabs.tsx`, `Ledger.tsx`, `KindPill.tsx`, `HintPill.tsx`, `Stars.tsx`, `Equalizer.tsx` and `Popover.tsx`
  - `src/App.tsx`, `EventsHome.tsx`, `EventDetail.tsx`, `PosterHeader.tsx` and `ui/DetailShell.tsx`
  - `StatsView.tsx` and `timeline/HeatmapView.tsx`

  If you need a change in one of them, write the file and the reason under "Immediate Next Step for Claude" in `.spec/SESSION_HANDOFF.md` and stop that slice.

## Slices

| Id | Slice | Target files | Done when |
|---|---|---|---|
| G1a | Table: tool row and header | `src/components/TableView.tsx` | Search, Sort and Filters are 8 px controls. Active filters show as removable chips with a "7 of 48" count. Headers are small mono caps, and the sorted column is brighter and shows the arrow. |
| G1b | Table: rows | `src/components/TableView.tsx` | Rows use `Ledger` with the 3 px edge bar (accent for a festival, grey for a show, amber for needs-you) and year separators ("2026 · 5 events"). The date is in mono with the weekday under it, and the kind pill and series dot sit under the title. Seen shows a mono count and the acts, with headliners bold. Details holds `Stars`, a mono price, the email icon, the needs-you pill and the lineup tick. Keyboard row navigation still works. |
| G2 | Agenda, Month and River | `src/components/timeline/AgendaView.tsx`, `MonthView.tsx`, `RiverView.tsx`, `parts.tsx` | Same ledger rows and mono dates as Table. There are no month headers in Agenda, only year separators. The today line uses the accent tint, not a solid fill. |
| G3 | Capture box | `src/components/CaptureBar.tsx` | 12 px card with a focus halo, and suggestions fade in. It stays one line, and nothing delays typing. |
| G4 | Home | `src/components/HomePage.tsx`, `YearTile.tsx`, `FeatureTiles.tsx` | Serif headline, a year card whose border glows on hover, a Needs-you strip, and bento tiles with tinted icon chips. Counts use heavy 800 sans. |
| G5 | Celebrations | `src/components/ui/confetti.ts`, `ui/Burst.tsx`, `MilestoneCard.tsx` | Confetti and the burst read the accent from CSS, with no hard-coded violet. They are skipped under reduced motion and fire only for real milestones. |
| G6 | Landing page | `index.html` | Same tokens and fonts as the app. The navy and the gradient are gone, and it works in dark and light. `PUBLIC_EXACT_PATHS` needs no change. |
| G7 | Share page and emails | `src/server/share/page.ts`, `src/server/email/templates.ts` | Same palette and fonts, with safe system fallbacks in email, and no navy. The text in both stays word for word. |

G1a has to land before G1b. The other slices can go in any order.

## Checks for each slice
1. `npm run lint --silent`, which runs the typecheck.
2. `npm test --silent`. This includes `tests/themeContrast.test.ts`, which fails if any text and fill pair drops below 4.5:1 in any of the 10 themes.
3. Look at the screen in dark and light, with at least violet and teal, at phone width (375 px) and desktop width (1280 px).
4. Commit with `node .harness/scripts/finish-slice.mjs "<message>"`, then update `.spec/SESSION_HANDOFF.md` as section 3 of `.spec/EXTERNAL_AGENT_RULES.md` says.

Put the check results and before-and-after screenshots in each pull request. Claude reviews each one before it merges.

## Reference
- Mockups: Charlie's design canvas (ask him for the link). The boards to match are "Round 3 · Library: Summary and Table" for G1 and G2, "Round 2 · 2 Bound Archive" for G3 and G4, and "Round 3 · Events and tabs" for rows and year separators.
- Spec: `docs/specs/design-refresh-2.md`.
