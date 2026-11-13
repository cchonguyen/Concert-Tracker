# AI reader: two-way test, call log and spend guards

Status: spec, scope confirmed by Charlie (2026-11-12). Slices 10.1 to 10.19 in `.spec/PROGRESS.md`. Research: `/mnt/project-files/ai-provider/Gemini free tier replacement options.md`.

## Why

The Gemini free tier refused reads after 6 calls on 2026-11-02. Volume is small: about 200 reads a month, peak 50 a day, typical page 2,000 tokens, largest 43,000. Two providers are tested: paid Gemini (model pinned by name) and Cloudflare Workers AI. One is live at a time. Charlie picks the winner from the recall test. There is no automatic fallback (AGENTS.md).

Nothing in this spec changes the verbatim rule (`isVerbatim`), the billing-role rule, the two-stage capture rule, or "never answer from memory". The model is still a reader of text the app fetched.

## Files and modules

New folder `src/server/reader/`. The existing `src/server/lineup/gemini.ts` stays the only Gemini SDK user.

| File | Job |
|---|---|
| `types.ts` | `ReaderClient`, `ReaderUsage`, `ReaderResult`, `GuardedReader`, error classes |
| `schemas.ts` | Plain JSON Schemas for the performer list and the event details (Workers AI) |
| `geminiAdapter.ts` | `createGeminiReader(client)`: wraps the existing Gemini client |
| `workersAiAdapter.ts` | `createWorkersAiReader(ai, model)`: the `ai` binding |
| `config.ts` | `readReaderConfig(env)`: every env var below, with defaults |
| `pricing.ts` | `PRICES` table (USD per million tokens, per provider and model, with a `checkedOn` date) and `estimateCostUsd(provider, model, usage)` |
| `guard.ts` | `checkGuards(...)` and `recordOutcome(...)`: caps and breaker |
| `callLog.ts` | `logCall(store, row)`: one insert, failure counted not thrown |
| `guardedReader.ts` | `createGuardedReader(...)`, the only object the pipeline and routes call |
| `recall.ts` | Recall test scoring and report |

## Reader interface

```ts
export interface ReaderUsage {
  provider: 'gemini' | 'workers-ai';
  model: string;
  inputTokens: number | null;   // null when the provider did not report it
  outputTokens: number | null;  // for Gemini includes thinking tokens
  durationMs: number;
}
export type ReaderResult<T> =
  | { ok: true; value: T; usage: ReaderUsage }
  | { ok: false; reason: 'invalid_json'; usage: ReaderUsage };   // a failed read

export interface ReaderClient {
  readonly provider: 'gemini' | 'workers-ai';
  readonly model: string;
  extractPerformers(args: { text: string; input: LookupInput; examples: ExtractionExample[]; maxOutputTokens: number }): Promise<ReaderResult<ExtractedName[]>>;
  extractEventDetails(args: { text: string; eventName: string; year?: number; maxOutputTokens: number }): Promise<ReaderResult<ExtractedDetails>>;
}
```

Errors thrown (not returned): `QuotaExhaustedError` (existing, parks the job), `ReaderBusyError` (new, Workers AI 3040), any other `Error` (the job's normal attempts path).

Prompts do not change. `gemini.ts` exports `SYSTEM` and `DETAILS_SYSTEM`; both adapters use them, so `EXTRACTION_PROMPT_VERSION` stays `extract@5`. The extractor string stays `${provider}:${model}` (for example `gemini:gemini-3.5-flash-lite`, `workers-ai:@cf/zai-org/glm-4.7-flash`).

### Gemini adapter
- Wraps `createGeminiClient`. `gemini.ts` gains an internal path that returns the response's `usageMetadata`. Output tokens are `candidatesTokenCount + thoughtsTokenCount` (thinking tokens bill as output; verify live, see "Unverified facts").
- Passes `maxOutputTokens` in the request config. A response that stops with `MAX_TOKENS` is `invalid_json` (truncated).
- A `SyntaxError` or a wrong shape returns `{ ok: false, reason: 'invalid_json' }`. Today it silently returns `[]`; the new result is logged and the job log says the page could not be read. There is no second call to repair it.
- HTTP 402 (zero balance) becomes `QuotaExhaustedError(now + 6h, 'Gemini balance is empty; add credit in Google AI Studio.')`. 429 handling stays `parseRateLimitError`.
- Model is pinned by name in `GEMINI_EXTRACTION_MODEL`. When `READER_PROVIDER` is set explicitly, a model name ending in `-latest` is refused by the guard (reason `unpinned_model`). When `READER_PROVIDER` is unset, the old default applies unchanged.
- `discoverLineupUrls` stays Gemini-only and off (`GEMINI_SEARCH_DISCOVERY=off`). It is not on `ReaderClient`. It is called through `GuardedReader.discoverLineupUrls` so it still passes the guard and is logged as feature `discovery`.

### Workers AI adapter
- Uses `env.AI.run(model, body)`. Default model `@cf/zai-org/glm-4.7-flash` (131,072-token window). Alternative `@cf/google/gemma-4-26b-a4b-it` (256,000). Env `WORKERS_AI_MODEL`.
- Sets `max_tokens` explicitly from the guard's `maxOutputTokens` (several models default to 256, which would cut the JSON off).
- Requests JSON with `response_format: { type: 'json_schema', json_schema: <schemas.ts> }`.
- Parses and validates the shape in code: an object with a `performers` array whose items have string `name` and `quote` (details: only the five known string fields). Anything else is `invalid_json`. No repair of any kind, and no second model call.
- A response whose `finish_reason` is `length` is `invalid_json`.
- Errors: inner code 3036 (daily allowance used) becomes `QuotaExhaustedError` retrying at the next UTC midnight (Workers AI resets at 00:00 UTC; add a `nextUtcMidnight` helper). Inner code 3040 (busy) throws `ReaderBusyError`; the pipeline treats it as the job's normal error path (attempts + later re-attempt with its own back-off). There is no retry inside the request. Read the inner code from the error message or body, not the HTTP status (both are 429).
- Usage from `response.usage.prompt_tokens` and `completion_tokens` when present, else null.

### Choosing the provider
`READER_PROVIDER=gemini|workers-ai`, default `gemini`. Any other value, or `workers-ai` with no `AI` binding, means no reader (the pipeline logs "reader not configured" as today's "Gemini is not configured"). No fallback: if the chosen provider is down or out of quota, the job parks. Charlie flips the variable by hand in the Cloudflare dashboard (Settings, Variables).

## Spend guards

All guards run inside `GuardedReader` before the provider call, in this order. Each failure refuses the call, writes one `ai_calls` row with `outcome = blocked_by_guard` and a `guard_reason`, and throws `QuotaExhaustedError` (scope `global`) with a `retryAt`, so the job parks and stops.

All counters live in `quota_ledger` (key text, `used` int, `exhausted_until`). No guard reads `ai_calls`, so a missing or broken log table can never block or unblock calls. The guards fail closed: if a ledger read or write throws, the call is refused with reason `guard_unavailable`.

| Order | Guard | Env var (default) | Reason code | Ledger key |
|---|---|---|---|---|
| 1 | Kill switch | `READER_ENABLED` (`on`; any other value blocks all calls) | `kill_switch` | none |
| 2 | Circuit breaker open | `READER_BREAKER_FAILURES` (5), `READER_BREAKER_COOLDOWN_MIN` (30) | `breaker_open` | `reader:breaker` |
| 3 | Unpinned model (only when `READER_PROVIDER` is set) | none | `unpinned_model` | none |
| 4 | Unknown price (model not in `PRICES`) | none | `unknown_price` | none |
| 5 | Input size | `READER_MAX_INPUT_CHARS` (60000) | `input_too_large` | none |
| 6 | Calls per job | `READER_MAX_CALLS_PER_JOB` (6) | `job_cap` | `reader:job:<jobId>` |
| 7 | Spend per day (Pacific day, like the quota) | `READER_MAX_SPEND_DAY_USD` (0.50) | `spend_day` | `reader:spend:day:<YYYY-MM-DD>` |
| 8 | Spend per month (UTC month) | `READER_MAX_SPEND_MONTH_USD` (5) | `spend_month` | `reader:spend:month:<YYYY-MM>` |
| 9 | Calls per minute and per day, per provider | existing `GEMINI_PER_MINUTE`, `GEMINI_DAILY_LIMIT` (and the member caps); `WORKERS_AI_DAILY_LIMIT` (50), `WORKERS_AI_PER_MINUTE` (10) | `calls_cap` | existing `provider:model:day` via `QuotaLedger.acquire` |

Notes:
- Spend counters hold micro-dollars in `used` (an int, good to $2,100). Before a call the guard adds a worst-case estimate: `ceil(inputChars / 3)` input tokens plus `maxOutputTokens` output tokens at the table price. If `spent + worstCase` is over the cap, refuse. After the call, add the real estimate from the usage record (worst case if usage is null). Zero-price providers add 0 dollars but still pass guard 9 and are logged.
- Guard 5: input is the text actually sent (after `lineupWindow`). Over-size is refused and logged, never silently cut. The existing `lineupWindow(text, MAX_DOC_CHARS)` (40,000 characters, declared, centred on the lineup) is the only windowing and is unchanged by default. It becomes `READER_WINDOW_CHARS` (default 40000) so the recall test can try a larger one. There is no chunk loop in v1. A page over the window is read as that one window and the job log already says so; the recall test shows what this costs in recall.
- Guard 9 is placed last so the call counters only advance for calls that will be made. It is the existing `QuotaLedger.acquire`, one ledger per provider (`provider:model:day`), with `force` still only bypassing the pause that an earlier 429 set. `force` never bypasses guards 1 to 8.
- Output cap: `READER_MAX_OUTPUT_TOKENS` (8192) for performer lists and `READER_MAX_OUTPUT_TOKENS_DETAILS` (1024) for details.
- Circuit breaker: `reader:breaker` keeps the consecutive failure count in `used` and the open-until time in `exhausted_until`. A failure is outcome `error`, `invalid_json` or `busy`. A success resets the count. At `READER_BREAKER_FAILURES` failures, or on any cap breach (guards 5 to 9 trip it until the period resets, or until the end of the cool-down for guard 5), or on a provider quota or 402 error, `exhausted_until` is set. Every Worker instance reads it from the database, so all see it. While open, every call is refused with `breaker_open` and `retryAt` is the open-until time, so parked jobs do not wake early.
- Race: two instances can read the same counter at once. The queue runs one consumer at a time (`max_concurrency: 1`), so the error is at most one call. This is accepted and noted.

### How this stops the runaway scenario

Rule: the pipeline, the details route, the recall test and the discovery search have no import of the Gemini or Workers AI client. They hold only a `GuardedReader`. A test (`tests/readerGuarded.test.ts`) greps `src/` and fails if any file outside `src/server/reader/` and `src/server/lineup/gemini.ts` imports `@google/genai` or calls `.run(` on the AI binding. So no loop can reach a model without passing the guards.

Loops that exist today and how each is bounded:
1. `runJob` while loop in `pipeline.ts`: each `stageExtract` pass handles `pendingExtraction[0]` and drops it only after the read. The list is filled by adapters and search with no cap. Bound: guard 6, calls per job, keyed in the database.
2. The catch block in `runJob` re-queues a failing job with `attempts + 1` (`MAX_ATTEMPTS = 3`) and does not drop the page, so the same page is read again. Bound: the attempts counter (at most 3 reads of a page) and guard 6. An `invalid_json` result is not an error: the page is dropped, logged, and not retried.
3. Queue re-sends in `worker/index.ts` (the cron `sendBatch` every minute, the `send` after a step, `message.retry` up to `max_retries: 3`, and stale `running` jobs re-run by `isStaleRun`): duplicates are dropped because `runJob` only starts `queued` or `waiting_quota` jobs, but a stale re-run or a retry after a failed `updateJob` can repeat a read. Bound: the per-job counter and the day and month caps live in the database, not in the message, so a re-send cannot multiply calls past them. The implementer must re-read `worker/index.ts` lines 150 to 260 and list any path not covered in the PR.
4. `stageDiscover`: runs once (`discoveryDone`), and is off by default. It goes through the guard anyway.
5. `geminiReader` in `detailsGemini.ts`: at most `MAX_GEMINI_PAGES` (3) calls per button press. Press is not a job, so guard 6 uses the key `reader:job:details:<eventId>:<YYYY-MM-DD>` with the same cap.
6. Recall test: one provider and one page per request (see below), counted by the same guards.

## AI call log

Migration `supabase/migrations/0038_ai_calls.sql`. Written only by threads; Charlie applies it. The guards do not depend on it.

```sql
create table if not exists ai_calls (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  feature text not null check (feature in ('lineup_extract','details_extract','recall_test','discovery')),
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
  names_rejected int null,
  run_id uuid null,                 -- recall test run
  names_expected int null,          -- recall test: size of the confirmed lineup
  names_matched int null            -- recall test: confirmed names found
);
create index if not exists ai_calls_created_idx on ai_calls (created_at desc);
create index if not exists ai_calls_run_idx on ai_calls (run_id) where run_id is not null;
alter table ai_calls enable row level security;
create policy "owner_read" on ai_calls for select to authenticated using (auth.uid() = owner_user_id());
```

RLS follows 0026 (owner only, as `quota_ledger`): the owner can read, no one signed in can write, the server's service role writes. Include the 0026 style check query and a rollback comment (`drop table ai_calls`) at the bottom. The three last columns (`run_id`, `names_expected`, `names_matched`) are additions to Charlie's list, for the recall test.

Rules:
- Never store page text, prompts, quotes or names. Counts and sizes only.
- One insert per call (the Workers Free plan allows 50 subrequests per request). Blocked calls are one insert too. Never one insert per name.
- Store methods on `LineupStore` (both stores): `addAiCall(row: AiCallRow): Promise<void>`, `listAiCalls(limit: number): Promise<AiCallRow[]>` newest first, `listAiCallsByRun(runId: string): Promise<AiCallRow[]>`, `deleteAiCallsBefore(cutoff: Date): Promise<number>`.
- `logCall` wraps `addAiCall` in try/catch. A failure never fails the read. It adds 1 to the ledger key `reader:logfail:<YYYY-MM-DD>` (one more write, best effort, also swallowed) and `console.warn`s. The owner view shows that count.
- `est_cost_usd` is computed in code with `estimateCostUsd` from `PRICES`. A null token count gives a null cost in the log, and the worst-case estimate in the spend counter.
- Retention: keep 180 days. `deleteAiCallsBefore` exists and is tested; calling it from the cron is out of scope and left as a follow-up note in `docs/architecture/10-quota-and-the-queue.md`.
- `names_returned` is the model's list length; `names_verbatim` is how many passed `isVerbatim`; `names_rejected` is the difference. `GuardedReader` gets these from a callback the call site passes (`onChecked(returned, verbatim)`), because the verbatim check stays in the pipeline.

## GuardedReader

```ts
interface CallContext { feature: 'lineup_extract'|'details_extract'|'recall_test'|'discovery'; jobKey: string; jobId?: string; eventId?: string; userId?: string; documentId?: string; force?: boolean; runId?: string }
interface GuardedReader {
  readonly provider: string; readonly model: string;      // for the extractor string
  extractPerformers(args, ctx): Promise<ReaderResult<ExtractedName[]>>;
  extractEventDetails(args, ctx): Promise<ReaderResult<ExtractedDetails>>;
  discoverLineupUrls(input, ctx): Promise<string[]>;       // Gemini only
}
```

To keep one insert per call, the log row is written after the verbatim check. `extractPerformers` therefore accepts `ctx.afterRead?: (value) => { returned: number; verbatim: number }` and the wrapper calls it before writing the row. Do not add a second write. The factory `createGuardedReader({ client, store, quota, config, now })` is exported; `guardedFromGemini(geminiClient, store, quota, now)` builds one for tests.

## Recall test

Choice: an owner-only server route, one provider and one page per request, driven by a button. Not a container script. Reasons: the `ai` binding exists only inside the Worker, and the Gemini key lives there as a secret; a script would need both copied out. A single request must stay under 50 subrequests, and one guarded call costs about 8 (document read, ledger reads and writes, log insert), so a whole run in one request is impossible. The button runs the pairs one after another and shows progress.

- `GET /api/reader/recall-test/plan?count=8` (owner only, `isOwner(currentMember())` like `/manage/canonical`): returns the pairs `{ runId, items: [{ editionId, name, year, documentId, confirmedCount, docChars }] }`. The store method `listRecallCandidates(limit)` picks confirmed editions that have a stored source document with a lineup, newest first, always including the one with the largest document, and at most one document per edition. Charlie may instead pass `editionIds=` (comma list) to choose pages.
- `POST /api/reader/recall-test/step { runId, editionId, documentId, provider }` (owner only): loads the document, runs the named provider's `ReaderClient` through `GuardedReader` with feature `recall_test` and `runId`, scores the result, and writes one `ai_calls` row (with `names_expected`, `names_matched`). It writes nothing to lineups, claims, editions, documents or the personal log. `provider` is explicit in the request, so this does not break "one provider live at a time". It is not a fallback: each provider is tried on its own, and a failure of one is just its result. Both clients are built on demand when their config exists; a missing one gives `{ skipped: 'not configured' }`.
- `GET /api/reader/recall-test/report?runId=` (owner only): builds the report from `listAiCallsByRun`.
- Scoring (`recall.ts`, pure, tested): normalize each name with `normalizeName` plus the alias table (`store.getAliases()`); `names_matched` is the confirmed names found among the returned names that also pass `isVerbatim`. `recall = matched / expected`. Extra verbatim names (returned, verbatim, not in the confirmed lineup) are counted as `extras` and listed for Charlie to judge (they may be real acts the confirmed list missed). Only counts are stored; the extras list is returned in the step response and shown in the UI, not stored.
- Pass mark: 90% recall per provider overall (sum matched / sum expected) and no page under a 70% floor. Both numbers are config (`READER_RECALL_PASS`, `READER_RECALL_FLOOR`) and Charlie confirms them. Also required to pass: every reply valid JSON. A provider that fails JSON validity on more than 1 page in 10 fails.
- Report format (JSON, and the same rendered as a table in the panel):

```
{ runId, startedAt, windowChars, passMark, floor,
  providers: [{ provider, model, pages, recallOverall, minPageRecall, jsonValidPct, tokensIn, tokensOut, costUsd, avgMs,
                verdict: 'pass'|'fail', reasons: string[],
                perPage: [{ editionId, name, year, docChars, expected, matched, recall, extras, jsonValid, tokensIn, tokensOut, costUsd, durationMs, outcome }] }] }
```
- Cost of a run: about 10 pages x 2 providers; cents. It goes through the same spend and call guards. A blocked step shows its guard reason in the report.
- The test never switches the live provider. Charlie flips `READER_PROVIDER` himself.
- The 43,000-token page is about 170,000 characters. With the default 40,000-character window it will lose names. That is a real finding, not a bug: the report states `windowChars`, and a second run with `READER_WINDOW_CHARS` raised (up to `READER_MAX_INPUT_CHARS`) shows whether a larger window fixes it.

## Owner view

- `GET /api/status` keeps `gemini` and `quota` unchanged and adds `reader: { provider, model, enabled, breaker: { open: boolean; until?: string; failures: number }, callsToday, callsMonth, spendTodayUsd, spendMonthUsd, caps: { dayUsd, monthUsd, perJob, inputChars, outputTokens }, logWriteFailuresToday, recent?: AiCallRow-like[] }`. `recent` (the last 20 calls: when, feature, provider, outcome, guard reason or error code, tokens, cost) is returned only to the owner (`isOwner`). Members get the summary without `recent` and without spend. Also add the month calls counter: ledger key `reader:calls:month:<YYYY-MM>`.
- `AboutDialog.tsx` line 53 keeps "Gemini n/limit today" until the switch. It gains one line for the owner: reader provider, calls today, spend today and month, and "paused until <time>" when the breaker is open. A new `src/components/ReaderPanel.tsx` (owner only, in Manage) shows the last 20 calls and the recall test button and report. Use the shared `Pill` for outcomes. Sample mode shows nothing (it is not the owner view).
- Renaming `gemini` in the status is left for the slice after Charlie's switch.

## Docs changes

Done in slices 10.17 to 10.19, in the same style as the code slices (AGENTS.md: update docs when behavior changes).
- `AGENTS.md`: bullets "Gemini may only extract from text the app fetched" and "Stage 1 research ... Gemini runs in stage 1 only when you press ..." become "the reader model" wording. "On a quota error, park the job and stop. Do not retry with another model" stays word for word, with "(any provider)" added. Add one bullet: "Every model call goes through the guarded reader (`src/server/reader/`): guards first, one `ai_calls` row after, no page text in it, no automatic switch between providers." Keep "Never call it from saving, plain 'Look again' or Fill gaps."
- `REQUIREMENTS.md`: principle 8 (line 37), R2.4 (line 85), R2.6 (line 87), the Cost line (131), and the sources table rows (145, 148) say "Gemini". Make them provider-neutral where they are, keep "Look again with Gemini" as the button name until the switch. Add requirement R2.7: spend guards and the call log, with the caps as owner-set defaults. Update the Cost line: free tiers or a prepaid balance of $5, never auto top-up.
- `ARCHITECTURE.md` (2 mentions) and `docs/architecture/`: `09-lookup-pipeline.md` (the extract stage now reads through the guarded reader), `10-quota-and-the-queue.md` (guards, breaker, ledger keys, per-provider quota, bounded loops, retention note), `11-learning-loops.md` (extractor prefix is any reader), `13-api.md` (status `reader`, the recall routes), `08-sources.md`, `02-stage-1-capture-and-details.md`, `22-testing.md` (fakes use `guardedFromGemini`). `.env.example` lists the new variables.

## Provider-side caps Charlie sets by hand (the outer wall)

Code guards are the inner wall. These are the outer wall and do not depend on the app being correct.
1. Google, prepaid with auto top-up off. Step 1: go to https://aistudio.google.com -> Step 2: open Settings, then Billing -> Step 3: click Set up billing, link a billing account -> Step 4: choose Prepay, add $5 -> Step 5: confirm Automatic top-up is Off. Expected: the balance shows $5 and the key returns 402 at zero.
2. Same page: open the project's rate-limit view and write down the paid per-minute and per-day limits for the pinned model (they are not published elsewhere). Put them in `GEMINI_DAILY_LIMIT` and `GEMINI_PER_MINUTE` only if lower than the defaults.
3. Cloudflare: Workers Free plan has no overage billing; the 10,000 neurons a day allowance ends in error 3036 and resets at 00:00 UTC. Step 1: go to https://dash.cloudflare.com -> Step 2: Workers & Pages, then Plans -> Step 3: check the plan says Free. Do not move to Workers Paid during the test.
4. Rotate the Gemini key if it was ever on the free project: AI Studio, API keys, create a key on the billed project, then `wrangler secret put GEMINI_API_KEY` is Charlie's step through the dashboard (Workers, Settings, Variables and Secrets, edit GEMINI_API_KEY).

## Test plan by slice

All tests are Node test runner files in `tests/`, run on the file store, with faked clients (see `tests/pipeline.test.ts` `fakeGemini` and `tests/detailsGemini.test.ts` `fakeGemini`). No test makes a network call.
- 10.1: usage mapping from a fake SDK response (candidates + thoughts); `MAX_TOKENS` and bad JSON give `invalid_json`; 402 gives `QuotaExhaustedError`; existing tests unchanged.
- 10.2/10.3: round trip of `addAiCall` / `listAiCalls` / `listAiCallsByRun` / `deleteAiCallsBefore` on the file store; migration file has RLS and the check constraints (a test reads the SQL text for `enable row level security` and each `outcome` value).
- 10.4: each guard in the order table refuses with its reason; spend worst-case arithmetic; breaker opens at N failures and on a cap breach, and refuses until `exhausted_until`; success resets; kill switch; ledger failure fails closed; `force` does not bypass guards 1 to 8; `-latest` refused only when the provider is set explicitly.
- 10.5: blocked call writes one row and no provider call (counter on the fake); log failure does not fail the read and increments the counter; a source-scan test that nothing outside `src/server/reader/` and `gemini.ts` imports the SDK.
- 10.6: `createReader` from env: default `gemini`; kill switch; discovery client goes through the guard.
- 10.7: pipeline with a fake reader: per-job cap stops a 10-page job at 6 calls and parks it; `invalid_json` drops the page with a job log line and no retry; breaker open parks with `retryAt` = until; a thrown error re-reads at most `MAX_ATTEMPTS` times; the extraction cache still avoids calls.
- 10.8: learning loop accepts `workers-ai:` extractors.
- 10.9: the details press makes at most 3 calls and respects the per-day key.
- 10.10: Workers AI adapter with a fake binding: sets `max_tokens` and `response_format`; wrong shape and `length` finish are `invalid_json`; error 3036 gives quota parked until the next UTC midnight; 3040 gives `ReaderBusyError`; usage mapping with and without `usage`.
- 10.11: provider switch; `READER_PROVIDER=workers-ai` without a binding gives no reader.
- 10.12 to 10.14: scoring (alias match, extras, floor), report shape, plan picks the largest document, step writes nothing to lineups (assert the store's claims and editions are unchanged), owner-only 403 for members.
- 10.15: status shape; members get no `recent`.
- 10.16: typecheck only (`[UI / VISUAL]`).
- 10.17/10.18: `tests/docsLinks.test.ts` still passes.

## Unverified facts the implementer must check live

Do not assume these. Check once, write the result in the PR description, and adjust the code if it differs.
1. Whether `@cf/zai-org/glm-4.7-flash` and `@cf/google/gemma-4-26b-a4b-it` enforce `response_format` JSON schema, or only try. Check by sending the performer schema on a real page. Cloudflare's JSON Mode page says it cannot guarantee the shape; the code validates either way.
2. Whether `env.AI.run` counts toward the 50 subrequests per request on the Free plan (research reads it as internal). Count `fetch` plus store calls on a real job step.
3. Gemini `usageMetadata` fields: `promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, and whether thinking tokens are billed as output for the pinned Flash-Lite model. Whether `thinkingConfig: { thinkingBudget: 0 }` is accepted by it (set it only if so).
4. Which Gemini model name to pin. The research guesses `gemini-3.5-flash-lite` but does not confirm it. Charlie confirms the name from AI Studio's model list.
5. Current list prices (Google and Cloudflare pricing pages). Fill `PRICES` with a `checkedOn` date. Do not take prices from this spec or from memory.
6. Workers AI inner error codes 3036 and 3040 and where they appear (message text or a field) in the binding's thrown error.
7. Whether `worker/index.ts` paths other than those listed above can repeat a read (see "How this stops the runaway scenario", item 3).
8. How to link a confirmed edition to its source documents for `listRecallCandidates` (through `performer_claims.document_id` for the edition's confirmed performances, or another path in the stores).

## Needed from Charlie

1. Apply migration `supabase/migrations/0038_ai_calls.sql` (after slice 10.3 merges). Supabase dashboard, SQL Editor, paste, Run. Until then the log writes fail safely and are counted, and nothing else is affected.
2. Add $5 prepaid billing in Google AI Studio with auto top-up off (steps above).
3. Confirm the pass mark (90% overall, 70% page floor), or change them.
4. Pick the test pages, or accept the automatic pick of up to 8 confirmed editions that includes the largest page.
5. Confirm the default caps ($0.50 a day, $5 a month, 6 calls per job, 60,000 input characters, 8,192 output tokens, breaker at 5 failures and a 30 minute cool-down).
6. Confirm the pinned Gemini model name.
7. After the test, decide the live provider and flip `READER_PROVIDER` in the Cloudflare dashboard. Then a follow-up slice renames buttons and the `gemini` status field.
