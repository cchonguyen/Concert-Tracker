import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BenchHttpError,
  classifyFailure,
  parseBenchArgs,
  parseWorkersAiEnvelope,
  reportsFor,
  runBenchmark,
  selectPages,
  workersAiErrorCode,
} from '../src/server/reader/recall.ts';
import type { BenchEdition, BenchModelSpec, BenchPage, RawReply } from '../src/server/reader/recall.ts';

const ed = (key: string, date: string, docs: Array<[string, number, boolean?]>): BenchEdition => ({
  key,
  name: key,
  year: 2025,
  date,
  expectedNames: ['Alpha', 'Beta'],
  documents: docs.map(([id, len, has]) => ({ id, url: `https://x/${id}`, text: 'a'.repeat(len), hasLineup: has ?? true })),
});

test('parseBenchArgs reads flags and rejects bad ones', () => {
  const a = parseBenchArgs(['--fixture', 'f.json', '--max-calls', '5', '--max-usd', '0.25', '--limit', '3', '--models', 'a, b']);
  assert.equal(a.fixture, 'f.json');
  assert.equal(a.maxCalls, 5);
  assert.equal(a.maxUsd, 0.25);
  assert.equal(a.limit, 3);
  assert.deepEqual(a.models, ['a', 'b']);
  assert.equal(parseBenchArgs([]).window, 180000);
  assert.throws(() => parseBenchArgs(['--max-usd', 'x']));
  assert.throws(() => parseBenchArgs(['--nope']));
});

test('selectPages: newest first, one per edition, largest always included', () => {
  const editions = [
    ed('e1', '2020-01-01', [['d1', 900000], ['d1b', 10]]), // oldest but largest
    ed('e2', '2025-01-01', [['d2', 100], ['d2b', 300]]),
    ed('e3', '2024-01-01', [['d3', 200]]),
    ed('e4', '2023-01-01', [['d4', 50, false]]), // no lineup: skipped
    ed('e5', '2022-01-01', [['d5', 60]]),
  ];
  const pages = selectPages(editions, 3);
  assert.equal(pages.length, 3);
  assert.equal(new Set(pages.map((p) => p.editionKey)).size, 3);
  assert.ok(pages.some((p) => p.editionKey === 'e1'), 'largest included');
  assert.equal(pages[0].editionKey, 'e2');
  assert.equal(pages[0].pageId, 'e2 | https://x/d2b'); // largest doc of that edition
  assert.ok(!pages.some((p) => p.editionKey === 'e4'));
  assert.equal(selectPages(editions).length, 4);
});

const page = (id: string): BenchPage => ({ pageId: id, editionKey: id, eventName: id, year: 2025, text: 'Alpha\nBeta', expectedNames: ['Alpha', 'Beta'] });
const good: RawReply = {
  text: JSON.stringify({ performers: [{ name: 'Alpha', quote: 'Alpha' }, { name: 'Beta', quote: 'Beta' }] }),
  truncated: false,
  inputTokens: 100,
  outputTokens: 50,
  thinkingTokens: 0,
};
const spec = (model: string, call: BenchModelSpec['call']): BenchModelSpec => ({ provider: 'gemini', model, call });

test('runBenchmark scores pages', async () => {
  const r = await runBenchmark([spec('m1', async () => good)], [page('p1')], { window: 1000, maxCalls: 10, maxUsd: 10 });
  assert.equal(r.aborted, null);
  assert.equal(reportsFor(r, [page('p1')])[0].overallRecall, 1);
});

test('runBenchmark aborts on --max-calls and says why', async () => {
  let n = 0;
  const r = await runBenchmark([spec('m1', async () => (n++, good)), spec('m2', async () => (n++, good))], [page('p1'), page('p2')], {
    window: 1000,
    maxCalls: 3,
    maxUsd: 10,
  });
  assert.equal(n, 3);
  assert.match(r.aborted ?? '', /--max-calls 3/);
});

test('runBenchmark aborts before a call that could pass --max-usd', async () => {
  let n = 0;
  const r = await runBenchmark([spec('m1', async () => (n++, good))], [page('p1')], { window: 1000, maxCalls: 10, maxUsd: 0.0001 });
  assert.equal(n, 0);
  assert.match(r.aborted ?? '', /--max-usd/);
});

test('quota stops that model only and never retries the page on another model', async () => {
  const seen: string[] = [];
  const quota = new BenchHttpError(402, 'payment required');
  const r = await runBenchmark(
    [
      spec('m1', async (p) => {
        seen.push(`m1:${p.pageId}`);
        throw quota;
      }),
      spec('m2', async (p) => (seen.push(`m2:${p.pageId}`), good)),
    ],
    [page('p1'), page('p2')],
    { window: 1000, maxCalls: 10, maxUsd: 10 },
  );
  assert.deepEqual(seen, ['m1:p1', 'm2:p1', 'm2:p2']);
  assert.equal(r.models[0].stopped?.kind, 'quota');
  assert.equal(r.models[1].stopped, null);
  assert.equal(r.aborted, null);
});

test('an unavailable model is reported, not fatal; invalid JSON counts against recall', async () => {
  const r = await runBenchmark(
    [spec('gone', async () => { throw new BenchHttpError(404, 'model not found'); }), spec('bad', async () => ({ ...good, text: 'nope' }))],
    [page('p1')],
    { window: 1000, maxCalls: 10, maxUsd: 10 },
  );
  assert.equal(r.models[0].stopped?.kind, 'unavailable');
  const rep = reportsFor(r, [page('p1')])[1];
  assert.equal(rep.invalidJsonPages, 1);
  assert.equal(rep.overallRecall, 0);
});

test('classifyFailure', () => {
  assert.equal(classifyFailure(new BenchHttpError(429, 'Your prepayment credits are depleted')), 'quota');
  assert.equal(classifyFailure(new BenchHttpError(429, 'daily allowance 3036', 3036)), 'quota');
  assert.equal(classifyFailure(new BenchHttpError(500, 'boom')), 'error');
});

test('Workers AI envelopes: response string, choices, REST result wrapper, truncation, usage', () => {
  const a = parseWorkersAiEnvelope({ result: { response: '{"performers":[]}', usage: { prompt_tokens: 10, completion_tokens: 3 } }, success: true });
  assert.equal(a.text, '{"performers":[]}');
  assert.equal(a.inputTokens, 10);
  assert.equal(a.outputTokens, 3);
  assert.equal(a.truncated, false);
  const b = parseWorkersAiEnvelope({ result: { choices: [{ message: { content: 'hi' }, finish_reason: 'length' }] } });
  assert.equal(b.text, 'hi');
  assert.equal(b.truncated, true);
  assert.equal(b.inputTokens, null);
  const c = parseWorkersAiEnvelope({ response: { performers: [] }, finish_reason: 'length' });
  assert.equal(c.text, '{"performers":[]}');
  assert.equal(c.truncated, true);
  assert.equal(parseWorkersAiEnvelope({}).text, '');
  assert.equal(workersAiErrorCode({ errors: [{ code: 3040 }] }), 3040);
  assert.equal(workersAiErrorCode(null, 'AiError: 3036: limit'), 3036);
});
