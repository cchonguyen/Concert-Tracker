# Landing look as the app's design standard

Approved by Charlie 2026-11-27: "I also want to apply the new landing page design as the design system standard for the application", with "New condensed poster face. Ship animated heartbeat". Mockups: https://claude.ai/artifact/31HrhPXoz4AJsmyCJTpvot, row "Round 3" (App · Home, App · Event, App · Ranking). The landing page itself: `docs/archive/landing-page-2.md`. Ticket styles: `docs/archive/ticket-stub-styles.md`.

## What becomes the standard

| Part | Where it lives | Rule |
| --- | --- | --- |
| Poster headings | `PosterHeading` (`src/components/ui/`), class `poster-head`, token `--font-poster` (Anton), Tailwind `font-poster` | Section and page headings only. Always capitals. Body text, labels, numbers and source quotes keep their current faces. |
| Second colour | `--la-second`, `--la-second-soft`, `--la-on-second`; Tailwind `text-second`, `bg-second`, `border-second` | Pink beside the default violet. Each accent has its own partner in dark and light (indigo: amber, pink: violet, teal: light blue, orange: sky). For emphasis words, tape, stamps and highlights; never for status (good, warn, bad keep theirs). |
| Background | `AppBackdrop`, class `app-backdrop` | The landing page's contour texture behind every app page, tinted with the accent (5% opacity, 400 s rotation, 50 s drift), overlaid with a non-rotating 10 px sliding dot grid (10% opacity, 14 s slide). Still under reduced motion. |
| Button motion | `Button` (class `btn-pop`) | Lift 2 px and grow 3% on hover with a springy ease, press in on tap. Never tilt. Off under reduced motion. |
| Post-its | `PostIt` | A taped paper note for callouts and highlights; small resting tilt, straightens and lifts on hover, icon hops. Tones: paper, second, accent. |
| Heartbeat logo | `Logo`, `public/logo-heartbeat.svg` | The waveform beats and the pin pulses with it (1.45 s). The browser picks the still `/logo.svg` under reduced motion, with no script. Used in the app header and on the landing page. |
| Ticket stubs | `Ticket`, `src/styles/ticket-styles.css` | Already part of the system, unchanged. |
| Soft solid, no neon | Tokens `--la-{good,warn,bad,neutral}-soft`, `Pill`, `HintPill`, `CountBubble`, `Notice`; classes `btn-layer`, `today-line`, `hatch` | Pills, chips and badges are tinted fills with ink text and no hairline. At most two outlined-neon pieces per page (the Today line and the WENT stamp). See `docs/specs/neon-cleanup.md`. |

All of it is in one module, `src/styles/landing-look.css`, loaded by `src/index.css`. Screens use the shared components and tokens, never their own copies.

The design-system catalogue lists every part (`docs/design-system/design-system.json`: `typography`, `color.second`, `motion.easing`, `ticketStyles` and the components), with the rules in `docs/design-system/agent-rules.md`. Change them in the same change as the code.

## Slices

- **45.1 Shared parts and logo (built).** The module, tokens, `PosterHeading`, `PostIt`, `AppBackdrop`, `Logo`, button motion, the logo in the app header and on the landing page. No screen layout changes.
- **45.2 Home (built).** Poster headline with its second half in the second colour, poster section headings, and the "What LiveArchive can do" tiles as post-its (tilts and tones repeat in a fixed order).
- **45.3 Event detail (built).** Card titles (The edition, Who you saw, Lineup, Changes) are poster headings. The ticket hero is unchanged.
- **45.4 Ranking, Stats and Library (built).** Every page title (the heading under the section tabs), the stub header titles on lists, and the section headings on Stats, Ranking, Map and Log are poster headings.
- **45.5 Manage, panels and dialogs (built).** Manage's title, every panel and dialog title (h2, plus the shared Sheet and Confirm titles) are poster headings. Names of things (an edition, a series, an artist, an event, a month) keep the serif, and small h3 subheads stay as they are.
- **45.6 Home page links (built).** The Library and Explore links on Home are tilted post-its: the whole note is one button (`PostIt` with `onClick`), showing the page's icon, its name as a poster heading, its one-line blurb and its live count. Tones alternate within each section (Library paper and second, Explore accent and paper).
- **45.7 Summary count tiles (built).** The four counts at the top of Summary (Events, Artists seen, Venues, this year) are tilted post-its, each one button that opens the Table with its filter, as before. The number is in the poster face, the label in mono, and tones run paper, second, accent, paper.
- **45.8 Ranking and Stats count tiles (built).** The same post-it count tiles on Ranking (Artists, Seen more than once, Favorite sets), the Stats "All time" strip and the Stats "By season" tiles. Any new count tile is a `PostIt` with the number in the poster face; no plain bordered boxes for counts.
- **46.1 Button glow and pop (built).** `btn-pop` works at about half the landing page's strength: on hover a button lifts 1.5px, grows 2% and glows in the accent colour. It is on `Button`, `IconButton`, `MenuButton` and Quick add. Under reduced motion it keeps the glow and does not move.
- **46.2 and 46.3 Sliding choices (built).** Every row of side-by-side choices where one is picked uses the shared `Segmented`, so the chosen fill slides to the new choice as in Manage and Share. That covers Agenda's order, Ranking's sort and view, the Stats years, Event detail's weekend and the "things left" picker. `Segmented` takes an `icon` per option, `iconOnly` for icon-only rows and `stretch` for a full-width row. Do not build a new row of toggle buttons by hand.
- **46.4–46.8 Playful tabs (built).** In the shared `Tabs`, the open folder tab (Home, Library, Explore) slides to the new tab with an overshoot and squishes slightly taller in motion (keeping its area) and eases back on arrival. A page strip's underline slides with a squash, and the new tab's icon hops. All of it is off under reduced motion.
- **46.9–46.10 Polish & backdrop (built).** Separate ticket style picker on Share, teal secondary light blue, accent-tinted `Logo`, `PostIt` entrance animation, and rotating contour + sliding dot-grid `AppBackdrop`.
