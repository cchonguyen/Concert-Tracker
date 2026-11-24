# System Specification & Contracts

> Status (2026-11-23): every feature in this file is built. This file keeps the contracts as they were agreed. For how the app works today, read [ARCHITECTURE.md](../ARCHITECTURE.md); migration numbers here are historical.

The full spec already lives in the project docs. This file holds only what `/triage` and the `architect` subagent add for the feature in progress; it must not contradict them.

- Requirements and ranked principles: [REQUIREMENTS.md](../REQUIREMENTS.md)
- Architecture, data model and module boundaries: [ARCHITECTURE.md](../ARCHITECTURE.md)
- Hard rules for every change: [AGENTS.md](../AGENTS.md)

## 1. Core Scope & MVP Boundaries (AI reader: built as Slices 10.1 to 10.20)
Feature: **Two-way reader test: Cloudflare Workers AI and paid Gemini, with an AI call log and spend guards** (triaged 2026-11-12, scope confirmed by Charlie 2026-11-12). Full spec: [docs/archive/ai-reader-spec.md](../docs/archive/ai-reader-spec.md). Research: `/mnt/project-files/ai-provider/Gemini free tier replacement options.md`.

- **Core problem:** the Gemini free tier refuses reads far below its stated limit (6 calls on 2026-11-02), so lineup reading and "Look again with Gemini" fail often. Volume is small: about 200 reads a month, peak 50 a day, typical page 2,000 tokens, largest 43,000.
- **Confirmed scope (Charlie):**
  1. One reader interface with two providers behind it: the existing Gemini client (billed key, model pinned by name) and a new Workers AI client (`ai` binding). One provider is live at a time, chosen by a setting. No automatic fallback between them (AGENTS.md).
  2. An AI call log: every model call records when, why (feature and job), provider, model, tokens in and out, estimated cost, duration, outcome and error code, and extraction quality (names returned, names passing the verbatim check, JSON valid or not).
  3. Spend guards that fail closed: caps per call (input size, max output tokens), per job, per day and per month, in calls and in estimated cost; a circuit breaker that stops all AI calls only after repeated provider failures, a provider quota error or a global day or month cap breach (never for one oversized page or one job over its cap); every refusal is logged with its reason; the job parks and stops as on a quota error today. No retry loops.
  4. A local CLI benchmark (`scripts/recall-test.ts`, no production routes or columns): the models on pages Charlie has confirmed by hand, at least one near 43,000 tokens; pass mark 90% overall and 70% per page; the result is printed to the terminal; the winner goes live only by Charlie's choice, and the Workers AI production slices are built only after he reads it.
  5. A plain owner view of the log and the guard state, and docs updated (AGENTS, REQUIREMENTS, ARCHITECTURE).
- **Facts:** `src/server/lineup/gemini.ts` is the only SDK user. Call sites: pipeline.ts (stage 2), events/detailsGemini.ts (stage 1 button), search.ts geminiSearch (grounded discovery, off). No `ai` binding in wrangler.jsonc. `quota_ledger` key is text `provider:model:window`. Workers AI: 10,000 free neurons a day, error 3036 = allowance used, 3040 = busy (both HTTP 429), several models default `max_tokens` to 256, JSON schema not guaranteed. Gemini paid: HTTP 402 at zero balance. Workers Free: 50 subrequests per request, so the log is one write per call at most.
- **Charlie applies migrations; threads only write them.** Next free number is 0038.

## 2. Strictly Out of Scope ("Do NOT Build" List)
- Automatic fallback from one provider to the other, or any retry with another model.
- A replacement for Gemini's grounded web search (stays off; Brave path unchanged).
- A model picker in the UI, or per-user provider choice.
- Any change to stage 1 capture, saving, the verbatim rule or the no-guessing rules.
- Third providers (Haiku, OpenAI, Groq). Only if both fail the test, and only after Charlie says so.
- Page text or prompts in the call log (sizes and counts only).
- Removing the Gemini code or renaming the buttons before the test result is in.

## Earlier features

The scope and "Do NOT Build" notes for earlier features (Manage section, past-event suggestion, design system export) were removed on 2026-11-24: all three are built. The Manage section design is in `docs/archive/manage-section-design.md`, and the git history keeps the old notes.

## 3. Data Models & Module Boundaries

**AI reader** (full spec: [docs/archive/ai-reader-spec.md](../docs/archive/ai-reader-spec.md); slices 10.1 to 10.20; 10.15 to 10.17 are gated)
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
- Weather (B3, option 2a): after a pre-filled save, `lookupWeather` runs once, server-side, for the saved event, only when it has a city and a start date. It stores the result with its URL only when Open-Meteo places the city exactly; otherwise it stores nothing and returns the usual note. Never re-run automatically. The lookup is per edition (`docs/archive/canonical-weather.md`): a pre-fill copies the edition's record, and a lookup runs only when the edition has none. A failure never fails the save.
- No "I saw everyone" button (Charlie, 2026-11-11): each seen act is its own tap, so people curate who they actually saw. A bulk tick is on the Do NOT Build list.
- No suggestions and no writes in sample mode. No writes to `event_editions` or `performances`.

**Global Archive Series, Multi-Weekend & Egress Optimization Contracts** (2026-11-15; see DECISIONS.md ADR-005, ADR-006)

- **Nullable Series Slug:** `event_editions.series_slug` is nullable (`text null references event_series(slug) on delete set null`). Standalone concerts do not generate stub series entries. `seriesSlug` in TypeScript types (`EventEdition`, `EditionHeader`, `NewEditionInput`) is `string | null | undefined`.
- **Hierarchy Data Models:**
  - `Brand -> Series -> Edition -> Event/Weekend`:
    - `event_series`: `slug` (PK), `name`, `kind` (`'festival' | 'tour'` not null default `'festival'`), `brand` (text null), `aliases` (text[]), `city`, `region`, `country`, `created_at`, `updated_at`.
    - `event_editions`: add `weekends jsonb null default '[]'::jsonb`, `region text null`.
  - `EditionWeekend`:
    ```typescript
    export type SeriesKind = 'festival' | 'tour';

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
      seriesKind?: SeriesKind | null;
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
      kind: SeriesKind;
      brand?: string | null;
      aliases?: string[];
      city?: string | null;
      region?: string | null;
      country?: string | null;
      editionCount: number;
    }
    ```
- **Festival vs. Tour Series Semantics & Place Resolution:**
  - **Festival Series (`kind = 'festival'`):** holds home `city`, `region`, `country` at whatever granularity applies (e.g. `Las Vegas, NV, US` or regional `CA, US` with `city: null`). Missing `city`/`region`/`country` on attached editions resolve on read from the series (`Edition ?? Series`); edition-level values always take precedence when set.
  - **Tour Series (`kind = 'tour'`):** location-agnostic (`city`, `region`, `country` are always `null` and disabled in UI/API). Individual tour stops carry their own `venue`, `city`, `region`, `country`, and dates on `event_editions`.
- **Automatic Type (`Festival` / `Concert`) Inheritance:**
  - `logged_events.kind` strictly stores only explicit user choice (`'concert'`, `'festival'`, or `null` for automatic calculation).
  - `resolveEvent` passes the linked series's `kind` (`festival` -> `'festival'`, `tour` -> `'concert'`) as a read-only `seriesKind` signal into `eventScale()`.
  - Loaded via the existing `event_series` join in `EDITION_HEADER_COLUMNS` / `EDITION_SELECT_WITH_SERIES` (zero extra DB queries).
  - Precedence in `eventScale()`: `User choice (e.kind) > Series kind (e.seriesKind) > Day/Act/Clashfinder rules`.
- **Global Archive Place Autofill:**
  - `ArchiveSeries` (`+ New series`), `SeriesDetail` (`Edit series`, when `kind === 'festival'`), and `EditionFactsForm` (`Edit edition`) share `EventDetail`-style `SuggestInput` (`Brand`, `City` via `/api/places/cities` + existing places) and `/api/places/guess` 1-tap `"Use ... from the map"` (`placePatch`) offers.
  - `SeriesDetail` offers 1-tap `"Use ... from attached editions"` when the series place is empty and attached editions agree.
- **Edition Multi-Weekend Research & Draft Sibling Seed:**
  - `researchEditionFacts` (`details.ts` & `detailsGemini.ts`) extracts and preserves `Weekend 1` & `Weekend 2` date spans from Ticketmaster (non-contiguous runs), web results, and quoted Gemini page extraction (`details@2`), offering 1-tap `"Use Weekend 1 & Weekend 2 dates"` in Check details and `EditionFactsForm`.
  - In `EditionFactsForm`, toggling `Multiple weekends` detects whether existing dates belong to W1 or W2, places them into the matching slot, and pre-fills the sibling weekend at `±7 days` as a clearly marked draft (`"Draft (-7d) — confirm"` or `+7d`), requiring an owner `Source note` before saving; never auto-saved or used during background ingest.
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
