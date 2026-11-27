# Ticket stub styles and the landing look in the app

Approved by Charlie 2026-11-27 ("I would love to have a picker that chooses what style of ticket stub you would like (including the original style). Let's build this!"). Mockups: https://claude.ai/artifact/31HrhPXoz4AJsmyCJTpvot, row "Round 3" (App · Home, App · Event, App · Ranking, Ticket stub studies).

## Slice 44.1: Ticket style picker (built)

A per-device choice, saved like the theme mode and accent (`livearchive.stubStyle.v1`), shown in the menu's theme controls as "Ticket style":

| Style | Look |
| --- | --- |
| Original | The current stub (docs/specs/ticket-stub.md). Default. |
| Box office | Thermal paper: cream paper, faded blue-grey dot-matrix ink (VT323), grain. |
| Hard ticket | Pink card stock, condensed poster type (Anton) for the headline, Courier details, red serial and stamp, a double rule inset. |
| Raffle | Violet roll ticket with chunky mono type (Rubik Mono One) and a faint ADMIT ONE pattern. |
| Riso | Speckled black paper, the headline printed twice in pink and blue slightly off register (Anton), typewriter details (Special Elite), halftone dots. |

How it works (a design-system module, so new styles are cheap to add):

- `src/styles/ticket-styles.css` is the module. Its header states the contract: the tokens a style may set (paper and ink, type, texture, frame). Each style is one block that sets only those tokens. Shared parts (grain texture, the notch-cut texture layer, swatches) are written once.
- A style applies wherever `data-stub` is set: on `<html>` for the whole app, or on one element (a swatch, a preview, a single ticket). Tokens land on the ticket only, so the page around it keeps its colours.
- `src/services/theme.ts` holds the list (`STUB_STYLES`), labels, the key and `parseStubStyle` (unknown values fall back to Original). The picker and its swatches are generated from that list; each swatch is a small piece of the style's own paper.
- `useTheme` sets `data-stub` on `<html>`; `app.html` applies the saved value before the app draws, and loads each style's fonts.
- `tests/ticketStyles.test.ts` fails when a style in the list has no block in the module, or a block has no entry in the list.
- Paper colours are fixed per style (paper is paper), so a style looks the same in light and dark mode. Stub headers (`StubHeader`) keep the original look for now.

To add a style: write one block in the module, add its id and label in `theme.ts`, load its fonts in `app.html`.

## Later slices (not started; each needs Charlie's go)

- 44.2 Animated logo: replace the logo with the heartbeat version (`/mnt/project-files/logo-heartbeat/`), the pin pulsing with the beat, still under reduced motion.
- 44.3 App look: caps poster headers, a "second colour" token (pink by default, swappable per palette), the drifting contour background, button motion (slide up and grow, never tilt) and post-it panels, starting with Home, then Event detail, then Ranking.
