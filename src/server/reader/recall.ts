import { canonicalName } from '../lineup/merge';
import { isVerbatim, normalizeName } from '../lineup/text';
import { estimateCostUsd } from './pricing';
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
