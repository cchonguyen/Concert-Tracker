# Ticket stub styles and the landing look in the app

Approved by Charlie 2026-11-27 ("I would love to have a picker that chooses what style of ticket stub you would like (including the original style). Let's build this!"). Mockups: https://claude.ai/artifact/31HrhPXoz4AJsmyCJTpvot, row "Round 3" (App · Home, App · Event, App · Ranking, Ticket stub studies).

## Slice 43.1: Ticket style picker (built)

A per-device choice, saved like the theme mode and accent (`livearchive.stubStyle.v1`), shown in the menu's theme controls as "Ticket style":

| Style | Look |
| --- | --- |
| Original | The current stub (docs/specs/ticket-stub.md). Default. |
| Box office | Thermal paper: cream paper, faded blue-grey dot-matrix ink (VT323), grain. |
| Hard ticket | Pink card stock, condensed poster type (Anton) for the headline, Courier details, red serial and stamp, a double rule inset. |
| Raffle | Violet roll ticket with chunky mono type (Rubik Mono One) and a faint ADMIT ONE pattern. |
| Riso | Speckled black paper, the headline printed twice in pink and blue slightly off register (Anton), typewriter details (Special Elite), halftone dots. |

How it works:

- `src/services/theme.ts` holds the list, the key and `parseStubStyle` (unknown values fall back to Original).
- `useTheme` sets `data-stub` on `<html>`; `app.html` applies the saved value before the app draws, like the theme.
- `src/index.css` restyles `.ticket-card` per style by redefining the ticket's own tokens (paper, text, perforation, accent, fonts) inside the card, and adds grain or pattern on the card's `::after`. Components are unchanged, so every ticket in the app (event hero, Home, year tile, Stats) follows the choice.
- The paper colours are fixed per style (paper is paper), so a style looks the same in light and dark mode.
- Stub headers (`StubHeader`) keep the original look for now.

## Later slices (not started; each needs Charlie's go)

- 43.2 Animated logo: replace the logo with the heartbeat version (`/mnt/project-files/logo-heartbeat/`), the pin pulsing with the beat, still under reduced motion.
- 43.3 App look: caps poster headers, a "second colour" token (pink by default, swappable per palette), the drifting contour background, button motion (slide up and grow, never tilt) and post-it panels, starting with Home, then Event detail, then Ranking.
