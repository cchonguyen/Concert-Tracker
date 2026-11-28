# Shared UI

Part of [ARCHITECTURE.md](../../ARCHITECTURE.md).

A copyable export of these tokens, components, and voice rules lives in [docs/design-system/](../design-system/README.md). Update it in the same change whenever a shared component or token changes.

## Tokens & Styles (`src/styles/`)

All design-system CSS lives in modular files imported by `src/index.css`:
- `src/styles/tokens.css`: 5 accent scales (`violet`, `indigo`, `pink`, `teal`, `orange`), semantic `--la-*` tokens (`bg-surface-1`, `text-text-muted`, `border-line`, `bg-accent-fill`, `text-on-accent`, `text-good/warn/bad`), `@theme` radius/font roles (`--font-sans`, `--font-display`, `--font-mono`, `--font-poster`), and legacy `zinc`/`violet` light-mode remaps. `tests/themeContrast.test.ts` enforces 4.5:1 contrast across all 10 themes.
- `src/styles/landing-look.css`: LiveArchive 3.0 tokens (`--la-second`, `--ease-pop`), `PosterHeading`, `PostIt`, `AppBackdrop`, and `btn-pop`.
- `src/styles/ticket-styles.css`: Ticket geometry, real-hole notch masks (`.ticket-card`, `.stub-header`, `.stub-perf`), and the 5 `data-stub` themes (`original`, `thermal`, `hard`, `raffle`, `riso`).
- `src/styles/motion.css`: `.row-hover` fade-out trail, `.ledger-fresh`, `.pop-in`, `.save-flash`, `.icon-wiggle`, `.burst-mark`, `.tip-enter`/`.tips-nudge`, button press squash, and the global `@media (prefers-reduced-motion: reduce)` halt.

## Core Controls (`src/components/ui/`)

- **Buttons & Triggers:** `Button` (`primary`, `secondary`, `ghost`, `danger`, all sharing `btn-pop` hover lift/glow), `IconButton` (required `label` as `aria-label` + `Tooltip`, `44px` on phones / `36px` from `sm`), `MenuButton`, `Popover` (200 ms hover-close grace, opens on hover or tap), `Tooltip`, and `BackToTop` (`scrollBehavior()` respects reduced motion).
- **Choices & Navigation:**
  - `Segmented`: radio-group choices with a sliding `motion` highlight (`layoutId` fill), used for Manage/Share, Agenda order, Ranking sort/view, Stats years, Event weekends, Things left, and `ThemeControls` mode.
  - `Tabs`: `folder` (2 px accent cap + playful area-preserving tall squish in motion) and `underline` (2 px underline + icon hop), both instant under reduced motion.
- **Status & Lists:** `Pill` (`neutral`, `accent`, `good`, `warn`, `info`, `highlight`, `inferred`), `KindPill`, `HintPill`, `Ledger` (`Ledger.Row` with 3 px edge bar + `row-hover`, `Ledger.Separator` by year), `DateStack`, `NameList` (accent diamond separator), `Stars`, `Equalizer` (3-bar lookup indicator), `Burst`, and `SaveStatus` (`src/services/saveStatus.ts`, 500 ms debounce + blur flush).
- **Landing-Look Primitives:** `PosterHeading` (`font-poster` capitals with optional `second` accent span), `PostIt` (taped note with entrance rise/fade, resting tilt, straighten-on-hover, `paper`/`second`/`accent` tones), `AppBackdrop` (400 s rotating + 50 s drifting contour layer at 5% opacity with a non-rotating 10 px sliding dot grid at 10% opacity), and `Logo` (1.45 s heartbeat SVG tinted with primary `--la-accent`, static under reduced motion).
- **Tickets:** `Ticket` (`columns` / `rows`, `hero` / `small`, real masked notches, rules in `src/services/ticket.ts`) and `StubHeader` (framing stub for Summary/Ranking lists). `TicketStylePicker` (`ThemePicker.tsx`) lets users pick a stub style globally in the Menu or per-card in `ShareCards.tsx`.

## Event Detail (`EventDetail.tsx`, `DetailShell.tsx`, `PosterHeader.tsx`)

- **Responsive Shell (`DetailShell`):** Split view from `1100 px` (240 px list, 280 px from `1440 px`, open row highlighted with accent edge), slide-over from `768 px` (92% width), and bottom sheet below `768 px` (92% height with drag-to-close). Keyboard navigation: `J`/`K` or arrows move between events, `N` jumps to next with gaps, `Escape` closes. URL syncs `?event=<id>` via `src/services/detailNav.ts`.
- **Ticket Hero (`PosterHeader` + `HeroBar`):** The top of the detail renders a `<Ticket size="hero">` over `.poster-bg` (accent wash + still grain). The body shows kicker (`kind`, `year`), `TicketHeadline` (headliners or seen acts), `TicketEventLine`, `TicketSmallLine` (support, date, place), and the stub end shows up to 5 pieces (`admit`, `shortDate`, `barcode`, `ticketFacts`, `went` stamp, `showNumber`, `shorthand`) plus `StubSentence`. Directly below, `HeroBar` holds attendance/status, date confirmation, lineup citation count, `"Did you go?"` / `"Yes, I went"` (which tears the stub and fires `Burst`), interactive `Stars`, and `ThingsLeft` (missing gaps with `Segmented` chips and a `<Button variant="primary">` Next jump).
- **Body & Read Rows (`ReadRow`):** Two columns from `@[760px]` (`When and where` + `The edition` on the left; `Who you saw`, `Full lineup` `LineupTable`, and `Your night` on the right), with `"Where every detail came from"` (`EventSources` + inline `CheckDetails`) full width at the bottom. `ReadRow` aligns icon, label, value, and a single `"i"` `Popover` for sources/inferred values; `Type` is a `Segmented` Festival/Concert control (or lit `✦` chip until chosen).
