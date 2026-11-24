# AI reader: two providers, call log and spend guards

> **Archived 2026-11-23.** Built as Slices 10.1 to 10.20. The app reads pages with the paid Gemini key; the two-way test with Workers AI is finished.

Status: spec, scope confirmed by Charlie (2026-11-12), revised after his audit (2026-11-12). Slices 10.1 to 10.20 in `.spec/PROGRESS.md`. Research: `/mnt/project-files/ai-provider/Gemini free tier replacement options.md`.

## Why

The Gemini free tier refused reads after 6 calls on 2026-11-02. Volume is small: about 200 reads a month, peak 50 a day, typical page 2,000 tokens, largest 43,000. Two providers are compared: paid Gemini (model pinned by name) and Cloudflare Workers AI. One is live at a time. Charlie picks the winner from a local benchmark script. There is no automatic fallback (AGENTS.md).

Nothing here changes the verbatim rule (`isVerbatim`), the billing-role rule, the two-stage capture rule, or "never answer from memory". The model is still a reader of text the app fetched.

## Files and modules

New folder `src/server/reader/`. The existing `src/server/lineup/gemini.ts` stays the only Gemini SDK user inside `src/`.

| File | Job |
|---|---|
| `types.ts` | `ReaderClient`, `ReaderUsage`, `ReaderResult`, `GuardedReader`, error classes |
| `schemas.ts` | Plain JSON Schemas for the performer list and the event details (Workers AI) |
| `geminiAdapter.ts` | `createGeminiReader(client, thinkingLevel)`: wraps the existing Gemini client |
| `workersAiAdapter.ts` | `createWorkersAiReader(ai, model, thinkingLevel)`: the `ai` binding |
| `config.ts` | `readReaderConfig(env)`: every env var below, with defaults |
| `pricing.ts` | `PRICES`, `FALLBACK_PRICES` (USD per million tokens, with a `checkedOn` date) and `estimateCostUsd(provider, model, usage)` |
| `guard.ts` | `checkGuards(...)` and `recordOutcome(...)`: caps and breaker |
| `callLog.ts` | `logCall(store, row)`: one insert, failure counted not thrown |
| `guardedReader.ts` | `createGuardedReader(...)`, the only object the pipeline and routes call |
| `recall.ts` | Pure recall scoring and report building, used only by the CLI script |
| `scripts/recall-test.ts` | Local Node CLI benchmark (outside `src/`, never deployed) |

## Reader interface

```ts
export interface ReaderUsage {
  provider: 'gemini' | 'workers-ai';
  model: string;
  inputTokens: number | null;   // null when the provider did not report it
  outputTokens: number | null;  // includes thinking tokens
  durationMs: number;
}
export type ReaderResult<T> =
  | { ok: true; value: T; usage: ReaderUsage }
  | { ok: false; reason: 'invalid_json' | 'input_too_large'; usage: ReaderUsage };  // a failed read

export interface ReaderClient {
  readonly provider: 'gemini' | 'workers-ai';
  readonly model: string;
  extractPerformers(args: { text: string; input: LookupInput; examples: ExtractionExample[]; maxOutputTokens: number }): Promise<ReaderResult<ExtractedName[]>>;
  extractEventDetails(args: { text: string; eventName: string; year?: number; maxOutputTokens: number }): Promise<ReaderResult<ExtractedDetails>>;
}
```

Errors thrown (not returned): `QuotaExhaustedError` (existing, parks the job; gains `scope: 'global' | 'job'`, default `global`), `ReaderBusyError` (new, Workers AI 3040), any other `Error` (the job's normal attempts path).

Prompts do not change. `gemini.ts` exports `SYSTEM` and `DETAILS_SYSTEM`; both adapters use them, so `EXTRACTION_PROMPT_VERSION` stays `extract@5`. The extractor string stays `${provider}:${model}`.

### Reasoning and model settings (both providers)

Reasoning tokens bill as output and can use up `maxOutputTokens` before any JSON appears. Old sampling parameters return HTTP 400 on newer endpoints. So:
- `READER_THINKING_LEVEL`: `LOW` (default), `MINIMAL`, `MEDIUM`, `HIGH` or `OFF`.
- Default `GEMINI_EXTRACTION_MODEL` is `gemini-3.5-flash-lite`. The code must work unchanged when the env var is swapped to `gemini-4-hydrogen` or any later model string. No model list in code.

### Gemini adapter
- Wraps `createGeminiClient`. `gemini.ts` gains an internal path that returns `usageMetadata`. Output tokens are `candidatesTokenCount + thoughtsTokenCount`.
- Thinking config: a model starting with `gemini-2.5` gets `thinkingConfig { thinkingBudget: 0 }`. Every other model (3.x, 4.x, Gemma 4) gets `thinkingConfig { thinkingLevel }` from `READER_THINKING_LEVEL`, with `OFF` treated as `LOW`. Never send `thinkingBudget` to Gemini 3 or later. Never default to `MINIMAL`.
- Remove `temperature`, `topP`, `topK`, `frequencyPenalty` and `presencePenalty` from the `generateContent` config.
- Few-shot examples go inside the prompt text. `contents` never ends with a `model` turn (400 prefill error on 3.5 and later).
- Passes `maxOutputTokens`. A response that stops with `MAX_TOKENS` is `invalid_json` (truncated).
- A `SyntaxError` or a wrong shape returns `{ ok: false, reason: 'invalid_json' }`. Today it silently returns `[]`; the new result is logged and the job log says the page could not be read. No second call to repair it.
- An empty prepaid balance is HTTP 402 or HTTP 429 with "Your prepayment credits are depleted". Detect with `status === 402 || /prepayment credits are depleted|billing.*depleted/i.test(err.message)` and throw `QuotaExhaustedError(now + 6h, 'Gemini prepay balance is empty; add credit in Google AI Studio.')`. Other 429s keep `parseRateLimitError`.
- `discoverLineupUrls` stays Gemini-only and off (`GEMINI_SEARCH_DISCOVERY=off`). It is not on `ReaderClient`; it is called through `GuardedReader.discoverLineupUrls` so it still passes the guards and is logged as feature `discovery`.

### Workers AI adapter
- Uses `env.AI.run(model, body)`. Default model `@cf/zai-org/glm-4.7-flash` (131,072-token window). Alternative `@cf/google/gemma-4-26b-a4b-it` (256,000). Env `WORKERS_AI_MODEL`. Both are reasoning models.
- Body carries `reasoning_effort` (`READER_THINKING_LEVEL` lowercased; `LOW`, `MINIMAL` and `OFF` all send `'low'`) and, for `LOW`, `MINIMAL` or `OFF`, `chat_template_kwargs: { enable_thinking: false }`.
- Sets `max_tokens` explicitly from the guard's `maxOutputTokens` (several models default to 256).
- Requests JSON with `response_format: { type: 'json_schema', json_schema: <schemas.ts> }`.
- Reads the reply from either envelope: `typeof res.response === 'string' ? res.response : res.choices?.[0]?.message?.content ?? ''`. Truncation is `res.finish_reason === 'length' || res.choices?.[0]?.finish_reason === 'length'`, and is `invalid_json`.
- Validates the shape in code: an object with a `performers` array whose items have string `name` and `quote` (details: only the five known string fields). Anything else is `invalid_json`. No repair, no second call.
- Errors: inner code 3036 (daily allowance used) becomes `QuotaExhaustedError` retrying at the next UTC midnight (add a `nextUtcMidnight` helper). Inner code 3040 (busy) throws `ReaderBusyError`; the pipeline uses the job's normal attempts path. No retry inside the request. Read the inner code from the message or body, not the HTTP status (both are 429).
- Usage from `usage.prompt_tokens` and `completion_tokens` when present, else null.

### Choosing the provider and the model
`READER_PROVIDER=gemini|workers-ai`, default `gemini`. Any other value, or `workers-ai` with no `AI` binding, means no reader (the pipeline logs "reader not configured"). No fallback: if the chosen provider is down or out of quota, the job parks.

Zero-deploy swaps: Charlie changes `READER_PROVIDER`, `GEMINI_EXTRACTION_MODEL`, `WORKERS_AI_MODEL` or `READER_THINKING_LEVEL` in the Cloudflare dashboard (Settings, Variables) with no code change or redeploy. Code reads them on each request. The code default for `GEMINI_EXTRACTION_MODEL` stays `gemini-3.5-flash-lite`. Charlie wants `gemini-4-hydrogen` live ("brand new, capable, cheap, and fast"). The id and its price are unverified here, so slice 10.17 sets it only after the implementer lists the live models for the billed key and confirms the exact id, and records the real price in `PRICES` from the official pricing page.

## Spend guards

All guards run inside `GuardedReader` before the provider call, in this order. Each refusal writes one `ai_calls` row (`outcome = blocked_by_guard`, a `guard_reason`). Guards 1, 2, 3, 7, 8 and 9 throw `QuotaExhaustedError` (scope `global`) with a `retryAt`, so the job parks and stops. Guards 5 and 6 are narrower (see the table).

All counters live in `quota_ledger` (key text, `used` int, `exhausted_until`). No guard reads `ai_calls`, so a missing log table can never block or unblock calls. The guards fail closed: if a ledger read or write throws, the call is refused with reason `guard_unavailable`.

Numbers follow Charlie's audit. Number 4 is unused: the unknown-price guard was removed (see `pricing.ts`).

| # | Guard | Env var (default) | Reason code | Ledger key | On refusal |
|---|---|---|---|---|---|
| 1 | Kill switch | `READER_ENABLED` (`on`; any other value blocks) | `kill_switch` | none | park, global |
| 2 | Circuit breaker open | `READER_BREAKER_FAILURES` (5), `READER_BREAKER_COOLDOWN_MIN` (30) | `breaker_open` | `reader:breaker` | park, global |
| 3 | Unpinned model (only when `READER_PROVIDER` is set explicitly; refuses `-latest` aliases; any other model string is allowed) | none | `unpinned_model` | none | park, global |
| 5 | Input size | `READER_MAX_INPUT_CHARS` (30000) | `input_too_large` | none | returns `{ ok: false, reason: 'input_too_large', usage: zeroUsage }`: no throw, breaker untouched. The pipeline logs the skip in `ai_calls`, drops only that page and moves to the next candidate |
| 6 | Calls per job | `READER_MAX_CALLS_PER_JOB` (6) | `job_cap` | `reader:job:<jobId>` | `QuotaExhaustedError` with `scope: 'job'`: parks only that job, breaker untouched |
| 7 | Spend per day (Pacific day) | `READER_MAX_SPEND_DAY_USD` (0.50) | `spend_day` | `reader:spend:day:<YYYY-MM-DD>` | park, global, opens breaker |
| 8 | Spend per month (UTC month) | `READER_MAX_SPEND_MONTH_USD` (5) | `spend_month` | `reader:spend:month:<YYYY-MM>` | park, global, opens breaker |
| 9 | Calls per minute and per day, per provider | existing `GEMINI_PER_MINUTE`, `GEMINI_DAILY_LIMIT` (and member caps); `WORKERS_AI_DAILY_LIMIT` (50), `WORKERS_AI_PER_MINUTE` (10) | `calls_cap` | existing `provider:model:day` via `QuotaLedger.acquire` | park, global, opens breaker |

Notes:
- Spend counters hold micro-dollars in `used` (an int, good to $2,100). One token at a price of P dollars per million costs P micro-dollars, so `micro = tokens x price`.
- Pre-call (`checkGuards`): read `used` for the day and month keys. `worstCaseMicroUsd` is `ceil(inputChars / 3)` input tokens plus `maxOutputTokens` output tokens at the price. Refuse if `used + worstCaseMicroUsd > capMicroUsd`. This check is in memory only. Nothing is written to `quota_ledger` before the call.
- Post-call (`recordOutcome`): write once, adding `realCostMicroUsd` to `used`. Use `worstCaseMicroUsd` only when the call succeeded with null usage metadata. A failed call with no usage adds 0.
- Race: the queue runs one consumer (`max_concurrency: 1`), so the in-memory pre-check is race-free for queue jobs. Non-queue callers (the details button, discovery) can race: two requests may read the same `used`. The error is at most one call. This is accepted and noted.
- Workers AI on the Free plan has no money cost. Its estimate (`FALLBACK_PRICES`) still counts toward the day and month caps, as a safe over-estimate, and is shown for comparison.
- Guard 5 input is the text actually sent (after `lineupWindow`). Over-size is refused and logged, never silently cut: the pipeline sends the whole page and guard 5 skips any page over `READER_MAX_INPUT_CHARS` (default 30,000, Slice 11.5). `READER_WINDOW_CHARS` also defaults to 30,000, so the adapter's window never shortens an accepted page. There is no chunk loop.
- Guard 9 is last so call counters only advance for calls that will be made. `force` only bypasses the pause an earlier 429 set. `force` never bypasses guards 1 to 8.
- Output cap: `READER_MAX_OUTPUT_TOKENS` (8192) for performer lists, `READER_MAX_OUTPUT_TOKENS_DETAILS` (1024) for details.
- Circuit breaker: `reader:breaker` keeps the consecutive failure count in `used` and the open-until time in `exhausted_until`. A failure is outcome `error`, `invalid_json` or `busy`. A success resets the count. The breaker opens ONLY on: `READER_BREAKER_FAILURES` consecutive provider failures; a provider 402 or 429 quota error; a global day or month cap breach (guards 7, 8, 9). It never opens on guard 5 (one oversized page) or guard 6 (one job over its cap), so one big page cannot stop every other job. While open, every call is refused with `breaker_open` and `retryAt` is the open-until time, so parked jobs do not wake early. Every Worker instance reads it from the database.
- Pricing: `PRICES` holds known models. `FALLBACK_PRICES = { gemini: { inPerMillion: 1.50, outPerMillion: 7.50 }, 'workers-ai': { inPerMillion: 0.10, outPerMillion: 0.40 } }` (sized to Gemini 4 Hydrogen standard rates, per Charlie, so an unlisted Gemini model never underestimates). `estimateCostUsd` uses the fallback for unlisted models, so a swapped model is never blocked for lack of a price.
- Worst case per call at the defaults, Gemini fallback price: a 200,000-character input is 66,667 tokens, $0.100, plus 8,192 output tokens, $0.061, so $0.161. A typical 8,000-character page is $0.065 worst case, about $0.007 real. A 43,000-token page is about $0.07 real. The $0.50 a day default still allows normal use (50 typical reads is about $0.35 real; the pre-check starts refusing near $0.43 used). It allows only about 6 to 7 largest pages a day. Charlie to confirm or raise it.

### How this stops the runaway scenario

The pipeline, the details route and the discovery search have no import of the Gemini or Workers AI client. They hold only a `GuardedReader`. A test (`tests/readerGuarded.test.ts`) greps `src/` and fails if any file outside `src/server/reader/` and `src/server/lineup/gemini.ts` imports `@google/genai` or calls `.run(` on the AI binding. So no loop in the app can reach a model without passing the guards. The CLI script is outside `src/` and never runs in the Worker.

Loops that exist today and how each is bounded:
1. `runJob` while loop in `pipeline.ts`: each `stageExtract` pass handles `pendingExtraction[0]` and drops it only after the read. The list has no cap. Bound: guard 6, keyed in the database.
2. The catch block in `runJob` re-queues a failing job with `attempts + 1` (`MAX_ATTEMPTS = 3`) and does not drop the page. Bound: at most 3 reads of a page, and guard 6. `invalid_json` and `input_too_large` are not errors: the page is dropped, logged, not retried.
3. Queue re-sends in `worker/index.ts` (cron `sendBatch`, `send` after a step, `message.retry` up to 3, stale `running` jobs via `isStaleRun`): duplicates are dropped because `runJob` only starts `queued` or `waiting_quota` jobs, but a stale re-run or a retry after a failed `updateJob` can repeat a read. Bound: the per-job counter and the day and month caps live in the database, not in the message. The implementer must re-read `worker/index.ts` lines 150 to 260 and list any uncovered path in the PR.
4. `stageDiscover`: runs once (`discoveryDone`), off by default, through the guard anyway.
5. `geminiReader` in `detailsGemini.ts`: at most `MAX_GEMINI_PAGES` (3) calls per press. A press is not a job, so guard 6 uses the key `reader:job:details:<eventId>:<YYYY-MM-DD>` with the same cap.

## AI call log

Migration `supabase/migrations/0038_ai_calls.sql`. Written only by threads; Charlie applies it. The guards do not depend on it.

```sql
create table if not exists ai_calls (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  feature text not null check (feature in ('lineup_extract','details_extract','discovery')),
  job_id uuid null,                 -- lookup_jobs.id; no foreign key, so a deleted job keeps its log
  event_id uuid null,               -- logged_events.id; no foreign key
  user_id uuid null,
  provider text not null,
  model text not null,
  source_document_id uuid null,
  input_chars int null,
  input_tokens int null,
  output_tokens int null,
  est_cost_usd numeric(10,6) null,
  duration_ms int null,
  outcome text not null check (outcome in ('ok','invalid_json','quota','busy','blocked_by_guard','error')),
  error_code text null,
  guard_reason text null,
  names_returned int null,
  names_verbatim int null,
  names_rejected int null
);
create index if not exists ai_calls_created_idx on ai_calls (created_at desc);
alter table ai_calls enable row level security;
create policy "owner_read" on ai_calls for select to authenticated using (auth.uid() = owner_user_id());
```

RLS follows 0026 (owner reads, no one signed in writes, the service role writes). Include the 0026 style check query and a rollback comment (`drop table ai_calls`).

Rules:
- Never store page text, prompts, quotes or names. Counts and sizes only.
- One insert per call (the Workers Free plan allows 50 subrequests per request). Blocked and skipped calls are one insert too. Never one insert per name.
- Store methods on `LineupStore` (both stores): `addAiCall(row: AiCallRow): Promise<void>`, `listAiCalls(limit: number): Promise<AiCallRow[]>` newest first, `deleteAiCallsBefore(cutoff: Date): Promise<number>`.
- `logCall` wraps `addAiCall` in try/catch. A failure never fails the read. It adds 1 to the ledger key `reader:logfail:<YYYY-MM-DD>` (best effort, also swallowed) and `console.warn`s. The owner view shows that count.
- `est_cost_usd` is computed in code with `estimateCostUsd`. A null token count gives a null cost in the log, and the worst-case estimate in the spend counter.
- Retention: keep 180 days. `deleteAiCallsBefore` exists and is tested; calling it from the cron is a follow-up note in `docs/architecture/10-quota-and-the-queue.md`.
- `names_returned` is the model's list length; `names_verbatim` how many passed `isVerbatim`; `names_rejected` the difference. The call site passes `ctx.afterRead(value) => { returned, verbatim }`, because the verbatim check stays in the pipeline.

## GuardedReader

```ts
interface CallContext { feature: 'lineup_extract'|'details_extract'|'discovery'; jobKey: string; jobId?: string; eventId?: string; userId?: string; documentId?: string; force?: boolean; afterRead?: (value) => { returned: number; verbatim: number } }
interface GuardedReader {
  readonly provider: string; readonly model: string;      // for the extractor string
  extractPerformers(args, ctx): Promise<ReaderResult<ExtractedName[]>>;
  extractEventDetails(args, ctx): Promise<ReaderResult<ExtractedDetails>>;
  discoverLineupUrls(input, ctx): Promise<string[]>;       // Gemini only
}
```

The log row is written after the verbatim check, so `afterRead` runs before it. Do not add a second write. `createGuardedReader({ client, store, quota, config, now })` is exported; `guardedFromGemini(geminiClient, store, quota, now)` builds one for tests.

## Recall benchmark (local CLI, not in the app)

A one-off comparison does not get permanent routes, columns or a React runner. `scripts/recall-test.ts` is run by hand: `npx tsx scripts/recall-test.ts`.
- Input: confirmed editions and their stored source documents, from a local fixture JSON or from Supabase with the service key (read only; the key stays in the local shell and is never committed). Default pick: up to 8 confirmed editions that have a document with a lineup, newest first, always including the largest document, at most one per edition.
- Models: `gemini-3.5-flash-lite`, `gemini-4-hydrogen`, `@cf/zai-org/glm-4.7-flash`, `@cf/google/gemma-4-26b-a4b-it`, each with `LOW` reasoning forced. Gemini through the Gemini SDK; Workers AI through the Cloudflare REST API (`https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai/run/$MODEL`). Prompts are `SYSTEM` and `DETAILS_SYSTEM` from `gemini.ts`.
- Scoring (`src/server/reader/recall.ts`, pure, tested): normalize names with `normalizeName` plus the alias table; `matched` is confirmed names found among returned names that also pass `isVerbatim`; `recall = matched / expected`. Extra verbatim names are listed as `extras` for Charlie to judge.
- Output to the terminal, JSON and a Markdown table: per model, recall %, minimum page recall, JSON validity %, input, output and thinking tokens, estimated USD cost, latency. Per page detail too. It never writes to lineups or the database.
- Pass mark: 90% overall (sum matched over sum expected), no page under 70%, at most 1 page in 10 with invalid JSON. Charlie confirms.
- Cost guard inside the script: `--max-calls` and `--max-usd` per run; when reached it aborts and prints why. On a quota or 402 error it stops that model, reports it and does not try another model for the same page.
- The 43,000-token page is about 170,000 characters. Under the 30,000-character ceiling (Slice 11.5) it is skipped with a note, not cut. The report states the window used.
- The CLI never switches the live provider. Charlie flips the dashboard variables himself.

## Owner view

- `GET /api/status` keeps `gemini` and `quota` unchanged and adds `reader: { provider, model, thinkingLevel, enabled, breaker: { open: boolean; until?: string; failures: number }, callsToday, callsMonth, spendTodayUsd, spendMonthUsd, caps: { dayUsd, monthUsd, perJob, inputChars, outputTokens }, logWriteFailuresToday, recent?: AiCallRow-like[] }`. `recent` (last 20 calls: when, feature, provider, outcome, guard reason or error code, tokens, cost) is returned only to the owner (`isOwner`). Members get the summary without `recent` and without spend. The month calls counter is ledger key `reader:calls:month:<YYYY-MM>`.
- `AboutDialog.tsx` keeps "Gemini n/limit today" until the switch. It gains one owner line: provider, pinned model, thinking level, calls today, spend today and month, "paused until <time>" when the breaker is open. `src/components/ReaderPanel.tsx` (owner only, in Manage) shows the same plus the last 20 `ai_calls` rows (shared `Pill` for outcomes). It is observability only: no test runner. Sample mode shows nothing.
- Renaming `gemini` in the status is left for the slice after Charlie's switch.

## Docs changes

Done in slices 10.18 to 10.20 (AGENTS.md: update docs when behavior changes).
- `AGENTS.md`: bullets "Gemini may only extract from text the app fetched" and "Stage 1 research ... Gemini runs in stage 1 only when you press ..." become "the reader model" wording. "On a quota error, park the job and stop. Do not retry with another model" stays word for word, with "(any provider)" added. Add one bullet: "Every model call in the app goes through the guarded reader (`src/server/reader/`): guards first, one `ai_calls` row after, no page text in it, no automatic switch between providers." Keep "Never call it from saving, plain 'Look again' or Fill gaps."
- `REQUIREMENTS.md`: principle 8, R2.4, R2.6, the Cost line and the sources table rows say "Gemini"; make them provider-neutral, keep "Look again with Gemini" as the button name until the switch. Add R2.7: spend guards and the call log, caps as owner-set defaults. Cost line: free tiers or a prepaid balance of $5, never auto top-up.
- `ARCHITECTURE.md` and `docs/architecture/`: `09-lookup-pipeline.md`, `10-quota-and-the-queue.md` (guards, breaker scope, ledger keys, bounded loops, retention note), `11-learning-loops.md`, `13-api.md` (status `reader`; no recall routes), `08-sources.md`, `02-stage-1-capture-and-details.md`, `22-testing.md`. `.env.example` lists the new variables.

## Provider-side caps Charlie sets by hand (the outer wall)

1. Google, prepaid with auto top-up off. Step 1: go to https://aistudio.google.com -> Step 2: open Settings, then Billing -> Step 3: click Set up billing, link a billing account -> Step 4: choose Prepay, add $5 -> Step 5: confirm Automatic top-up is Off. Expected: the balance shows $5 and the key returns 402 or 429 "prepayment credits are depleted" at zero.
2. Same page: write down the paid per-minute and per-day limits for the pinned model. Put them in `GEMINI_DAILY_LIMIT` and `GEMINI_PER_MINUTE` only if lower than the defaults.
3. Cloudflare: Workers Free has no overage billing; the 10,000 neurons a day allowance ends in error 3036 and resets at 00:00 UTC. Step 1: go to https://dash.cloudflare.com -> Step 2: Workers & Pages, then Plans -> Step 3: check the plan says Free.
4. Rotate the Gemini key if it was ever on the free project: AI Studio, API keys, create a key on the billed project, then Workers, Settings, Variables and Secrets, edit `GEMINI_API_KEY`.

## Test plan by slice

Node test runner files in `tests/`, on the file store, with faked clients (see `tests/pipeline.test.ts` and `tests/detailsGemini.test.ts` `fakeGemini`). No test makes a network call.
- 10.1: usage mapping (candidates + thoughts); `MAX_TOKENS` and bad JSON give `invalid_json`; 402 and the "prepayment credits are depleted" 429 give `QuotaExhaustedError` (+6h); thinkingConfig by model (2.5 budget 0, others level, `OFF` as `LOW`, never `thinkingBudget` on 3+); no sampling params; `contents` never ends with a `model` turn.
- 10.2/10.3: round trip of `addAiCall` / `listAiCalls` / `deleteAiCallsBefore`; the migration SQL has RLS, the check constraints, and none of the removed recall columns.
- 10.4: defaults for every env var; `estimateCostUsd` uses `FALLBACK_PRICES` for an unlisted model.
- 10.5: each guard refuses with its reason; guard 5 returns `input_too_large` without throwing and leaves the breaker closed; guard 6 throws `scope: 'job'` and leaves the breaker closed; pre-call check writes nothing; post-call writes once; breaker opens at N failures, on 402/429 and on guards 7 to 9 only; `-latest` refused only when the provider is explicit; ledger failure fails closed; `force` does not bypass guards 1 to 8.
- 10.6: blocked call writes one row and makes no provider call; log failure does not fail the read; the source-scan test.
- 10.7/10.8: default `gemini`; per-job cap stops a 10-page job at 6 calls and parks only that job; an oversized page is skipped and the next page is read; `invalid_json` drops the page without retry; breaker open parks with `retryAt`; attempts bound; extraction cache still avoids calls.
- 10.9: learning loop accepts `workers-ai:` extractors. 10.10: the details press makes at most 3 calls.
- 10.11: status shape; members get no `recent`. 10.12: typecheck only.
- 10.13: scoring (alias match, extras, floor, pass mark). 10.14: the script's cost guard aborts and prints why; nothing is written.
- 10.15: fake binding: `max_tokens`, `response_format`, `reasoning_effort`, `chat_template_kwargs`; both envelopes; truncation; 3036 and 3040. 10.16: provider switch; no binding gives no reader.
- 10.18 to 10.20: `tests/docsLinks.test.ts` still passes.

## Unverified facts the implementer must check live

Do not assume these. Check once, write the result in the PR description, adjust the code if it differs.
1. Whether the two Workers AI models enforce `response_format` JSON schema, or only try. Cloudflare's JSON Mode page says it cannot guarantee the shape; the code validates either way.
2. Whether `env.AI.run` counts toward the 50 subrequests per request on the Free plan.
3. Gemini `usageMetadata` fields (`promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`) and whether thinking tokens bill as output.
4. The Gemini `thinkingConfig` rules (Charlie's instruction): `thinkingBudget: 0` for `gemini-2.5*`; `thinkingLevel` `LOW` for 3.x, 4.x and Gemma 4; `MINIMAL` returns 400 on 3.7, 3.8 and 4; `thinkingBudget` is rejected on 3+; sampling params and a trailing `model` turn return 400.
5. Workers AI `reasoning_effort` and `chat_template_kwargs: { enable_thinking: false }` on `@cf/zai-org/glm-4.7-flash` and `@cf/google/gemma-4-26b-a4b-it`, and both response envelopes.
6. The exact Gemini 4 Hydrogen id (`gemini-4-hydrogen`) from the live model list for the billed key, and its price. `gemini-3.5-flash-lite` as a real id likewise. Prices for `PRICES` come from the official pricing pages with a `checkedOn` date, not from this spec. The `FALLBACK_PRICES` figures are Charlie's sizing and are also unchecked.
7. The empty-balance error shape: HTTP 402, or HTTP 429 with "Your prepayment credits are depleted".
8. Workers AI inner error codes 3036 and 3040 and where they appear in the thrown error.
9. Whether `worker/index.ts` has other paths that repeat a read (runaway item 3).
10. Whether a model var set in `wrangler.jsonc` `vars` is overwritten on the next deploy and blocks dashboard-only swaps. If so, `GEMINI_EXTRACTION_MODEL` and `WORKERS_AI_MODEL` must stay out of `wrangler.jsonc` for zero-deploy swaps (conflicts with setting Hydrogen there; Charlie to decide).
11. How to link a confirmed edition to its source documents for the CLI (through `performer_claims.document_id`, or another path).

## Needed from Charlie

1. Apply migration `supabase/migrations/0038_ai_calls.sql` (after slice 10.3 merges). Supabase dashboard, SQL Editor, paste, Run. Until then the log writes fail safely and are counted.
2. Add $5 prepaid billing in Google AI Studio with auto top-up off (steps above).
3. Confirm the pass mark (90% overall, 70% page floor), or change it.
4. Provide a local fixture JSON or a service key for the CLI, and read its result before slices 10.15 and 10.16 are built.
5. Confirm the default caps ($0.50 a day, $5 a month, 6 calls per job, 30,000 input characters, 30,000 window, 8,192 output tokens, thinking `LOW`, breaker at 5 failures and a 30 minute cool-down). The $0.50 day cap allows only about 6 to 7 of the largest pages a day.
6. Confirm the Gemini model id (`gemini-4-hydrogen`) once the implementer lists the live models, and decide whether the model var lives in `wrangler.jsonc` or only in the dashboard.
7. After the CLI result, decide the live provider and flip `READER_PROVIDER` in the Cloudflare dashboard. Then a follow-up slice renames buttons and the `gemini` status field.
