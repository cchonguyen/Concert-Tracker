# System Specification & Contracts

The full spec already lives in the project docs. This file holds only what `/triage` and the `architect` subagent add for the feature in progress; it must not contradict them.

- Requirements and ranked principles: [REQUIREMENTS.md](../REQUIREMENTS.md)
- Architecture, data model and module boundaries: [ARCHITECTURE.md](../ARCHITECTURE.md)
- Hard rules for every change: [AGENTS.md](../AGENTS.md)

## 1. Core Scope & MVP Boundaries
Feature: **Two-way reader test: Cloudflare Workers AI and paid Gemini, with an AI call log and spend guards** (triaged 2026-11-12, scope confirmed by Charlie 2026-11-12). Full spec: [docs/ai-reader-spec.md](../docs/ai-reader-spec.md). Research: `/mnt/project-files/ai-provider/Gemini free tier replacement options.md`.

- **Core problem:** the Gemini free tier refuses reads far below its stated limit (6 calls on 2026-11-02), so lineup reading and "Look again with Gemini" fail often. Volume is small: about 200 reads a month, peak 50 a day, typical page 2,000 tokens, largest 43,000.
- **Confirmed scope (Charlie):**
  1. One reader interface with two providers behind it: the existing Gemini client (billed key, model pinned by name) and a new Workers AI client (`ai` binding). One provider is live at a time, chosen by a setting. No automatic fallback between them (AGENTS.md).
  2. An AI call log: every model call records when, why (feature and job), provider, model, tokens in and out, estimated cost, duration, outcome and error code, and extraction quality (names returned, names passing the verbatim check, JSON valid or not).
  3. Spend guards that fail closed: caps per call (input size, max output tokens), per job, per day and per month, in calls and in estimated cost; a circuit breaker that stops all AI calls only after repeated provider failures, a provider quota error or a global day or month cap breach (never for one oversized page or one job over its cap); every refusal is logged with its reason; the job parks and stops as on a quota error today. No retry loops.
  4. A local CLI benchmark (`scripts/recall-test.ts`, no production routes or columns): the models on pages Charlie has confirmed by hand, at least one near 43,000 tokens; pass mark 90% overall and 70% per page; the result is printed to the terminal; the winner goes live only by Charlie's choice, and the Workers AI production slices are built only after he reads it.
  5. A plain owner view of the log and the guard state, and docs updated (AGENTS, REQUIREMENTS, ARCHITECTURE).
- **Facts:** `src/server/lineup/gemini.ts` is the only SDK user. Call sites: pipeline.ts (stage 2), events/detailsGemini.ts (stage 1 button), search.ts geminiSearch (grounded discovery, off). No `ai` binding in wrangler.jsonc. `quota_ledger` key is text `provider:model:window`. Workers AI: 10,000 free neurons a day, error 3036 = allowance used, 3040 = busy (both HTTP 429), several models default `max_tokens` to 256, JSON schema not guaranteed. Gemini paid: HTTP 402 at zero balance. Workers Free: 50 subrequests per request, so the log is one write per call at most.
- **Charlie applies migrations; threads only write them.** Next free number is 0038.

## Prev 1b. Design system export (triaged 2026-11-12, kept for reference)
Feature: **Design system export for onboarding new Claude Code apps** (triaged 2026-11-12, discovery brief, not yet approved).

- **Core user problem:** Charlie wants a new app built with Claude Code to start with LiveArchive's design language and philosophy, without re-explaining it.
- **What exists:** shared components in `src/components/ui/`; theme in `src/services/theme.ts` and `src/index.css` (Tailwind v4 CSS-first, accent scales, light remap, radius tokens); `docs/architecture/15-shared-ui.md` (component inventory, touch targets, reduced motion, breakpoints); AGENTS.md "Design system" section; REQUIREMENTS.md ranked principles. No token file or export exists. No typography, spacing or motion tokens exist. No voice or copy guide exists.
- **Proposed export (docs only):** `docs/design-system/` holding a token file (JSON) and a short Markdown guide. Categories: philosophy (ranked principles), tokens (colour, accents, light/dark, radius, breakpoints), components (purpose, props, states, a11y contract), patterns (detail shell, save status, popover vs menu), accessibility rules, voice and copy (warm, inviting, never cloying; to be written), AI-agent rules (the AGENTS.md design rules, generalised), and onboarding steps for a new Claude Code repo.
- **Files-Touched (estimate):** 2 to 4 new docs, optional AGENTS.md link. Contract-Change: no. Cross-Module: no.
- **Open questions:** copy-by-hand or shared package later; write the voice section now; describe only what exists or also the intended direction.

## Prev 1. Past-event suggestion (triaged 2026-11-11, awaiting approval)
Feature: **"What did you go to?" past-event suggestion** (triaged 2026-11-11, discovery brief, not yet approved).

- **Core user problem (revised 2026-11-11 by Charlie):** when someone types a line for an event that already exists as a canonical edition, the bar should offer that edition, so a friend who adds it after Charlie gets the same canonical details. Searching only your own log is not enough.
- **Proposed behavior:** as you type, the parsed line (name, venue, city via `parseEventInput`) is matched against canonical editions (`event_editions`, migration 0002). A match shows an "Is it this one?" offer under the bar. A tap links the new event to that edition (`logged_events.edition_id`, migration 0003), which brings its confirmed lineup and details. Nothing is saved or merged without a tap. Save stays first and never waits on the match.
- **Privacy:** the search returns only canonical edition facts (name, date, place, confirmed lineup). It never reveals who else logged an event or anything from another user's personal log.
- **Matching (proposed):** normalized exact match on series name (case, punctuation, leading "the") plus date or year. No fuzzy scoring.
- **Architecture (proposed):** a new server search route over `event_editions` (read-only, owner-scoped auth as today), called as the user types, debounced. The client renders the offer with `SuggestInput` or a small list, and reuses `matchNames` and `suggestionsFor` (`src/services/format.ts`). No migration is expected, because `event_editions` and `logged_events.edition_id` already exist. A new route is a new API contract, so this is a contract change.
- **Files-Touched (estimate):** about 6 to 8 (`CaptureBar.tsx`, a server search route, a store query, a pure matcher, a client hook, tests). Contract-Change: yes. Cross-Module: yes (client, server, database).
- **Decisions (Charlie, 2026-11-11):**
  1. A tap pre-fills the new event's fields from the canonical edition. Each filled field is sourced as the edition's source, not "you".
  2. The same series name in a different year can match, but every suggestion shows its year.
  3. A name alone is enough to match. Each suggestion shows its date.
  4. Events in Recently deleted never match.
- **R1.9 relevance:** venue and city already suggest what you have entered before, and city suggests real places as you type. Venue-to-place links apply to edition matches. Applies to typed fields only, so the suggestion feature stays separate from R1.9.
  5. A pre-fill copies everything canonical: date, location, venue, lineup, weather.
- **Plan:** `/mnt/project-files/canonical-autocomplete/plan.md` (stages A to C, slices A1 to B3). Open: lineup vs who you saw (AGENTS.md tap rule), weather source, members creating editions.

## Prev 1. Manage section (shipped, kept for reference)
Feature: **Manage section** (triaged 2026-10-28). Full design: [../docs/manage-section-design.md](../docs/manage-section-design.md).

- **Core user problem:** artists, people, venues, places and series are free text copied onto each event, so fixing a spelling means editing events one by one, and the copies drift apart. Charlie wants one place to rename, merge and describe each of them once.
- **MVP deliverables:**
  1. **Records with permanent IDs** (migration 0014): `entities`, `entity_aliases`, `entity_links`, `entity_history`; events point at them by ID; backfill from current names (only exact matches after normalization are grouped; others become "possible duplicate" offers); old text columns kept and written alongside for one release. Sheets and CSV become one-way outputs from the app.
  2. **Manage tab:** a list per category (Artists, People, Venues, Places, Series, Organizations), entry view with its events, Rename everywhere, Merge (old name kept as AKA), AKA, change history with undo. Series panel moves in; Organizations with "Hosted by" right after Series. Artists tab cards link to their Manage entry and back.
  3. **Venue carries its place:** an event at a venue with a place takes that city, state and country everywhere, with no confirm step. On backfill, a venue whose events disagree stays empty and Data health asks Charlie to pick.
- **Later slices, in order (not MVP):** people first/last name, note and width-adaptive display (full, First L., initials, longer when they would collide); labels as records (Indoor/Outdoor) with category fields, linked suggestions and the full Data health view; the "Do first" insights in the design doc.
- **Blocking questions:** None. Assumed reading of "Sheets and CSV pull from the app": Sheet sync stops reading sheet edits back; "Import a list" stays for adding new events only.

## 2. Strictly Out of Scope ("Do NOT Build" List)
- Automatic fallback from one provider to the other, or any retry with another model.
- A replacement for Gemini's grounded web search (stays off; Brave path unchanged).
- A model picker in the UI, or per-user provider choice.
- Any change to stage 1 capture, saving, the verbatim rule or the no-guessing rules.
- Third providers (Haiku, OpenAI, Groq). Only if both fail the test, and only after Charlie says so.
- Page text or prompts in the call log (sizes and counts only).
- Removing the Gemini code or renaming the buttons before the test result is in.

## Prev 2b. Design system export Do NOT Build (kept for reference)
Design system export:
- No generator, build step or Style Dictionary pipeline. The export is a document.
- No components that the app does not use yet (AGENTS.md: add only when needed).
- No Storybook or docs site.
- No published package or cross-repo sync. The harness engine stays hub-only.
- No invented typography or motion tokens. Describe only what the app does.
- No change to app code or runtime behavior.

## Prev 2a. Past-event suggestion Do NOT Build (awaiting approval)
- No fuzzy, similarity or model matching. It would be guessing (AGENTS.md: never infer; principle 1).
- No auto-merge, auto-fill or auto-add. Every change needs a tap (AGENTS.md: one-tap offers).
- No waiting on the match before save (AGENTS.md: stage 1 never waits).
- No model call or second parser. `parse.ts` stays code (AGENTS.md).
- No new field on capture. The line stays one line.
- No hardcoded venue or artist lists.
- No writes to canonical lineup data from this feature. The personal log and canonical data stay separate.
- No writes from sample mode.
- No "I saw everyone" or other bulk tick of seen acts (Charlie, 2026-11-11). It invites ticking acts you did not see; each seen act is one tap.

## Prev 2. Manage section Do NOT Build (shipped, kept for reference)
- Anything AGENTS.md forbids (guessed data, hardcoded festival/venue/artist lists, model calls in parsing or saving, demo data, AXS scraping).
- Manage section:
  - Venue location lookup (finding a venue's address or city from a source). It is a separate, later requirement.
  - Artist genres and anything from music-story, until that data has been checked.
  - Showing a venue's name as it was on the night. Always show the current name; old names are AKA only.
  - Contact links for people.
  - Reading edits back from Google Sheets or CSV into existing events.
  - Automatic merges of names that only look alike. These are offers only.
  - Dropping the old text columns in the same release as the ID backfill.
  - No Labels category, category-attribute gap prompts or linked label suggestions in the MVP (step 5).
  - No People first/last name split or adaptive display in the MVP (step 4). In the MVP a person is one record with a single name plus AKA, like the other kinds.
  - No hard delete of entities. A record goes away only by being merged into another one.
  - The "hidden complexity" ideas (discovery story, MusicBrainz home city, lineup source per series, timezones, sourced capacity/status) and the "Do next" ideas (home city distance, spend per organization, crew view, B2B network).

## 3. Data Models & Module Boundaries

**AI reader** (full spec: [docs/ai-reader-spec.md](../docs/ai-reader-spec.md); slices 10.1 to 10.20; 10.15 to 10.17 are gated)
- Module `src/server/reader/` (`types.ts`, `schemas.ts`, `geminiAdapter.ts`, `workersAiAdapter.ts`, `config.ts`, `pricing.ts`, `guard.ts`, `callLog.ts`, `guardedReader.ts`, `recall.ts`). `src/server/lineup/gemini.ts` stays the only `@google/genai` user in `src/`. Pipeline, details route and discovery hold only a `GuardedReader`. `recall.ts` is pure scoring used by the local CLI `scripts/recall-test.ts` (outside `src/`, never deployed, never writes to lineups or the database).
- `ReaderClient { provider, model, extractPerformers, extractEventDetails }` returns `ReaderResult<T>` = `{ ok: true, value, usage: { provider, model, inputTokens, outputTokens, durationMs } }` or `{ ok: false, reason: 'invalid_json' | 'input_too_large', usage }`. Quota throws `QuotaExhaustedError` (park; `scope: 'global' | 'job'`); Workers AI 3040 throws `ReaderBusyError` (the job's normal attempts path). No fallback between providers, no repair call.
- Reasoning: Gemini models starting `gemini-2.5` get `thinkingConfig { thinkingBudget: 0 }`; all others get `thinkingConfig { thinkingLevel }` from `READER_THINKING_LEVEL` (`OFF` as `LOW`; never `thinkingBudget` on 3+, never default `MINIMAL`). No `temperature`, `topP`, `topK`, `frequencyPenalty` or `presencePenalty`; `contents` never ends with a `model` turn. Workers AI sends `reasoning_effort: 'low'` and `chat_template_kwargs: { enable_thinking: false }` and reads either response envelope. Empty Gemini balance (HTTP 402, or 429 "prepayment credits are depleted") throws `QuotaExhaustedError(now + 6h)`.
- Guards (numbers 1 to 3 and 5 to 9; 4 unused): kill switch, breaker open, unpinned model (`-latest`, only when `READER_PROVIDER` is explicit), input size (returns `input_too_large`, no throw, breaker untouched), per-job calls (job-scoped error, breaker untouched), day spend, month spend, call caps. The breaker opens only on consecutive provider failures, provider 402/429, or guards 7 to 9. Spend: pre-call in-memory check of `used + worstCaseMicroUsd` against the cap with no ledger write; one post-call write of the real cost. `pricing.ts` has `PRICES` plus `FALLBACK_PRICES` (gemini 1.50 in / 7.50 out, workers-ai 0.10 / 0.40 per million tokens), so an unlisted model is never blocked for price.
- Table `ai_calls` (migration 0038, owner-read RLS, service-role write): id, created_at, feature (`lineup_extract`, `details_extract`, `discovery`), job_id, event_id, user_id, provider, model, source_document_id, input_chars, input_tokens, output_tokens, est_cost_usd, duration_ms, outcome, error_code, guard_reason, names_returned, names_verbatim, names_rejected. No page text or prompts. One insert per call. Store methods `addAiCall`, `listAiCalls`, `deleteAiCallsBefore` on `LineupStore` (both stores).
- Table `ai_calls` (migration 0038, owner-read RLS, service-role write): id, created_at, feature, job_id, event_id, user_id, provider, model, source_document_id, input_chars, input_tokens, output_tokens, est_cost_usd, duration_ms, outcome, error_code, guard_reason, names_returned, names_verbatim, names_rejected, plus recall columns run_id, names_expected, names_matched. No page text or prompts. One insert per call. Store methods `addAiCall`, `listAiCalls`, `listAiCallsByRun`, `deleteAiCallsBefore` on `LineupStore` (both stores).
- Guards use `quota_ledger` keys only (`reader:breaker`, `reader:job:<id>`, `reader:spend:day:<d>`, `reader:spend:month:<m>`, `reader:calls:month:<m>`, `reader:logfail:<d>`, plus the existing `provider:model:day`), never `ai_calls`. Fail closed.
- Env vars: `READER_PROVIDER` (`gemini` default, or `workers-ai`), `READER_ENABLED` (`on`), `WORKERS_AI_MODEL`, `WORKERS_AI_DAILY_LIMIT`, `WORKERS_AI_PER_MINUTE`, `READER_THINKING_LEVEL` (`LOW`; LOW|MINIMAL|MEDIUM|HIGH|OFF), `GEMINI_EXTRACTION_MODEL` (code default `gemini-3.5-flash-lite`, swappable in the dashboard with no redeploy), `READER_MAX_INPUT_CHARS` (200000), `READER_WINDOW_CHARS` (180000), `READER_MAX_OUTPUT_TOKENS` (8192), `READER_MAX_OUTPUT_TOKENS_DETAILS` (1024), `READER_MAX_CALLS_PER_JOB` (6), `READER_MAX_SPEND_DAY_USD` (0.50), `READER_MAX_SPEND_MONTH_USD` (5), `READER_BREAKER_FAILURES` (5), `READER_BREAKER_COOLDOWN_MIN` (30). Binding `AI` in `wrangler.jsonc` (gated slice 10.16). Pass mark 90% overall and 70% page floor live in the CLI, not in env.
- Routes: no recall routes. `GET /api/status` gains `reader` (`recent` for the owner only); `gemini` stays until the switch.
- Other features' text below is unchanged.

- See ARCHITECTURE.md. Feature contracts for the Manage section (from the Gemini audit, 2026-10-28; see DECISIONS.md ADR-002):

**Entities and aliases**
- `entities`: `id uuid` primary key, `kind`, `name`, `name_normalized`, `attrs jsonb`, `merged_into_id uuid null references entities(id)` with `check (merged_into_id is distinct from id)`, timestamps. `unique (kind, name_normalized)` over rows that are not merged.
- `entity_aliases`: `entity_id`, `kind`, `alias_normalized`, with `unique (kind, alias_normalized)`. The same name may exist under different kinds (an artist and a series can share a name), never twice within one kind.
- Resolving or creating a record checks primary names and aliases of that kind together, using the same normalizer the app already uses for artist keys.
- Merges are flattened. If A was merged into B and B is then merged into C, A is repointed to C, so `merged_into_id` never chains. Readers follow `merged_into_id` once.
- No hard delete (see section 2).

**Links**
- `entity_links`: `primary key (from_id, to_id, role)`, `check (from_id <> to_id)`. Allowed `(from kind, role, to kind)` triples are listed in code and checked on write: venue `in` place, series `hosted_by` organization, and later labels and `introduced_me_to`. A merge moves links to the kept record and drops any that become duplicates.
- `logged_events.venue_id`, `series_id` and `place_id` are real foreign keys. Person and artist IDs inside `companions` and `seen` JSON cannot have foreign keys, so the store checks they point at live (not merged) records on every write, and merge rewrites them.
- `src/server/lineup/store/fileStore.ts` enforces the same rules as Supabase. Tests run against the file store.

**Dual-write release (0014)**
- The legacy text columns (`venue`, `city`, `region`, `country`, `series`, `companions`, seen act names) stay. Rename, Merge and venue → place changes **also rewrite those columns** on every affected event in the same operation, so a rollback to text-only reading loses nothing. "A rename touches no event rows" holds only after the later migration that drops the text columns.

**History and undo**
- `entity_history` rows hold a manifest in JSON (`HistoryEntry` in `src/server/entities/types.ts`): the operation and its records, the full before and after state of the touched records, their aliases and their links, and for each event the fields the change rewrote, before and after (empty fields as null). It is written before anything else changes. Undo applies `before` exactly.
- Undo is refused while a touched record, its aliases or its links differ from `after` (undo the later change first). An event changed since (its rewritten fields differ from `after`) is left as it is and listed; the rest are put back. Adding an organization is recorded but not undoable (records are never deleted).
- When two merged artists (or people) are both on one event, the entries are combined into one. Marks are unioned: favourite, set type and B2B, and solo set. The event's prior list is saved in the manifest first.

**Venue → place provenance**
- When an event's venue has a place, the event's `city`, `region` and `country` come from it with `sources.city/region/country = { sourceType: 'venue' }`. Stage 1 research and import location values are not applied to such an event; they stay offers on the event's venue instead.
- If a venue's place changes later, events with stored weather for the old city are flagged (`weather.cityChanged`; weather is not re-fetched on its own, per AGENTS.md).
- Labels (M5a): kind `label` needs migration 0016 (widens the `entities.kind` check). Links `has_label` from venue and series; one label per group on a record (adding one replaces the other in its group). Per-kind details in `src/server/entities/attrs.ts`, set with `updateAttrs` (history `details`).
- Built in M3a (`src/server/entities/venuePlace.ts`): applied on every save by the linking store; the replaced location is kept in the venue's `attrs.placeOffers` (newest per place, at most 20). A venue first saved with a city is put in it. The first backfill does not do that; a one-time pass afterwards (`venue_places_backfill` setting) puts in a place only venues whose events all use one city, as one undoable history entry, and `GET /api/entities/health` lists the venues whose events disagree. Merging venues keeps the target's place.

**Sheets, CSV and list import**
- Sheet sync is one-way: the app writes the sheet, and nothing is read back from it.
- In `src/services/listImport.ts`, a row that matches an event by the app's ID column uses `fillPatch` only (empty fields, plus acts or people not already there). `editPatch` and its three-way merge are retired. Acts and people are matched by resolved entity ID through aliases, so a different spelling of someone already on the event is not added twice.

**Canonical edition suggestions** (plan: `/mnt/project-files/canonical-autocomplete/plan.md`; slices 9.1 to 9.5; no migration)

- `GET /api/editions/suggest?q=<text>`, any signed-in member (mounted in `src/server/lineup/routes.ts`; not under `/manage/canonical`, which is owner-only). Response: `{ editions: EditionSuggestion[] }` with `EditionSuggestion = { id: string; name: string; year?: number; startDate?: string; endDate?: string; venue?: string; city?: string; country?: string; actCount: number }`. Canonical facts only; never who else logged it, and nothing from another member's log. Missing facts are omitted, never defaulted.
- Rules: confirmed editions only (never `draft`); `q` under 2 letters returns `[]`; editions linked to the caller's live events (`listEvents()`, which already skips deleted) are excluded, so the caller's Recently deleted events are ignored and do not hide an edition; limit 5 to 8 (default 5); match on normalized words of the edition name and series, each typed word a word prefix (case, punctuation and leading "the" normalized as elsewhere); year is not matched on, only used to rank (a typed year ranks equal-year first, then newest); no fuzzy, similarity or model matching.
- Store method on `LineupStore` (`src/server/lineup/store/types.ts`), implemented in `fileStore.ts` and `supabaseStore.ts`: `suggestEditions(query: string, opts: { excludeIds: string[]; limit: number }): Promise<EditionSuggestion[]>`. Supabase narrows with `ilike` on name or series, then applies the word-prefix test in code so both stores agree; tests run against the file store.
- `POST /api/events { text: string; editionId?: string }`. Without `editionId`: unchanged (`newEvent`). With it: 404 if the edition is missing or not `confirmed`. Otherwise `newEventFromEdition(edition, text, now)` in `src/server/events/service.ts` copies name, year, startDate, endDate, venue, city, country (only those the edition has), each sourced `{ sourceType: 'edition', editionId }`; sets `editionId` (the link); sets `details.status = 'matched'` so no stage 1 research runs; the lookup job is created through the existing `createLookup`, which finds the confirmed edition by key and goes to review with no network calls. The venue's place still fills city, region and country on save as today (`venuePlace.ts`). Personal fields are never copied: seen stays empty, companions, rating, price, notes, format, own series name, Concert or Festival choice. The lineup shows through the edition link only.
- New `FieldSource` type in `src/server/events/types.ts`: `sourceType: SourceType | 'venue' | 'edition'`, plus optional `editionId?: string`. The UI label reads "from the canonical edition".
- Weather (B3, option 2a): after a pre-filled save, `lookupWeather` runs once, server-side, for the saved event, only when it has a city and a start date. It stores the result with its URL only when Open-Meteo places the city exactly; otherwise it stores nothing and returns the usual note. Never re-run automatically; never copied from another member's event. A failure never fails the save.
- No "I saw everyone" button (Charlie, 2026-11-11): each seen act is its own tap, so people curate who they actually saw. A bulk tick is on the Do NOT Build list.
- No suggestions and no writes in sample mode. No writes to `event_editions` or `performances`.

**Global Archive Series, Multi-Weekend & Egress Optimization Contracts** (2026-11-15; see DECISIONS.md ADR-005)

- **Nullable Series Slug:** `event_editions.series_slug` is nullable (`text null references event_series(slug) on delete set null`). Standalone concerts do not generate stub series entries. `seriesSlug` in TypeScript types (`EventEdition`, `EditionHeader`, `NewEditionInput`) is `string | null | undefined`.
- **Hierarchy Data Models:**
  - `Brand -> Series -> Edition -> Event/Weekend`:
    - `event_series`: `slug` (PK), `name`, `brand` (text null), `aliases` (text[]), `city`, `region`, `country`, `created_at`, `updated_at`.
    - `event_editions`: add `weekends jsonb null default '[]'::jsonb`, `region text null`.
  - `EditionWeekend`:
    ```typescript
    export interface EditionWeekend {
      weekendNumber: number; // 1-based index (e.g. 1 for Weekend 1)
      name?: string; // Optional label, e.g. "Weekend 1" or "Spring Edition"
      startDate: string; // ISO date YYYY-MM-DD
      endDate: string; // ISO date YYYY-MM-DD
      ticketTypes?: string[]; // e.g. ["GA", "VIP"]
      lineupActs?: string[]; // acts specific to this weekend if split
    }
    ```
  - `EditionHeader`:
    ```typescript
    export interface EditionHeader {
      id: string;
      title: string;
      seriesSlug?: string | null;
      brand?: string | null;
      editionType?: 'festival' | 'concert' | 'tour';
      startDate?: string | null;
      endDate?: string | null;
      venue?: string | null;
      city?: string | null;
      region?: string | null;
      country?: string | null;
      actCount: number;
      weekends?: EditionWeekend[];
      status?: 'draft' | 'provisional' | 'verified';
    }
    ```
  - `SeriesSummary`:
    ```typescript
    export interface SeriesSummary {
      slug: string;
      name: string;
      brand?: string | null;
      aliases?: string[];
      city?: string | null;
      region?: string | null;
      country?: string | null;
      editionCount: number;
    }
    ```
- **Option 3B Fast-Enter & Candidate Resolution Rules:**
  - On single-line capture submission (pressing Enter without selecting an autocomplete dropdown item):
    - Run pure normalized matcher against verified series editions.
    - If **exactly 1 verified series edition** matches unambiguously (title/series match, date falls within edition dates or one of its `weekends`, and venue/city matches or is empty in input): **Auto-link** immediately (`logged_events.edition_id = edition.id`, optional `weekend_number` set if matched).
    - If **2 or more editions** match (e.g. multi-weekend W1 vs W2, or multi-city editions with identical series names): do NOT auto-link. Surface candidates as 1-tap canonical offers under the capture bar. Provide explicit fallback: `"None of these — search web / keep mine"`.
    - If 0 matches: proceed with standard stage 1 capture / web search discovery without linking.
- **Egress-Optimized RPCs & Store Methods:**
  - `getEditionHeaders(filter?: { seriesSlug?: string; year?: number; status?: string }): Promise<EditionHeader[]>`: Returns lean headers without pulling full act lists, set times, or quotes.
  - `listEditionHeaders(query: { seriesSlug?: string; date?: string; venue?: string; city?: string }): Promise<EditionHeader[]>`: Replaces full-table scans in `src/server/events/match.ts` and `src/server/events/dedupeProvisional.ts`.
  - RPC `edition_lineup_facts(p_edition_id uuid)`: Database function returning unified JSON `{ edition: EditionHeader, acts: PerformanceFact[] }` in one single query/subrequest, preventing N+1 egress during event inspection.
  - Client queries to `/api/editions/suggest` and Global Archive search must debounce user typing by at least 300ms.
