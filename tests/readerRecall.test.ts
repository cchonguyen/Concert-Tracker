import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildReport, invalidReason, passVerdict, renderMarkdown, scorePage, type ModelReport, type PageRun, type PageScore } from '../src/server/reader/recall';

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

test('expected names not on the page are counted, listed (max 10) and excluded from recallOnPage', () => {
  const expected = ['Alpha Band', 'Beta Beat', ...Array.from({ length: 12 }, (_, i) => `Ghost Act ${i}`)];
  const s = scorePage(expected, [q('Alpha Band')], PAGE);
  assert.equal(s.expected, 14);
  assert.equal(s.matched, 1);
  assert.equal(s.notOnPage, 12);
  assert.equal(s.notOnPageNames.length, 10);
  assert.equal(s.expectedOnPage, 2);
  assert.equal(s.recall, 1 / 14);
  assert.equal(s.recallOnPage, 1 / 2);
  assert.deepEqual(s.missed.slice(0, 1), ['Beta Beat']);
});

test('alias counts an expected name as on the page; none on page gives null recallOnPage', () => {
  const s = scorePage(['Delta Force'], [], PAGE, { 'delta force': 'Delta Force' });
  assert.equal(s.notOnPage, 0);
  assert.equal(scorePage(['Nobody Here'], [], PAGE).recallOnPage, null);
});

test('returned names are split with readActName before matching', () => {
  const text = 'Lineup: JVNA B2B CHYL, MADEON (DJ SET), Alpha Band.';
  const s = scorePage(['Jvna', 'Chyl', 'Madeon'], [q('JVNA B2B CHYL'), q('MADEON (DJ SET)')], text);
  assert.equal(s.matched, 3);
  assert.equal(s.recall, 1);
  assert.deepEqual(s.extras, []);
  assert.equal(s.rejected, 0);
});

test('a part not in the quote is still rejected; whole-name matches still work', () => {
  const text = 'Lineup: JVNA B2B CHYL, Alpha Band.';
  const s = scorePage(['Jvna', 'Alpha Band'], [{ name: 'JVNA B2B CHYL', quote: 'JVNA' }, q('Alpha Band')], text);
  assert.equal(s.matched, 2);
  assert.equal(s.rejected, 1);
  const whole = scorePage(['Madeon (DJ Set)'], [q('Madeon (DJ Set)')], 'Madeon (DJ Set) plays');
  assert.equal(whole.matched, 1);
});

function page(id: string, matched: number, expected: number, validJson = true, expectedOnPage = expected): PageRun {
  const score: PageScore = {
    expected,
    matched,
    recall: expected === 0 ? null : matched / expected,
    missed: [],
    extras: [],
    rejected: 0,
    expectedOnPage,
    recallOnPage: expectedOnPage === 0 ? null : matched / expectedOnPage,
    notOnPage: expected - expectedOnPage,
    notOnPageNames: [],
  };
  return { pageId: id, validJson, score, inputTokens: 1000, outputTokens: 500, thinkingTokens: 100, latencyMs: 200, finishReason: 'STOP', truncated: false, retries: 0 };
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

test('verdict uses recallOnPage, not recall against all expected', () => {
  // 50 of 100 expected, but only 50 are on the page and all 50 matched.
  const r = report([page('a', 50, 100, true, 50)]);
  assert.equal(r.overallRecall, 0.5);
  assert.equal(r.overallRecallOnPage, 1);
  assert.equal(passVerdict(r).pass, true);
  // On-page recall below the mark still fails.
  const bad = report([page('a', 40, 100, true, 50)]);
  assert.equal(passVerdict(bad).pass, false);
  assert.match(passVerdict(bad).reasons.join(' '), /recall on page 80\.0%/);
  // Nothing on any page: cannot pass.
  assert.equal(passVerdict(report([page('a', 0, 5, true, 0)])).pass, false);
});

test('report counts truncated pages and retried calls; markdown shows the reason', () => {
  const t = { ...page('t', 0, 5, false), truncated: true, finishReason: 'MAX_TOKENS', retries: 2 };
  const r = buildReport({ provider: 'gemini', model: 'gemini-3.5-flash-lite', window: 1000, maxOutputTokens: 4096, pages: [t, page('u', 0, 5, false)] });
  assert.equal(r.truncatedPages, 1);
  assert.equal(r.retriedCalls, 2);
  assert.equal(invalidReason(t, 4096), 'truncated at 4096 output tokens');
  assert.equal(invalidReason(r.pages[1]), 'unparseable');
  const md = renderMarkdown(r);
  assert.match(md, /invalid \(truncated at 4096 output tokens\)/);
  assert.match(md, /invalid \(unparseable\)/);
  assert.match(md, /Max output tokens: 4096/);
  assert.match(md, /ground-truth issue, not a model miss/);
});

test('verdict: nothing expected cannot pass', () => {
  assert.equal(passVerdict(report([page('a', 0, 0)])).pass, false);
});

test('renderMarkdown has a summary table, window and per-page rows', () => {
  const r = report([page('page-1', 9, 10), page('page-2', 10, 10)]);
  const md = renderMarkdown(r);
  assert.match(md, /^# Recall benchmark/);
  assert.match(md, /\| Model \| Window \| Recall \| Recall on page \| Min page \(on page\) \| JSON valid \|/);
  assert.match(md, /gemini:gemini-3\.5-flash-lite \| 180000 \| 95\.0% \| 95\.0% \| 90\.0% \| 100% \|/);
  assert.match(md, /Window used: 180000 characters\./);
  assert.match(md, /\| page-1 \| 1 \| 9 \| 10 \| 10 \| 90\.0% \| 90\.0% \| valid \|/);
  assert.match(md, /PASS/);
  assert.ok(md.endsWith('\n'));
});
