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
}

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

  return {
    expected: expected.size,
    matched,
    recall: expected.size === 0 ? null : matched / expected.size,
    missed,
    extras,
    rejected: rejectedKeys.size,
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
}

export interface ModelRun {
  provider: ReaderProvider;
  model: string;
  window: number; // characters of page text the model was shown
  pages: PageRun[];
}

export interface ModelReport {
  provider: ReaderProvider;
  model: string;
  window: number;
  pageCount: number;
  matched: number;
  expected: number;
  overallRecall: number | null; // sum matched / sum expected; null when nothing was expected
  minPageRecall: number | null; // lowest recall over pages that expected something
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
  const invalid = pages.filter((p) => !p.validJson).length;
  const costs = pages.map((p) =>
    estimateCostUsd(run.provider, run.model, { inputTokens: p.inputTokens, outputTokens: p.outputTokens }),
  );
  const latencyMs = pages.reduce((s, p) => s + p.latencyMs, 0);
  return {
    provider: run.provider,
    model: run.model,
    window: run.window,
    pageCount: pages.length,
    matched,
    expected,
    overallRecall: expected === 0 ? null : matched / expected,
    minPageRecall: recalls.length === 0 ? null : Math.min(...recalls),
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

// Pass mark: overall recall at least 90%, no page under 70%, and at most 1 invalid-JSON page in 10.
// The invalid allowance scales as floor(pages / 10): 10 pages allow 1, 20 allow 2, and fewer than 10 allow 0,
// so the invalid rate never exceeds 10%. Pages that expected nothing do not count toward the floor.
// With no expected names at all there is nothing to measure, so it cannot pass.
export function passVerdict(report: ModelReport): Verdict {
  const reasons: string[] = [];
  const maxInvalidPages = Math.floor(report.pageCount * PASS_INVALID_JSON_RATE + 1e-9);
  if (report.overallRecall === null) reasons.push('no expected names to score');
  else if (report.overallRecall < PASS_OVERALL_RECALL - 1e-9) {
    reasons.push(`overall recall ${pct(report.overallRecall)} is under 90%`);
  }
  if (report.minPageRecall !== null && report.minPageRecall < PASS_PAGE_FLOOR - 1e-9) {
    reasons.push(`a page has recall ${pct(report.minPageRecall)}, under 70%`);
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
    '| Model | Window | Recall | Min page | JSON valid | Input tokens | Output tokens | Thinking tokens | Cost (USD) | Latency (ms) | Verdict |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const r of list) {
    const v = passVerdict(r);
    lines.push(
      `| ${cell(`${r.provider}:${r.model}`)} | ${r.window} | ${pct(r.overallRecall)} | ${pct(r.minPageRecall)} | ${
        r.jsonValidityPct === null ? 'n/a' : `${r.jsonValidityPct.toFixed(0)}%`
      } | ${num(r.inputTokens)} | ${num(r.outputTokens)} | ${num(r.thinkingTokens)} | ${usd(r.costUsd)} | ${
        r.avgLatencyMs === null ? 'n/a' : Math.round(r.avgLatencyMs)
      } | ${v.pass ? 'PASS' : 'FAIL'} |`,
    );
  }
  for (const r of list) {
    const v = passVerdict(r);
    lines.push('', `## ${r.provider}:${r.model}`, '', `Window used: ${r.window} characters.`);
    if (!v.pass) lines.push('', ...v.reasons.map((x) => `- ${x}`));
    lines.push(
      '',
      '| Page | Matched | Expected | Recall | JSON | Extras | Rejected | Missed |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const p of r.pages) {
      lines.push(
        `| ${cell(p.pageId)} | ${p.score.matched} | ${p.score.expected} | ${pct(p.score.recall)} | ${
          p.validJson ? 'valid' : 'invalid'
        } | ${cell(p.score.extras.join(', '))} | ${p.score.rejected} | ${cell(p.score.missed.join(', '))} |`,
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
  const truncated = res.finish_reason === 'length' || res.choices?.[0]?.finish_reason === 'length';
  const input = res.usage?.prompt_tokens;
  const output = res.usage?.completion_tokens;
  const thinking = res.usage?.completion_tokens_details?.reasoning_tokens;
  return {
    text,
    truncated,
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
}

// Models run one after another, pages one after another. A quota or unavailable error stops that model only,
// and that page is never sent to a different model on its behalf. Aborts the whole run at the call or spend cap.
export async function runBenchmark(specs: BenchModelSpec[], pages: BenchPage[], opts: BenchOptions): Promise<BenchResult> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const maxOutputTokens = opts.maxOutputTokens ?? BENCH_MAX_OUTPUT_TOKENS;
  const result: BenchResult = { window: opts.window, models: [], calls: 0, spentUsd: 0, aborted: null };

  for (const spec of specs) {
    const outcome: ModelOutcome = {
      provider: spec.provider,
      model: spec.model,
      run: { provider: spec.provider, model: spec.model, window: opts.window, pages: [] },
      stopped: null,
      errorsByPage: [],
    };
    result.models.push(outcome);
    if (result.aborted) continue;

    for (const page of pages) {
      if (result.calls >= opts.maxCalls) {
        result.aborted = `--max-calls ${opts.maxCalls} reached after ${result.calls} calls`;
        break;
      }
      const shown = Math.min(page.text.length, opts.window);
      const worst = worstCaseMicroUsd(spec.provider, spec.model, shown, maxOutputTokens).micro / 1_000_000;
      if (result.spentUsd + worst > opts.maxUsd) {
        result.aborted = `--max-usd ${opts.maxUsd} would be exceeded (spent about $${result.spentUsd.toFixed(4)}, next call could cost up to $${worst.toFixed(4)})`;
        break;
      }
      result.calls += 1;
      const started = now();
      let reply: RawReply;
      try {
        reply = await spec.call(page, { window: opts.window, maxOutputTokens });
      } catch (err) {
        result.spentUsd += worst; // unknown usage: count the worst case
        const kind = classifyFailure(err);
        const message = redact(err instanceof Error ? err.message : String(err), opts.secrets ?? []);
        if (kind === 'error') {
          outcome.errorsByPage.push({ pageId: page.pageId, message });
          outcome.run.pages.push(failedPage(page.pageId, now() - started));
          log(`  ${spec.model}: error on ${page.pageId}: ${message}`);
          continue;
        }
        outcome.stopped = { kind, message };
        log(`  ${spec.model}: stopped (${kind}): ${message}`);
        break;
      }
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
      });
      log(`  ${spec.model}: ${page.pageId} recall ${pct(score.recall)}${returned === null ? ' (invalid JSON)' : ''}`);
    }
  }
  return result;

  function failedPage(pageId: string, latencyMs: number): PageRun {
    return {
      pageId,
      validJson: false,
      score: scorePage([], [], ''),
      inputTokens: null,
      outputTokens: null,
      thinkingTokens: null,
      latencyMs,
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
        return p.validJson || !page || p.score.expected > 0 ? p : { ...p, score: scorePage(page.expectedNames, [], '', aliases) };
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
    `Window used: ${result.window} characters per page. Pages: ${pages.length}. Calls: ${result.calls}. Estimated spend: $${result.spentUsd.toFixed(4)}.`,
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
    calls: result.calls,
    estimatedSpendUsd: result.spentUsd,
    aborted: result.aborted,
    pages: pages.map((p) => ({ pageId: p.pageId, expected: p.expectedNames.length })),
    models: reportsFor(result, pages, aliases).map((report, i) => ({
      ...report,
      verdict: passVerdict(report),
      stopped: result.models[i].stopped,
      errors: result.models[i].errorsByPage,
    })),
  };
}
