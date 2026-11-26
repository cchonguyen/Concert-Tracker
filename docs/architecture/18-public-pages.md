# Public pages

Part of [ARCHITECTURE.md](../../ARCHITECTURE.md).


Anyone can open the public pages without signing in. The app itself is at the address `/app` and still needs Cloudflare Access, as before. Lists and code: `src/server/site/publicPaths.ts` (the list), `src/server/share/door.ts` (the Worker's check) and `worker/index.ts` (which files the Worker hands out). Local development uses the same addresses in `server.ts`.

- The marketing page is `/` (static `index.html`, not part of the React app). Signed-in visitors get `/app` instead, unless the address has `?public=1`.
- Old app addresses (`/?view=...`, `/?gmail=...`, `/?sheets=...`) redirect with 302 to `/app` with the same query. Google's return addresses after Connect Gmail and Connect Sheets point at `/app`.
- Unknown addresses get `404.html`.
- Signed-in visitors: the Worker checks the `CF_Authorization` cookie (`isSignedIn` in `door.ts`, with the same token check as the second lock). A signed-in visitor on `/` is sent to the app with a 302 unless the address has `?public=1`. On `/demo` the Worker marks `<html data-signed-in>` and the sample banner offers "Go to your archive"; both responses are `private, no-store` with `Vary: Cookie`. Local development has no Access, so every visitor there is signed out.
- The marketing page is plain HTML (no React, no script) with its canonical and Open Graph URLs filled from `site.config.json` at build time. `robots.txt` and `sitemap.xml` are written by the Worker from the same origin (`SITE_ORIGIN` in `publicPaths.ts`). `robots.txt` disallows the app, the API and the share pages; the sitemap lists `/`, `/demo`, `/privacy` and `/terms`. `og.png` is the share image.
- Privacy and Terms are plain pages too (`public/privacy.html`, `public/terms.html`), the one copy of their wording. Inside the app the footer's Privacy and Terms links open a side panel in About's layout (`LegalDialog.tsx`) that fetches `/privacy.html` or `/terms.html` and shows its title, date line and sections (`parseLegalPage` in `src/services/legalPage.ts`); a modified click, or a direct visit, opens the plain page, which signed-out visitors can always reach.

- **Sample mode** (`src/services/sampleMode.ts`, `src/demo/sampleApi.ts`, `src/demo/sampleData.ts`). `/demo` serves the app's own page (`app.html`), and the app runs in sample mode from the start. The mode is decided before anything loads (`startMode`, run by `Boot.tsx`): `/demo` is sample mode with no server call; `/app` asks `GET /api/me`, and a member gets the archive, an explicit `not_invited` answer gets sample mode with the request banner at the same address, and any other failure (network, 5xx, timeout) shows an error screen, never sample data.
- In sample mode `lineupApi.ts` answers every read from the sample (`sampleApi.ts`) and never sends it. A read the sample does not have is refused, so the view shows its empty state. Every write is refused and opens one explainer (`src/components/ui/DemoPrompt.tsx`, "Log in (invite only)" or "Request access"). The save controls check `readOnly` on `MeContext` first and open the same explainer (`SampleGate.tsx`); the refusal in `lineupApi` is the fallback for a control that did not check. A window-level guard refuses any `/api` fetch that is not one of the two request-access calls (`GET /api/access-requests/mine`, `POST /api/access-requests`), which are the only server calls a stranger's sample makes. The sample's owner-only areas stay hidden (the sample plays a member). `scripts/check-demo-isolation.mjs` runs after every build and fails if the sample data is in a file that the app loads at start-up (static imports only).
- `MapView` takes an optional `pointFor` so the sample supplies its city coordinates without a server call.

Public allowlist. The Access bypass policy must list the same paths; the Worker's front door uses the same list. A test checks that this list and `publicPaths.ts` agree:

- `/`, `/index.html`, `/demo`, `/demo/*`, `/privacy`, `/privacy.html`, `/terms`, `/terms.html`, `/unsubscribe`, `/robots.txt`, `/sitemap.xml`, `/og.png`, `/favicon.ico`, `/favicon.svg`, `/favicon-32.png`, `/apple-touch-icon.png`, `/logo.svg`, `/manifest.webmanifest`, `/assets/*`, `/s/*`, `/S/*`.

The site's one address is `site.config.json`. A test checks that it matches `APP_URL` in `wrangler.jsonc`; `APP_URL` is still the bare origin, since Google's redirect is built from it.
