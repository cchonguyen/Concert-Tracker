# LiveArchive 2.0 design refresh: spec and build plan

Status: **approved by Charlie, 25 Nov 2026.** The work is split into two tracks after Stage 0: Track A (Claude) and the Gemini package "Ledger & Lobby" (`docs/specs/design-refresh-2-ledger-and-lobby.md`).

Mockups: https://claude.ai/artifact/2eTeWGL5SgNCHSAZMbY2eg (round 3 boards "Events and tabs" and "Dense event detail" are the target; round 2 mix 2 "Bound Archive" for Home and Stats).

## 1. What this is, and what it is not

- **Goal.** A facelift across the app: the Bound Archive look. It uses Editorial typography and Bento icons and colour, puts rows in joined ledgers, and keeps the information density people rely on.
- **Not in scope.**
  - The Harness UI restyle waits until 2.0 is built and proven.
  - The ticket stub is parked.
  - A dotted "Guess" style waits on the separate never-guess decision.
  - No change to capture, lookup, storage or review behaviour.
- **Product rules stay as they are.**
  - Capture stays one line.
  - "Not known yet" stays visible.
  - No state is shown by colour alone.
  - Nothing is invented for a missing date, lineup, stage or time.

## 2. Visual rules

### Colour
- **Keep the app's own colour engine** (the zinc/violet remap in `src/index.css`) so the 5 accents × 2 modes keep working. Plain-named tokens go on top of it:
  - `surface-1`, `surface-2`, `surface-3` and `sunken`
  - `line` and `line-strong`
  - `text`, `text-muted` and `text-faint`
  - `accent`, `accent-fill`, `on-accent`, `accent-tint` and `accent-tint-line`
  - `good`, `warn` and `bad`
- **Dark surfaces** step up evenly from the page, #0e0e11, to #141418, #1a1a1f and #232329. No pure black.
- **Light surfaces** step down from #ffffff to #f7f7f8 and #f0f0f2, with #efeff2 for sunken areas.
- **Ink on accent** works like a lit sign:
  - Dark mode: a bright fill (accent 400) with dark ink.
  - Light mode: a deep fill (accent 600, or 700 for teal and orange) with white ink.
  - This replaces every white-on-accent today (about 30 files). Those currently fail contrast for violet, pink, teal and orange.
- **Accent spend.** The solid accent fill is reserved for the main action (Add, Next, Save). Everything else uses the tint, an icon chip, a 2 px cap or a 3 px edge bar.
- **Per-event tint.** A soft wash in one corner of the poster, and a dot beside series names. It never sits behind text that must pass contrast, and a "Tint posters by event" switch in the theme picker defaults to on.
- **One palette everywhere.** The phone bar colour, the landing page, the share page and emails all move onto the same tokens.

### Type
- **Newsreader** (serif, 300 to 400) for page titles, section headings, the poster title and source quotes only.
  - Never on badges, counts, buttons or anything small.
  - Source quotes are the one place serif italic appears at body size (decided 25 Nov).
- **Plus Jakarta Sans** for everything a person reads or operates. Heavy 800 for headline numbers on the summary cards.
- **JetBrains Mono** for dates, times, counts in badges and tabs, order numbers and prices, with tabular figures.
- Both fonts are already downloaded by `app.html` but never wired in. The first slice wires them.

### Shape
- **Cards** (summary cards, stats cards, the capture box): 12 px corners, a 1 px line and an inner top highlight.
- **Controls** (buttons, inputs, icon buttons): 8 px corners.
- **Ledgers, rows, tabs and day pickers: square corners, straight borders.**
  - Rows join into one ledger.
  - A 3 px straight edge bar on the left shows the kind: accent for a festival, grey for a show, amber for needs-you. It is always paired with an icon and a word.
- **Tabs** sit on one bottom line with square corners. The current tab joins the panel below it and shows:
  - a raised neutral surface
  - a 2 px accent cap
  - bold text and an accent icon
  - a count in a mono pill

  It never uses the solid Add colour.
- **Events list:** year separators ("2026 · 5 events"), not month headers. "No date yet" gets its own group at the end.
- **Icons:** lucide at stroke 1.75. Kind and section icons sit in small tinted icon chips (Bento style).

## 3. Screens

| Screen | Target |
|---|---|
| Top bar and nav | Sunken bar with square tabs on its bottom line; Add is the only solid accent |
| Home | Serif headline, capture box with focus halo, year card, Needs-you strip, bento tiles with icon chips |
| Events home | Summary cards (heavy sans numbers, icon chips), square tabs with counts, joined ledger with year separators, hint and kind pills on the right |
| Library page row | Summary, Table, Manage, Log as a quieter level: bold text and a 2 px straight underline, no box (proposed 25 Nov; board "Library: Summary and Table") |
| Table and Agenda | Same joined ledger, edge bars and year separators as Summary; mono dates, counts and prices; small mono caps headers; filter chips with a shown-of-total count; icon stars; gaps written out; no display type |
| Event detail (desktop) | Poster full width (serif title, grain, tint, mono date line, sans badges, icon stars). **Two columns below.** Left: things-left strip, Your weekend, The edition, Sources. Right: Who you saw: square tabs (Lineup, You saw, Changes), day picker, lineup table |
| Event detail (phone) | Same content stacked in one column inside the bottom sheet; 44 px targets |
| Stats and heatmap | Serif card titles, bars that fade downward with a callout on the current year, dashed guides; one shared popover for heatmap days (works on tap); filled, outlined and dashed squares tell the states apart |
| Landing, share page, emails | Same tokens and fonts as the app; no navy or gradient |

## 4. Motion

There are two rules. Nothing moves at rest unless it is working on something. And nothing ever delays typing, saving or switching events. With reduced motion, all of it is off: states change instantly, celebrations are skipped and the equaliser stands still.

- **Glow** (at most one per screen):
  - capture box focus halo
  - a just-added row for 1.5 s
  - the year card border on hover
- **Breathe** (only while working):
  - a three-bar equaliser replaces spinners on lookups
  - the "Saving" dot
- **Highlight** (instant):
  - row hover lifts one shade and the edge bar goes from 3 to 4 px
  - an accent focus outline
  - hovering a source icon lights up the matching source
  - heatmap and stats hover cards
- **Move** (mostly under 200 ms, built with the `motion` package):
  - the tab cap slides between tabs
  - the detail panel slides in on desktop; the phone sheet follows a drag
  - previous and next events swap with a 120 ms fade
  - capture suggestions fade in
  - a new row slides in at the top; toasts rise
  - stats bars grow once per visit
- **React:**
  - star pop and ripple
  - the seen tick draws itself
  - buttons press in
  - confetti in the person's accent for real milestones only

## 5. Accessibility guarantees
- A new test (`tests/themeContrast.test.ts`) checks every text and fill pair in all 10 theme combinations at 4.5:1 and fails the build if one slips.
- Touch targets: 44 px on phones, 36 px from 640 px up, 40 px for close buttons. This fixes the 20 px Stats year buttons.
- Every spinner, BackToTop and SaveStatus respects reduced motion.

## 6. Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Own colour engine or Harness UI | Keep the app's own engine, with Harness-style token names. Approved with the plan |
| 2 | Where playfulness stops | Poster, year card, stats headlines, milestones and the landing page get the flourishes. Rows, tables, capture and detail fields stay plain |
| 3 | Colour across 10 themes | Lit-sign ink rule, tints for blocks, one solid fill per screen; checked by test |
| 4 | Per-event tint | Subtle wash plus series dot; switch in the theme picker, on by default |
| 5 | Display font | Newsreader for headings only; Jakarta for UI; Mono for numbers |
| 6 | Landing page | Same look as the app. Decided 25 Nov |
| 7 | Source quotes | Serif italic. Decided 25 Nov |
| 8 | Lineup | Stays a table. Decided 25 Nov |
| 9 | Library page row | Underline-only level between the section tabs and the in-page folder tabs (proposed 25 Nov, board "Library: Summary and Table") |

## 7. Build plan

Each slice is one pull request, follows the harness slice gate, and stays under 5 files where it can. Stage 0 goes first and is built by Claude. It now also builds every shared part that both tracks use, so after Stage 0 the two tracks never wait on each other. Then Track A (Claude) and the Gemini package run in parallel.

**Stage 0: foundation and shared parts (Claude, first)**
1. *[CORE]* Tokens and fonts. Add the token layer and the font roles in `@theme`, fix the phone bar colour, and add the contrast test. Files: `src/index.css`, `src/services/theme.ts`, `app.html`, `tests/themeContrast.test.ts`.
2. *[UI]* Ink on accent, part 1: `ui/Button.tsx`, `CaptureBar.tsx`, `PosterHeader.tsx`, `App.tsx`.
3. *[UI]* Ink on accent, parts 2 to 6: the remaining 26 files in groups of 4 or 5, by area.
4. *[UI]* Reduced-motion sweep: spinners in groups, `ui/BackToTop.tsx`, `ui/SaveStatus.tsx`.
5. *[UI]* `ui/Tabs.tsx`: square, joined to the panel, count pill, sliding cap (first use of `motion`), plus the underline variant for page rows.
6. *[UI]* `ui/Ledger.tsx` (row with edge bar and year separator), `ui/KindPill.tsx`, `ui/HintPill.tsx`.
7. *[UI]* `ui/Stars.tsx` with icons, and `ui/Equalizer.tsx`.
8. *[UI]* `docs/design-system/` page for the tokens and these parts, so Gemini builds from a written reference.

**Track A: app core (Claude, after Stage 0)**
- A1. Shared `Popover` for the heatmap and stats, replacing native title tooltips.
- A2. Top bar, section tabs and Library and Explore page rows onto `Tabs` (`App.tsx`).
- A3. EventsHome (Summary): summary cards, folder tabs, ledger with year separators.
- A4. Event detail poster: grain, tint, icon stars, sans badges.
- A5. Event detail two-column body with Who you saw tabs and the lineup table (`EventDetail.tsx`, 2 or 3 slices).
- A6. DetailShell: open and close motion, phone drag, the 120 ms swap between events.
- A7. Stats and heatmap (`StatsView.tsx`, `timeline/HeatmapView.tsx`).

**Gemini package "Ledger & Lobby" (after Stage 0)**
The full brief is `docs/specs/design-refresh-2-ledger-and-lobby.md`.
- G1. Table (`TableView.tsx`, 2 slices).
- G2. Agenda, Month and River (`timeline/AgendaView.tsx`, `MonthView.tsx`, `RiverView.tsx`, `parts.tsx`).
- G3. Capture box: focus halo and suggestion fades (`CaptureBar.tsx`).
- G4. Home: bento tiles and the year card (`HomePage.tsx`, `YearTile.tsx`, `FeatureTiles.tsx`).
- G5. `ui/confetti.ts`, `ui/Burst.tsx` and `MilestoneCard.tsx` read the accent from CSS.
- G6. Landing page (`index.html`).
- G7. Share page and emails (`src/server/share/page.ts`, `src/server/email/templates.ts`).

**Who owns which file.** Each file belongs to one track. Gemini does not edit `src/index.css`, `src/services/theme.ts`, `src/components/ui/Tabs.tsx`, `Ledger.tsx`, `KindPill.tsx`, `HintPill.tsx`, `Stars.tsx`, `Equalizer.tsx`, `Popover.tsx`, `App.tsx`, `EventsHome.tsx`, `EventDetail.tsx`, `PosterHeader.tsx`, `DetailShell.tsx`, `StatsView.tsx` or `HeatmapView.tsx`. If a Gemini slice needs a change there, it writes the need into `.spec/SESSION_HANDOFF.md` and Claude makes it.

Docs: `docs/design-system/` and `ARCHITECTURE.md` (shared UI section) are updated in the same slice as each token or component change.
