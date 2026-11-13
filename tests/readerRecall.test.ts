import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildReport, passVerdict, renderMarkdown, scorePage, type ModelReport, type PageRun, type PageScore } from '../src/server/reader/recall';

const PAGE = 'Lineup: Alpha Band, Beta Beat, Gamma Ray and Delta Force. Doors at 6.';
const q = (name: string) => ({ name, quote: name });

test('alias match counts through the alias table', () => {
  const s = scorePage(['Alpha Band'], [q('Delta Force')], PAGE, { 'delta force': 'Alpha Band' });
  assert.equal(s.matched, 1);
  assert.equal(s.recall, 1);
});

test('non-verbatim names are excluded and counted as rejected', () => {
  const s = scorePage(['Alpha Band', 'Beta Beat'], [q('Alpha Band'), q('Beta Beat Orchestra'), { name: 'Beta Beat', quote: 'Beta Beat plays at midnight' }], PAGE);
  assert.equal(s.matched, 1);
  assert.equal(s.rejected, 2);
  assert.deepEqual(s.missed, ['Beta Beat']);
  assert.deepEqual(s.extras, []);
});

test('extras are verbatim names outside the expected set', () => {
  const s = scorePage(['Alpha Band'], [q('Alpha Band'), q('Gamma Ray'), q('gamma ray')], PAGE);
  assert.deepEqual(s.extras, ['Gamma Ray']);
  assert.equal(s.rejected, 0);
});

test('zero expected gives null recall', () => {
  const s = scorePage([], [q('Alpha Band')], PAGE);
  assert.equal(s.recall, null);
  assert.equal(s.expected, 0);
  assert.deepEqual(s.extras, ['Alpha Band']);
});

function page(id: string, matched: number, expected: number, validJson = true): PageRun {
  const score: PageScore = {
    expected,
    matched,
    recall: expected === 0 ? null : matched / expected,
    missed: [],
    extras: [],
    rejected: 0,
  };
  return { pageId: id, validJson, score, inputTokens: 1000, outputTokens: 500, thinkingTokens: 100, latencyMs: 200 };
}

function report(pages: PageRun[]): ModelReport {
  return buildReport({ provider: 'gemini', model: 'gemini-3.5-flash-lite', window: 180000, pages });
}

test('buildReport totals recall, tokens, cost and latency', () => {
  const r = report([page('a', 9, 10), page('b', 18, 20)]);
  assert.equal(r.overallRecall, 27 / 30);
  assert.equal(r.minPageRecall, 0.9);
  assert.equal(r.inputTokens, 2000);
  assert.equal(r.outputTokens, 1000);
  assert.equal(r.thinkingTokens, 200);
  assert.ok(Math.abs((r.costUsd ?? 0) - (2000 * 0.3 + 1000 * 2.5) / 1e6) < 1e-12);
  assert.equal(r.latencyMs, 400);
  assert.equal(r.window, 180000);
});

test('invalid JSON pages are counted and lower validity', () => {
  const r = report([page('a', 5, 5), page('b', 0, 5, false)]);
  assert.equal(r.invalidJsonPages, 1);
  assert.equal(r.jsonValidityPct, 50);
  assert.equal(r.minPageRecall, 0);
});

test('zero-expected pages do not set the page minimum', () => {
  const r = report([page('a', 0, 0), page('b', 5, 5)]);
  assert.equal(r.minPageRecall, 1);
  assert.equal(report([page('a', 0, 0)]).overallRecall, null);
});

test('missing tokens make the totals null', () => {
  const p = { ...page('a', 1, 1), inputTokens: null };
  const r = report([p]);
  assert.equal(r.inputTokens, null);
  assert.equal(r.costUsd, null);
});

test('verdict: overall 90% edge', () => {
  assert.equal(passVerdict(report([page('a', 9, 10)])).pass, true);
  assert.equal(passVerdict(report([page('a', 89, 100)])).pass, false);
});

test('verdict: page floor 70% edge', () => {
  const ok = report([page('a', 7, 10), page('b', 100, 100), page('c', 100, 100)]);
  assert.equal(passVerdict(ok).pass, true);
  const bad = report([page('a', 69, 100), page('b', 1000, 1000)]);
  const v = passVerdict(bad);
  assert.equal(v.pass, false);
  assert.match(v.reasons.join(' '), /under 70%/);
});

test('verdict: invalid JSON allowance scales with page count', () => {
  const ten = (invalid: number) =>
    report(Array.from({ length: 10 }, (_, i) => page(`p${i}`, 10, 10, i >= invalid)));
  assert.equal(passVerdict(ten(1)).pass, true);
  assert.equal(passVerdict(ten(2)).pass, false);
  assert.equal(passVerdict(ten(2)).maxInvalidPages, 1);
  // Fewer than 10 pages allow none.
  const eight = report(Array.from({ length: 8 }, (_, i) => page(`p${i}`, 0, 0, i !== 0)));
  assert.equal(passVerdict(eight).maxInvalidPages, 0);
  assert.equal(passVerdict(eight).pass, false);
});

test('verdict: nothing expected cannot pass', () => {
  assert.equal(passVerdict(report([page('a', 0, 0)])).pass, false);
});

test('renderMarkdown has a summary table, window and per-page rows', () => {
  const r = report([page('page-1', 9, 10), page('page-2', 10, 10)]);
  const md = renderMarkdown(r);
  assert.match(md, /^# Recall benchmark/);
  assert.match(md, /\| Model \| Window \| Recall \| Min page \| JSON valid \|/);
  assert.match(md, /gemini:gemini-3\.5-flash-lite \| 180000 \| 95\.0% \| 90\.0% \| 100% \|/);
  assert.match(md, /Window used: 180000 characters\./);
  assert.match(md, /\| page-1 \| 9 \| 10 \| 90\.0% \| valid \|/);
  assert.match(md, /PASS/);
  assert.ok(md.endsWith('\n'));
});
