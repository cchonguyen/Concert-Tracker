# Rules for anyone changing this app

Read [REQUIREMENTS.md](REQUIREMENTS.md) first: it says what the app is for (remembering which events you went to and who you saw) and ranks the principles that settle trade-offs. Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing capture, lineup lookup, storage or review. These rules apply to people and AI coding agents alike (Claude, Gemini in AI Studio, Copilot, and others). If a change conflicts with them, change REQUIREMENTS.md or ARCHITECTURE.md first and say why.

- Never synthesize, default or infer a lineup, date, venue, stage, rating or setlist. Missing data stays missing and the UI says so.
- Every stored act must reference a stored source document and a quoted span from it.
- Gemini may only extract from text the app fetched. It never answers from memory and is never asked for confidence, dates it was not shown, or URLs.
- Reject any extracted name that is not found verbatim (after normalization) in its source text. Do not loosen `isVerbatim`.
- A billing role (headliner or support) is stored only with a quote that contains the marker words ("with special guest", "supported by", ...) and a billed act on each side (`src/server/lineup/billing.ts`). List order, font size or position never make a headliner. No role means "Artist".
- Concert or Festival is worked out in code (`src/server/events/scale.ts`); store only the person's own choice.
- Format is the person's own words; the app suggests past values but never fills it.
- Suggestions from an event's name (a source's listing, your other events, MusicBrainz) are one-tap offers; nothing is added to seen acts without a tap.
- Set times come only from a source that times them, stored on that source. Weather is looked up only when asked, only for a city that matches exactly one place, and stored with its URL.
- Confidence is computed in code from sources and review history.
- On a quota error, park the job and stop. Do not retry with another model and do not fall back to heuristics or regex parsing.
- Do not add hardcoded lists of festivals, venues or artists. Improve an adapter or add a new one under `src/server/lineup/adapters/`.
- Respect source limits through the shared rate-limited fetcher (MusicBrainz 1 request/second). Do not scrape AXS.
- Keep the canonical lineup and the personal event log (`logged_events`) separate.
- Artist genres come only from the music-story export, MusicBrainz read through music-story's genre map when asked, or you (`src/server/events/genres.ts`); yours win. Never infer a genre from a name, an event or a model; an act with none stays without one.
- Ticket emails are read by per-seller code under `src/server/events/email/`, never by Gemini. An imported show becomes an event only when you tick it, or is merged into an event you entered only when you pick that event (filling only its empty fields, undoable), and never fills personal fields, except a ticket price worked out from the same email's dollar total and ticket count, and only where the event has no price you set or cleared.
- Capture is two stages. Saving an event (stage 1) never waits on research, quota or a lineup; the lineup lookup (stage 2) only starts when asked for on a saved event.
- Stage 1 research uses structured APIs and web search results read in code. Gemini runs in stage 1 only when you press "Look again with Gemini" on an event, reads only pages the app fetched, and its dates are read in code from the quote it gives (`src/server/events/detailsGemini.ts`). Never call it from saving, plain "Look again" or Fill gaps. Its results are candidates: they never overwrite a field you typed, and fill empty fields on their own only when they match the full date you gave.
- Parse the capture line in code (`src/server/events/parse.ts`); text it cannot place stays in the name. Never add a model call to parsing.
- Keep capture to one line of text. New personal fields go on the event detail, not on capture.
- No demo or seeded data in the app. An empty app is empty. The one exception is sample mode: the app's own views over fictional sample data (`src/demo/sampleData.ts`), used at `/demo` and by a signed-in account that is not invited. Sample mode turns on only at start-up (`src/services/sampleMode.ts`), never on a network error; the sample is loaded by a dynamic import only in that mode, is never mixed with real data, is never sent to the server or written to the database, and every sample page says it is sample data.
- Public pages at the base address (`/`, `/privacy`, `/terms`, and any new page there) are listed in `PUBLIC_EXACT_PATHS` in `src/server/site/publicPaths.ts` in the same change that adds them. The Worker refuses every page not on that list once Access is on, and `tests/publicPagesList.test.ts` fails when one is missing. Anything under `/app` or `/api` stays off the list.
- Run `npm run lint` and `npm test` before committing, and add tests for new adapters or rules.
- Update ARCHITECTURE.md (and REQUIREMENTS.md, if a requirement changes) in the same change when behavior described there changes.
- When designing a new subsystem or modifying more than 3 architectural areas, present the plan and file breakdown first, and wait for confirmation before modifying code.
- Store multi-step feature plans and design specs inside the repository (under `docs/` or `specs/`) rather than only in ephemeral session artifacts.

## Design system

- Shared UI components live in `src/components/ui/` (IconButton, BackToTop, MenuButton, Popover, Pill). Use them for new UI.
- The design-system approach is wanted: when you touch a component that has its own inline copy of one of these patterns (a dropdown, a tooltip, an icon-only button, a pill, a back-to-top), move it onto the shared component in the same change. Do not build a fresh copy.
- Only add a shared component when the current change needs it. Do not build the whole library ahead of use.

<!-- >>> harness >>> -->
## Harness Sector 000 Card Catalog (Falcon Protocol)

You are **THE FALCON (`fa` — Tier 2 Aerial Coordinator)** running the main session thread.
Your mission is to coordinate work with minimal context bloat. Do NOT explore raw source code yourself.

### 1. Fast-Path Budget vs. Subagent Delegation
- **Fast-Path Budget (`.harness/config/thresholds.json`):** Max 3 source file reads, 1 search, and 1 single-file edit (<=25 lines) per task (`fa_fast_path`).
- **Goldfish Dispatch (Tier 3):** If `.spec/PROGRESS.md` lists an `[IN_PROGRESS]` slice with known `Target files:`, spawn `gf-coder` (Flash 3.8 / Haiku).
- **Architect Escalation (Tier 1):** If requirements are ambiguous, `Target files:` are unknown, or `.spec/BLACK_BOX.md` exists, spawn `el-architect` (Pro / Opus).
- **Antigravity Registration & Milestones:** Subagent payloads compile to `.harness/agents/runtime-payloads.json` for `define_subagent`; anchor milestones with `node .harness/scripts/start-slice.mjs`.

### 2. Quiet Verification Commands (Mandatory)
- Unit Tests: `node --test .harness/hooks/lib/*.test.mjs .harness/scripts/*.test.mjs .harness/scripts/lib/*.test.mjs`
- Typecheck & Lint: run the commands listed under `Project-Specific Commands` in `CLAUDE.md`.
- Navigator Checkpoint (`finish-slice.mjs` -> `navigator.mjs`): `node .harness/scripts/finish-slice.mjs "<msg>"` -> `node .harness/scripts/navigator.mjs --check`
- Scope & PR Gate: `node .harness/scripts/pr-scope-check.mjs`

### 3. Context Atlas (Read On-Demand Only)
- The full sector table and coordinates live in `.spec/ATLAS.md`. Open only the coordinates a slice's `Coords:` field names. Do not copy the table here.
<!-- <<< harness <<< -->
