import { canonicalName } from '../lineup/merge';
import { isVerbatim, normalizeName } from '../lineup/text';
import { estimateCostUsd, worstCaseMicroUsd } from './pricing';
import type { ReaderProvider } from './types';

// Pure scoring for the local recall benchmark. No I/O, no network, no env.
// Matching reuses the real normalizeName, isVerbatim and canonicalName (alias table); nothing is copied or loosened.

export interface ReturnedName {
  name: string;
  quote: string; // the quoted span the model gave; isVerbatim checks it against the page
}

export interface PageScore {
  expected: number;
  matched: number;
  recall: number | null; // null when nothing was expected
  missed: string[]; // expected names not matched
  extras: string[]; // verbatim returned names not in the expected set (for Charlie to judge)
  rejected: number; // returned names that failed isVerbatim
  // Ground truth check: expected names that are not on the page text at all (a ground-truth issue, not a model miss).
  expectedOnPage: number;
  recallOnPage: number | null; // matched / expectedOnPage; null when no expected name is on the page
  notOnPage: number; // expected names not found verbatim (alias table applied) in the page text
  notOnPageNames: string[]; // up to NOT_ON_PAGE_LIST_MAX of them
}

export const NOT_ON_PAGE_LIST_MAX = 10;

function keyOf(name: string, aliases: Record<string, string>): string {
  return normalizeName(canonicalName(name, aliases));
}

// `aliases` maps a normalized name to its canonical spelling, the same table merge.ts uses.
export function scorePage(
  expectedNames: string[],
  returned: ReturnedName[],
  pageText: string,
  aliases: Record<string, string> = {},
): PageScore {
  const normalizedSource = normalizeName(pageText);
  const expected = new Map<string, string>();
  for (const name of expectedNames) {
    const key = keyOf(name, aliases);
    if (key && !expected.has(key)) expected.set(key, name);
  }

  const verbatim = new Map<string, string>();
  const rejectedKeys = new Set<string>();
  for (const r of returned) {
    const key = keyOf(r.name, aliases);
    if (!key) continue;
    if (isVerbatim(r.name, r.quote, normalizedSource)) {
      if (!verbatim.has(key)) verbatim.set(key, r.name);
    } else {
      rejectedKeys.add(key);
    }
  }
  // A name rejected once but accepted elsewhere is accepted.
  for (const key of verbatim.keys()) rejectedKeys.delete(key);

  const missed: string[] = [];
  let matched = 0;
  for (const [key, name] of expected) {
    if (verbatim.has(key)) matched++;
    else missed.push(name);
  }
  const extras = [...verbatim].filter(([key]) => !expected.has(key)).map(([, name]) => name);

  // An expected name is on the page when the model matched it, or its own spelling or canonical spelling appears verbatim.
  const notOnPageNames: string[] = [];
  let notOnPage = 0;
  for (const [key, name] of expected) {
    const canon = canonicalName(name, aliases);
    const onPage = verbatim.has(key) || isVerbatim(name, name, normalizedSource) || isVerbatim(canon, canon, normalizedSource);
    if (!onPage) {
      notOnPage++;
      if (notOnPageNames.length < NOT_ON_PAGE_LIST_MAX) notOnPageNames.push(name);
    }
  }
  const expectedOnPage = expected.size - notOnPage;

  return {
    expected: expected.size,
    matched,
    recall: expected.size === 0 ? null : matched / expected.size,
    missed,
    extras,
    rejected: rejectedKeys.size,
    expectedOnPage,
    recallOnPage: expectedOnPage === 0 ? null : matched / expectedOnPage,
    notOnPage,
    notOnPageNames,
  };
}

export interface PageRun {
  pageId: string;
  validJson: boolean; // false: the model's reply was not valid JSON; the page scores zero matched
  score: PageScore;
  inputTokens: number | null;
  outputTokens: number | null; // includes thinking tokens, as ReaderUsage does
  thinkingTokens: number | null; // informational subset of outputTokens
  latencyMs: number;
  finishReason: string | null; // Gemini finishReason or Workers AI finish_reason, when reported
  truncated: boolean; // the reply hit the output-token cap
  retries: number; // extra attempts made for this page after a transient error
  callFailed?: boolean; // the call itself failed (no reply), as opposed to a reply that was not valid JSON
}

export interface ModelRun {
  provider: ReaderProvider;
  model: string;
  window: number; // characters of page text the model was shown
  maxOutputTokens?: number; // output-token cap the calls used
  retriedCalls?: number; // retries over the whole run, including pages that never completed
  pages: PageRun[];
}

// Why a page's reply is not valid JSON; null when it was valid.
export function invalidReason(p: PageRun, maxOutputTokens?: number): string | null {
  if (p.validJson) return null;
  if (p.callFailed) return 'call failed';
  if (p.truncated) return maxOutputTokens ? `truncated at ${maxOutputTokens} output tokens` : 'truncated at the output-token cap';
  return 'unparseable';
}

export interface ModelReport {
  provider: ReaderProvider;
  model: string;
  window: number;
  maxOutputTokens: number | null;
  pageCount: number;
  matched: number;
  expected: number;
  expectedOnPage: number;
  notOnPage: number;
  overallRecall: number | null; // sum matched / sum expected; null when nothing was expected
  minPageRecall: number | null; // lowest recall over pages that expected something
  overallRecallOnPage: number | null; // sum matched / sum expectedOnPage; the pass verdict uses this
  minPageRecallOnPage: number | null; // lowest recallOnPage over pages with an expected name on the page
  truncatedPages: number;
  retriedCalls: number;
  invalidJsonPages: number;
  jsonValidityPct: number | null;
  inputTokens: number | null; // null when any page did not report it
  outputTokens: number | null;
  thinkingTokens: number | null;
  costUsd: number | null;
  latencyMs: number; // total
  avgLatencyMs: number | null;
  pages: PageRun[];
}

function sumOrNull(values: Array<number | null>): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

export function buildReport(run: ModelRun): ModelReport {
  const { pages } = run;
  const matched = pages.reduce((s, p) => s + p.score.matched, 0);
  const expected = pages.reduce((s, p) => s + p.score.expected, 0);
  const recalls = pages.map((p) => p.score.recall).filter((r): r is number => r !== null);
  const onPageRecalls = pages.map((p) => p.score.recallOnPage).filter((r): r is number => r !== null);
  const expectedOnPage = pages.reduce((s, p) => s + p.score.expectedOnPage, 0);
  const invalid = pages.filter((p) => !p.validJson).length;
  const costs = pages.map((p) =>
    estimateCostUsd(run.provider, run.model, { inputTokens: p.inputTokens, outputTokens: p.outputTokens }),
  );
  const latencyMs = pages.reduce((s, p) => s + p.latencyMs, 0);
  return {
    provider: run.provider,
    model: run.model,
    window: run.window,
    maxOutputTokens: run.maxOutputTokens ?? null,
    pageCount: pages.length,
    matched,
    expected,
    expectedOnPage,
    notOnPage: pages.reduce((s, p) => s + p.score.notOnPage, 0),
    overallRecall: expected === 0 ? null : matched / expected,
    minPageRecall: recalls.length === 0 ? null : Math.min(...recalls),
    overallRecallOnPage: expectedOnPage === 0 ? null : matched / expectedOnPage,
    minPageRecallOnPage: onPageRecalls.length === 0 ? null : Math.min(...onPageRecalls),
    truncatedPages: pages.filter((p) => p.truncated).length,
    retriedCalls: run.retriedCalls ?? pages.reduce((s, p) => s + p.retries, 0),
    invalidJsonPages: invalid,
    jsonValidityPct: pages.length === 0 ? null : ((pages.length - invalid) / pages.length) * 100,
    inputTokens: sumOrNull(pages.map((p) => p.inputTokens)),
    outputTokens: sumOrNull(pages.map((p) => p.outputTokens)),
    thinkingTokens: sumOrNull(pages.map((p) => p.thinkingTokens)),
    costUsd: sumOrNull(costs),
    latencyMs,
    avgLatencyMs: pages.length === 0 ? null : latencyMs / pages.length,
    pages,
  };
}

export const PASS_OVERALL_RECALL = 0.9;
export const PASS_PAGE_FLOOR = 0.7;
export const PASS_INVALID_JSON_RATE = 0.1;

export interface Verdict {
  pass: boolean;
  reasons: string[]; // why it failed; empty when it passed
  maxInvalidPages: number;
}

// Pass mark: recall on page at least 90%, no page under 70%, and at most 1 invalid-JSON page in 10.
// Recall on page counts only expected names that are on the page text; names missing from the page are a
// ground-truth issue, not a model miss, so they do not count against the model.
// The invalid allowance scales as floor(pages / 10): 10 pages allow 1, 20 allow 2, and fewer than 10 allow 0,
// so the invalid rate never exceeds 10%. Pages with no expected name on them do not count toward the floor.
// With no expected names on any page there is nothing to measure, so it cannot pass.
export function passVerdict(report: ModelReport): Verdict {
  const reasons: string[] = [];
  const maxInvalidPages = Math.floor(report.pageCount * PASS_INVALID_JSON_RATE + 1e-9);
  if (report.overallRecallOnPage === null) reasons.push('no expected names on the pages to score');
  else if (report.overallRecallOnPage < PASS_OVERALL_RECALL - 1e-9) {
    reasons.push(`recall on page ${pct(report.overallRecallOnPage)} is under 90%`);
  }
  if (report.minPageRecallOnPage !== null && report.minPageRecallOnPage < PASS_PAGE_FLOOR - 1e-9) {
    reasons.push(`a page has recall on page ${pct(report.minPageRecallOnPage)}, under 70%`);
  }
  if (report.invalidJsonPages > maxInvalidPages) {
    reasons.push(`${report.invalidJsonPages} invalid JSON pages, more than ${maxInvalidPages} allowed in ${report.pageCount}`);
  }
  return { pass: reasons.length === 0, reasons, maxInvalidPages };
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function num(value: number | null): string {
  return value === null ? 'n/a' : String(value);
}

function usd(value: number | null): string {
  return value === null ? 'n/a' : `$${value.toFixed(4)}`;
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderMarkdown(reports: ModelReport | ModelReport[]): string {
  const list = Array.isArray(reports) ? reports : [reports];
  const lines: string[] = ['# Recall benchmark', ''];
  lines.push(
    'Recall is matched names over all expected names. Recall on page is matched names over only the expected names that are on the page text; the pass verdict uses it. Expected names missing from the page text are a ground-truth issue, not a model miss.',
    '',
    '| Model | Window | Recall | Recall on page | Min page (on page) | JSON valid | Truncated pages | Retried calls | Input tokens | Output tokens | Thinking tokens | Cost (USD) | Latency (ms) | Verdict |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const r of list) {
    const v = passVerdict(r);
    lines.push(
      `| ${cell(`${r.provider}:${r.model}`)} | ${r.window} | ${pct(r.overallRecall)} | ${pct(r.overallRecallOnPage)} | ${pct(r.minPageRecallOnPage)} | ${
        r.jsonValidityPct === null ? 'n/a' : `${r.jsonValidityPct.toFixed(0)}%`
      } | ${r.truncatedPages} | ${r.retriedCalls} | ${num(r.inputTokens)} | ${num(r.outputTokens)} | ${num(r.thinkingTokens)} | ${usd(r.costUsd)} | ${
        r.avgLatencyMs === null ? 'n/a' : Math.round(r.avgLatencyMs)
      } | ${v.pass ? 'PASS' : 'FAIL'} |`,
    );
  }
  for (const r of list) {
    const v = passVerdict(r);
    lines.push(
      '',
      `## ${r.provider}:${r.model}`,
      '',
      `Window used: ${r.window} characters. Max output tokens: ${r.maxOutputTokens ?? 'n/a'}. Expected names not on the page text: ${r.notOnPage} of ${r.expected}.`,
    );
    if (!v.pass) lines.push('', ...v.reasons.map((x) => `- ${x}`));
    lines.push(
      '',
      '| Page | Matched | Expected | On page | Recall | Recall on page | JSON | Finish | Extras | Rejected | Missed | Not on page |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const p of r.pages) {
      const why = invalidReason(p, r.maxOutputTokens ?? undefined);
      const notOn = p.score.notOnPage === 0 ? '' : `${p.score.notOnPage}: ${p.score.notOnPageNames.join(', ')}${p.score.notOnPage > p.score.notOnPageNames.length ? ', ...' : ''}`;
      lines.push(
        `| ${cell(p.pageId)} | ${p.score.matched} | ${p.score.expected} | ${p.score.expectedOnPage} | ${pct(p.score.recall)} | ${pct(p.score.recallOnPage)} | ${
          why === null ? 'valid' : `invalid (${why})`
        } | ${p.finishReason ?? 'n/a'} | ${cell(p.score.extras.join(', '))} | ${p.score.rejected} | ${cell(p.score.missed.join(', '))} | ${cell(notOn)} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Local benchmark runner pieces (used by scripts/recall-test.ts). Still no network or env here:
// the model calls are injected, so tests run with fakes.
// ---------------------------------------------------------------------------

export const BENCH_MODELS: Array<{ provider: ReaderProvider; model: string }> = [
  { provider: 'gemini', model: 'gemini-3.5-flash-lite' },
  { provider: 'gemini', model: 'gemini-4-hydrogen' },
  { provider: 'workers-ai', model: '@cf/zai-org/glm-4.7-flash' },
  { provider: 'workers-ai', model: '@cf/google/gemma-4-26b-a4b-it' },
];

export const DEFAULT_PAGE_LIMIT = 8;
export const DEFAULT_WINDOW = 180000;
export const DEFAULT_MAX_CALLS = 40;
export const DEFAULT_MAX_USD = 2;
export const BENCH_MAX_OUTPUT_TOKENS = 8192;

export interface BenchArgs {
  fixture: string | null;
  limit: number;
  window: number;
  maxCalls: number;
  maxUsd: number;
  maxOutputTokens: number;
  models: string[] | null; // null: all four
  outJson: string | null;
  outMd: string | null;
  help: boolean;
}

export function parseBenchArgs(argv: string[]): BenchArgs {
  const a: BenchArgs = {
    fixture: null,
    limit: DEFAULT_PAGE_LIMIT,
    window: DEFAULT_WINDOW,
    maxCalls: DEFAULT_MAX_CALLS,
    maxUsd: DEFAULT_MAX_USD,
    maxOutputTokens: BENCH_MAX_OUTPUT_TOKENS,
    models: null,
    outJson: null,
    outMd: null,
    help: false,
  };
  const positive = (flag: string, v: string | undefined): number => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number`);
    return n;
  };
  const text = (flag: string, v: string | undefined): string => {
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') a.help = true;
    else if (arg === '--fixture') a.fixture = text(arg, argv[++i]);
    else if (arg === '--limit') a.limit = Math.floor(positive(arg, argv[++i]));
    else if (arg === '--window') a.window = Math.floor(positive(arg, argv[++i]));
    else if (arg === '--max-calls') a.maxCalls = Math.floor(positive(arg, argv[++i]));
    else if (arg === '--max-usd') a.maxUsd = positive(arg, argv[++i]);
    else if (arg === '--max-output-tokens') a.maxOutputTokens = Math.floor(positive(arg, argv[++i]));
    else if (arg === '--models') a.models = text(arg, argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--out-json') a.outJson = text(arg, argv[++i]);
    else if (arg === '--out-md') a.outMd = text(arg, argv[++i]);
    else throw new Error(`Unknown option ${arg}`);
  }
  return a;
}

export interface BenchDoc {
  id: string;
  url: string;
  text: string; // plain page text, as the reader would be shown it
  hasLineup: boolean; // a stored performer claim points at this document
}

export interface BenchEdition {
  key: string;
  name: string;
  year: number;
  date: string; // ISO; confirmedAt, else updatedAt. Used only to sort newest first.
  expectedNames: string[]; // the confirmed lineup
  documents: BenchDoc[];
}

export interface BenchPage {
  pageId: string; // `${editionKey} | ${url}`
  editionKey: string;
  eventName: string;
  year: number;
  text: string;
  expectedNames: string[];
}

// Up to `limit` pages: at most one per edition (its largest document with a lineup), newest edition first,
// and the largest page overall is always included (it replaces the oldest pick when it would be left out).
export function selectPages(editions: BenchEdition[], limit: number = DEFAULT_PAGE_LIMIT): BenchPage[] {
  const candidates: Array<{ date: string; page: BenchPage }> = [];
  for (const e of editions) {
    if (e.expectedNames.length === 0) continue;
    let best: BenchDoc | null = null;
    for (const d of e.documents) {
      if (d.hasLineup && (best === null || d.text.length > best.text.length)) best = d;
    }
    if (!best) continue;
    candidates.push({
      date: e.date,
      page: { pageId: `${e.key} | ${best.url}`, editionKey: e.key, eventName: e.name, year: e.year, text: best.text, expectedNames: e.expectedNames },
    });
  }
  if (limit <= 0 || candidates.length === 0) return [];
  const sorted = [...candidates].sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : x.page.pageId.localeCompare(y.page.pageId)));
  const largest = sorted.reduce((m, c) => (c.page.text.length > m.page.text.length ? c : m), sorted[0]);
  const picked = sorted.slice(0, limit);
  if (!picked.includes(largest)) picked[picked.length - 1] = largest;
  return picked.map((c) => c.page);
}

// What a model call hands back: the raw reply text and what the provider reported.
export interface RawReply {
  text: string;
  truncated: boolean;
  finishReason?: string | null; // Gemini finishReason or Workers AI finish_reason, when the provider gave one
  inputTokens: number | null;
  outputTokens: number | null; // includes thinking
  thinkingTokens: number | null;
}

export type BenchCaller = (page: BenchPage, args: { window: number; maxOutputTokens: number }) => Promise<RawReply>;

export interface BenchModelSpec {
  provider: ReaderProvider;
  model: string;
  call: BenchCaller;
}

// Both Workers AI envelopes, once the REST `result` wrapper is removed:
// { response: string | object, usage } or { choices: [{ message: { content }, finish_reason }], usage }.
export function parseWorkersAiEnvelope(body: unknown): RawReply {
  const top = (body ?? {}) as Record<string, any>;
  const res: Record<string, any> = top.result && typeof top.result === 'object' ? top.result : top;
  let text: string;
  if (typeof res.response === 'string') text = res.response;
  else if (res.response && typeof res.response === 'object') text = JSON.stringify(res.response); // JSON mode may return an object
  else {
    const content = res.choices?.[0]?.message?.content;
    text = typeof content === 'string' ? content : '';
  }
  const finish = res.finish_reason ?? res.choices?.[0]?.finish_reason;
  const truncated = finish === 'length';
  const input = res.usage?.prompt_tokens;
  const output = res.usage?.completion_tokens;
  const thinking = res.usage?.completion_tokens_details?.reasoning_tokens;
  return {
    text,
    truncated,
    finishReason: typeof finish === 'string' ? finish : null,
    inputTokens: typeof input === 'number' ? input : null,
    outputTokens: typeof output === 'number' ? output : null,
    thinkingTokens: typeof thinking === 'number' ? thinking : null,
  };
}

// Workers AI inner error codes sit in the REST `errors` array or in the thrown message (HTTP status is 429 for both).
export function workersAiErrorCode(body: unknown, message = ''): number | null {
  const errors = (body as { errors?: Array<{ code?: unknown }> } | null)?.errors;
  if (Array.isArray(errors)) {
    for (const e of errors) if (typeof e?.code === 'number') return e.code;
  }
  const m = /\b(3036|3040)\b/.exec(message);
  return m ? Number(m[1]) : null;
}

// Error thrown by the thin REST caller.
export class BenchHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: number | null = null,
  ) {
    super(message);
    this.name = 'BenchHttpError';
  }
}

export type FailureKind = 'quota' | 'unavailable' | 'error';

// 402, "prepayment credits are depleted", Workers AI 3036, or a rate-limit/quota error: stop the model.
// 404, or "not found / not available" wording: this key cannot use the model; report it and move on.
export function classifyFailure(err: unknown): FailureKind {
  const e = err as { status?: number; code?: number; message?: string; name?: string };
  const message = typeof e?.message === 'string' ? e.message : '';
  if (e?.name === 'QuotaExhaustedError') return 'quota';
  if (e?.status === 402 || e?.code === 402) return 'quota';
  if (e?.code === 3036 || /\b3036\b|prepayment credits are depleted|billing.*depleted|quota|resource[_ ]exhausted|rate limit/i.test(message)) return 'quota';
  if (e?.status === 429 || e?.code === 429) return /\b3040\b/.test(message) ? 'error' : 'quota';
  if (e?.status === 404 || e?.code === 404 || /not found|not available|no such model|not supported|unknown model|permission denied|\b403\b/i.test(message)) return 'unavailable';
  return 'error';
}

export const MAX_RETRIES = 3;
export const RETRY_BACKOFF_MS = 1000;

// CLI only, and never a quota error. Gemini: HTTP 503 / UNAVAILABLE. Workers AI: any 5xx, or a timeout.
export function isTransient(provider: ReaderProvider, err: unknown): boolean {
  if (classifyFailure(err) === 'quota') return false;
  const e = err as { status?: number; code?: number | string; message?: string; name?: string };
  const message = typeof e?.message === 'string' ? e.message : '';
  const status = typeof e?.status === 'number' ? e.status : typeof e?.code === 'number' ? e.code : null;
  if (provider === 'gemini') return status === 503 || /\bUNAVAILABLE\b|\b503\b/.test(message);
  const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError' || e?.code === 'ETIMEDOUT' || /timed? ?out|ETIMEDOUT/i.test(message);
  return (status !== null && status >= 500 && status < 600) || timeout;
}

// Strip secrets from anything that gets printed or written.
export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  return out;
}

// Gemini's SCHEMA uses upper-case type names; Workers AI wants JSON Schema.
export function toJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) out[k] = k === 'type' && typeof v === 'string' ? v.toLowerCase() : toJsonSchema(v);
    return out;
  }
  return schema;
}

export function parsePerformers(text: string): ReturnedName[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const list = (parsed as { performers?: unknown } | null)?.performers;
  if (!Array.isArray(list)) return null;
  const out: ReturnedName[] = [];
  for (const item of list) {
    const i = item as { name?: unknown; quote?: unknown } | null;
    if (!i || typeof i.name !== 'string' || typeof i.quote !== 'string') return null;
    out.push({ name: i.name, quote: i.quote });
  }
  return out;
}

export interface ModelOutcome {
  provider: ReaderProvider;
  model: string;
  run: ModelRun;
  stopped: { kind: FailureKind; message: string } | null; // why this model stopped early; null when all pages were tried
  errorsByPage: Array<{ pageId: string; message: string }>;
}

export interface BenchResult {
  window: number;
  maxOutputTokens: number;
  models: ModelOutcome[];
  calls: number;
  spentUsd: number; // estimated: actual usage when reported, else the worst case
  aborted: string | null; // why the whole run stopped, from --max-calls or --max-usd
}

export interface BenchOptions {
  window: number;
  maxCalls: number;
  maxUsd: number;
  maxOutputTokens?: number;
  aliases?: Record<string, string>;
  now?: () => number;
  log?: (line: string) => void;
  secrets?: string[];
  sleep?: (ms: number) => Promise<void>; // injectable so tests do not wait
}

// Models run one after another, pages one after another. A quota or unavailable error stops that model only,
// and that page is never sent to a different model on its behalf. Aborts the whole run at the call or spend cap.
export async function runBenchmark(specs: BenchModelSpec[], pages: BenchPage[], opts: BenchOptions): Promise<BenchResult> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const maxOutputTokens = opts.maxOutputTokens ?? BENCH_MAX_OUTPUT_TOKENS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const result: BenchResult = { window: opts.window, maxOutputTokens, models: [], calls: 0, spentUsd: 0, aborted: null };

  for (const spec of specs) {
    const outcome: ModelOutcome = {
      provider: spec.provider,
      model: spec.model,
      run: { provider: spec.provider, model: spec.model, window: opts.window, maxOutputTokens, retriedCalls: 0, pages: [] },
      stopped: null,
      errorsByPage: [],
    };
    result.models.push(outcome);
    if (result.aborted) continue;

    pageLoop: for (const page of pages) {
      const shown = Math.min(page.text.length, opts.window);
      const worst = worstCaseMicroUsd(spec.provider, spec.model, shown, maxOutputTokens).micro / 1_000_000;
      const started = now();
      let reply: RawReply | null = null;
      let retries = 0;
      // Each attempt, retries included, counts toward --max-calls and --max-usd.
      for (;;) {
        if (result.calls >= opts.maxCalls) {
          result.aborted = `--max-calls ${opts.maxCalls} reached after ${result.calls} calls`;
          break pageLoop;
        }
        if (result.spentUsd + worst > opts.maxUsd) {
          result.aborted = `--max-usd ${opts.maxUsd} would be exceeded (spent about $${result.spentUsd.toFixed(4)}, next call could cost up to $${worst.toFixed(4)})`;
          break pageLoop;
        }
        result.calls += 1;
        try {
          reply = await spec.call(page, { window: opts.window, maxOutputTokens });
          break;
        } catch (err) {
          result.spentUsd += worst; // unknown usage: count the worst case
          const kind = classifyFailure(err);
          const message = redact(err instanceof Error ? err.message : String(err), opts.secrets ?? []);
          if (kind === 'error' && retries < MAX_RETRIES && isTransient(spec.provider, err)) {
            retries += 1;
            outcome.run.retriedCalls = (outcome.run.retriedCalls ?? 0) + 1;
            log(`  ${spec.model}: transient error on ${page.pageId}, retry ${retries} of ${MAX_RETRIES}: ${message}`);
            await sleep(RETRY_BACKOFF_MS * 2 ** (retries - 1));
            continue;
          }
          if (kind === 'error') {
            outcome.errorsByPage.push({ pageId: page.pageId, message });
            outcome.run.pages.push(failedPage(page.pageId, now() - started, retries));
            log(`  ${spec.model}: error on ${page.pageId}${retries ? ` after ${retries} retries` : ''}: ${message}`);
            continue pageLoop;
          }
          outcome.stopped = { kind, message };
          log(`  ${spec.model}: stopped (${kind}): ${message}`);
          break pageLoop;
        }
      }
      if (!reply) continue;
      const latencyMs = now() - started;
      const cost = estimateCostUsd(spec.provider, spec.model, { inputTokens: reply.inputTokens, outputTokens: reply.outputTokens });
      result.spentUsd += cost ?? worst;
      const returned = reply.truncated ? null : parsePerformers(reply.text);
      const score = scorePage(page.expectedNames, returned ?? [], page.text, opts.aliases ?? {});
      outcome.run.pages.push({
        pageId: page.pageId,
        validJson: returned !== null,
        score,
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        thinkingTokens: reply.thinkingTokens,
        latencyMs,
        finishReason: reply.finishReason ?? null,
        truncated: reply.truncated,
        retries,
      });
      const run = outcome.run.pages[outcome.run.pages.length - 1];
      const why = invalidReason(run, maxOutputTokens);
      log(
        `  ${spec.model}: ${page.pageId} recall ${pct(score.recall)}, on page ${pct(score.recallOnPage)} (${score.notOnPage} expected not on page)` +
          `${why ? ` (invalid JSON: ${why})` : ''}${run.finishReason ? ` [finish ${run.finishReason}]` : ''}`,
      );
    }
  }
  return result;

  function failedPage(pageId: string, latencyMs: number, retries: number): PageRun {
    return {
      pageId,
      validJson: false,
      score: scorePage([], [], ''),
      inputTokens: null,
      outputTokens: null,
      thinkingTokens: null,
      latencyMs,
      finishReason: null,
      truncated: false,
      retries,
      callFailed: true,
    };
  }
}

// A failed page still counts its expected names, so recall is not flattered by an error.
export function reportsFor(result: BenchResult, pages: BenchPage[], aliases: Record<string, string> = {}): ModelReport[] {
  return result.models.map((m) => {
    const run: ModelRun = {
      ...m.run,
      pages: m.run.pages.map((p) => {
        const page = pages.find((x) => x.pageId === p.pageId);
        return p.validJson || !page || p.score.expected > 0 ? p : { ...p, score: scorePage(page.expectedNames, [], page.text, aliases) };
      }),
    };
    return buildReport(run);
  });
}

export function renderBenchMarkdown(result: BenchResult, pages: BenchPage[], aliases: Record<string, string> = {}): string {
  const reports = reportsFor(result, pages, aliases);
  const lines = [
    renderMarkdown(reports).trimEnd(),
    '',
    '## Run',
    '',
    `Window used: ${result.window} characters per page. Max output tokens: ${result.maxOutputTokens}. Pages: ${pages.length}. Calls (retries included): ${result.calls}. Estimated spend: $${result.spentUsd.toFixed(4)}.`,
  ];
  if (result.aborted) lines.push('', `Run aborted: ${result.aborted}.`);
  for (const m of result.models) {
    if (m.stopped) lines.push('', `${m.provider}:${m.model} stopped (${m.stopped.kind}) after ${m.run.pages.length} of ${pages.length} pages: ${cell(m.stopped.message)}`);
    else if (m.run.pages.length === 0) lines.push('', `${m.provider}:${m.model} was not run.`);
  }
  return `${lines.join('\n')}\n`;
}

export function benchJson(result: BenchResult, pages: BenchPage[], aliases: Record<string, string> = {}) {
  return {
    window: result.window,
    maxOutputTokens: result.maxOutputTokens,
    note: 'Expected names missing from the page text are a ground-truth issue, not a model miss. recallOnPage ignores them and drives the verdict.',
    calls: result.calls,
    estimatedSpendUsd: result.spentUsd,
    aborted: result.aborted,
    pages: pages.map((p) => ({ pageId: p.pageId, expected: p.expectedNames.length })),
    models: reportsFor(result, pages, aliases).map((report, i) => ({
      ...report,
      pages: report.pages.map((p) => ({ ...p, invalidReason: invalidReason(p, report.maxOutputTokens ?? undefined) })),
      verdict: passVerdict(report),
      stopped: result.models[i].stopped,
      errors: result.models[i].errorsByPage,
    })),
  };
}
