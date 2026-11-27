# Landing look as the app's design standard

Approved by Charlie 2026-11-27: "I also want to apply the new landing page design as the design system standard for the application", with "New condensed poster face. Ship animated heartbeat". Mockups: https://claude.ai/artifact/31HrhPXoz4AJsmyCJTpvot, row "Round 3" (App · Home, App · Event, App · Ranking). The landing page itself: `docs/specs/landing-page-2.md`. Ticket styles: `docs/specs/ticket-stub-styles.md`.

## What becomes the standard

| Part | Where it lives | Rule |
| --- | --- | --- |
| Poster headings | `PosterHeading` (`src/components/ui/`), class `poster-head`, token `--font-poster` (Anton), Tailwind `font-poster` | Section and page headings only. Always capitals. Body text, labels, numbers and source quotes keep their current faces. |
| Second colour | `--la-second`, `--la-second-soft`, `--la-on-second`; Tailwind `text-second`, `bg-second`, `border-second` | Pink beside the default violet. Each accent has its own partner in dark and light (indigo: amber, pink: violet, teal: pink, orange: sky). For emphasis words, tape, stamps and highlights; never for status (good, warn, bad keep theirs). |
| Background | `AppBackdrop`, class `app-backdrop` | The landing page's contour texture behind every app page, tinted with the accent, drifting over 50 s. Still under reduced motion. |
| Button motion | `Button` (class `btn-pop`) | Lift 2 px and grow 3% on hover with a springy ease, press in on tap. Never tilt. Off under reduced motion. |
| Post-its | `PostIt` | A taped paper note for callouts and highlights; small resting tilt, straightens and lifts on hover, icon hops. Tones: paper, second, accent. |
| Heartbeat logo | `Logo`, `public/logo-heartbeat.svg` | The waveform beats and the pin pulses with it (1.45 s). The browser picks the still `/logo.svg` under reduced motion, with no script. Used in the app header and on the landing page. |
| Ticket stubs | `Ticket`, `src/styles/ticket-styles.css` | Already part of the system, unchanged. |

All of it is in one module, `src/styles/landing-look.css`, loaded by `src/index.css`. Screens use the shared components and tokens, never their own copies.

## Slices

- **45.1 Shared parts and logo.** The module, tokens, `PosterHeading`, `PostIt`, `AppBackdrop`, `Logo`, button motion, the logo in the app header and on the landing page. No screen layout changes.
- **45.2 Home (built).** Poster headline with its second half in the second colour, poster section headings, and the "What LiveArchive can do" tiles as post-its (tilts and tones repeat in a fixed order). Stop for Charlie's review.
- **45.3 Event detail (built).** Card titles (The edition, Who you saw, Lineup, Changes) are poster headings. The ticket hero is unchanged.
- **45.4 Ranking, Stats and Library (built).** Every page title (the heading under the section tabs), the stub header titles on lists, and the section headings on Stats, Ranking, Map and Log are poster headings.
- **45.5 Manage, panels and dialogs (built).** Manage's title, every panel and dialog title (h2, plus the shared Sheet and Confirm titles) are poster headings. Names of things (an edition, a series, an artist, an event, a month) keep the serif, and small h3 subheads stay as they are.

Each later slice needs Charlie's go after he reviews Home.
