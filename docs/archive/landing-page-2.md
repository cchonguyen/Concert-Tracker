# Landing page 2 (direction D)

**Archived (2026-11-28):** Built and shipped.

Approved by Charlie 2026-11-27 ("Go ahead and build"). Mockup: https://claude.ai/artifact/31HrhPXoz4AJsmyCJTpvot, board "D · Combined".

## What changes

`index.html` (the static public page at `/`) gets the 2.0 look with livelier motion than the app:

- Top bar: logo, Features, Your data, and a pink "See the demo" button (the same style at the top, in the hero and at the bottom).
- Hero: uppercase headline "Every show. Every act. Every friend there." with a ticket stub on the right, two plainer stubs stacked below it at different tilts (to its right on a phone), and a "WENT" stamp.
- "Tonight's bill": four taped post-its (Email sync, Real lineups, Genres and weather, Series and streaks). On hover the tape peels, the icon hops and the label spreads.
- "What it does": five rows beside a screenshot carousel in a post-it frame that moves every few seconds and has dot buttons. Screenshots are cropped in so the text is readable. They come from the sample data at `/demo`, so nothing in them is real.
- "Your data is yours": the heading on a post-it, four rows in the same row style.
- "Doors open." and the demo button.
- Footer Privacy and Terms open a side drawer that loads `/privacy` or `/terms` in place. Both pages stay where they are, and the links still work with no JavaScript.
- Background: faint contour lines from an SVG filter that drift very slowly.
- Buttons slide up and grow on hover; they never tilt. Every animation stops under `prefers-reduced-motion`.
- "Log in (Request Invite)" replaces "Log in (invite only)".

## Rules kept

- The page stays static HTML (search engines read it on first load), with one small inline script for the carousel and drawer.
- Screenshots are imported by Vite from `src/landing/`, so they ship under `/assets/` and no new public path is needed.
- The animated heartbeat logo (`/logo-heartbeat.svg`, static `/logo.svg` under reduced motion) is used in the header.
