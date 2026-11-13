import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { createLookup, PipelineDeps, runJob } from '../src/server/lineup/pipeline.ts';
import { QuotaLedger } from '../src/server/lineup/quota.ts';
import { makeDocument } from '../src/server/lineup/adapters/common.ts';
import type { ExtractedName } from '../src/server/lineup/gemini.ts';
import type { SourceAdapter } from '../src/server/lineup/types.ts';
import { createGuardedReader, guardedFromGemini } from '../src/server/reader/guardedReader.ts';
import { readReaderConfig } from '../src/server/reader/config.ts';
import { BREAKER_KEY } from '../src/server/reader/guard.ts';
import { ReaderBusyError, type ReaderResult } from '../src/server/reader/types.ts';
import { fakeFetcher } from './fakes.ts';

const usage = { provider: 'gemini' as const, model: 'fake-lite', inputTokens: 10, outputTokens: 10, durationMs: 1 };
const NOW = new Date('2025-06-01T12:00:00Z');

function pagesAdapter(count: number): SourceAdapter {
  return {
    id: 'promoter',
    enabled: () => true,
    async collect() {
      const docs = Array.from({ length: count }, (_, i) =>
        makeDocument(`https://fest.example/p${i}`, 'promoter', `LINEUP page ${i}\nAct${i}A\nAct${i}B`, 'text'),
      );
      return { documents: docs, performers: [], facts: {}, extractionQueue: docs.map((d) => d.id), notes: [] };
    },
  };
}

type Handler = (text: string, n: number) => ReaderResult<ExtractedName[]> | Promise<ReaderResult<ExtractedName[]>>;

async function setup(opts: { pages: number; env?: Record<string, string>; handler: Handler }) {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'reader-pipeline-')));
  const state = { calls: 0, texts: [] as string[] };
  const quota = new QuotaLedger(store, { provider: 'gemini', model: 'fake-lite', dailyLimit: 100, perMinute: 100 });
  const reader = createGuardedReader({
    client: {
      provider: 'gemini',
      model: 'fake-lite',
      async extractPerformers({ text }) {
        state.calls += 1;
        state.texts.push(text);
        return opts.handler(text, state.calls);
      },
      async extractEventDetails() {
        return { ok: true, value: {}, usage };
      },
    },
    store,
    quota,
    config: readReaderConfig(opts.env ?? {}),
    now: () => NOW,
  });
  const deps: PipelineDeps = {
    store,
    fetcher: fakeFetcher({}).fetcher,
    adapters: [pagesAdapter(opts.pages)],
    lateAdapters: [],
    gemini: null,
    quota,
    reader,
    search: null,
    now: () => NOW,
  };
  return { store, state, deps };
}

const okNames = (text: string): ReaderResult<ExtractedName[]> => {
  const m = /Act\d/.exec(text);
  const a = m ? m[0] : 'Act0';
  return { ok: true, value: [{ name: `${a}A`, quote: `${a}A` }], usage };
};

test('per-job call cap parks only that job; another job still reads', async () => {
  const { deps, store } = await setup({ pages: 3, env: { READER_MAX_CALLS_PER_JOB: '2' }, handler: (t) => okNames(t) });
  const a = await runJob(deps, (await createLookup(deps, { eventName: 'Fest', year: 2025 })).id);
  assert.equal(a?.status, 'waiting_quota');
  assert.equal(a?.pendingExtraction.length, 1, 'the third page stays queued');
  assert.equal((await store.getQuota(BREAKER_KEY))?.exhaustedUntil, undefined, 'a job cap never opens the breaker');

  const b = await runJob(deps, (await createLookup(deps, { eventName: 'Other Fest', year: 2025 })).id);
  assert.equal(b?.pendingExtraction.length, 1, 'the other job read its own two pages before its own cap');
  assert.equal(b?.status, 'waiting_quota');
  assert.equal((await store.listPerformerClaims(b!.id)).length, 2);
});

test('an open breaker parks the job with the retry time and makes no call', async () => {
  const { deps, store, state } = await setup({ pages: 1, handler: (t) => okNames(t) });
  await store.setQuota({ key: BREAKER_KEY, used: 5, exhaustedUntil: '2030-01-01T00:00:00.000Z' });
  const job = await runJob(deps, (await createLookup(deps, { eventName: 'Fest', year: 2025 })).id);
  assert.equal(job?.status, 'waiting_quota');
  assert.equal(job?.nextAttemptAt, '2030-01-01T00:00:00.000Z');
  assert.equal(job?.pendingExtraction.length, 1);
  assert.equal(state.calls, 0);
});

test('a busy reader goes through the bounded attempts path and then fails', async () => {
  const { deps, state } = await setup({
    pages: 1,
    handler: () => {
      throw new ReaderBusyError();
    },
  });
  const id = (await createLookup(deps, { eventName: 'Fest', year: 2025 })).id;
  const first = await runJob(deps, id);
  assert.equal(first?.status, 'queued');
  assert.equal(first?.attempts, 1);
  assert.equal((await runJob(deps, id))?.status, 'queued');
  const last = await runJob(deps, id);
  assert.equal(last?.status, 'failed');
  assert.equal(last?.attempts, 3);
  assert.equal(state.calls, 3, 'at most three reads of the page');
  assert.equal(last?.pendingExtraction.length, 1, 'the page is not dropped on an error');
});

test('invalid_json drops that page once, without retry, and the next page is read', async () => {
  const { deps, state } = await setup({
    pages: 2,
    handler: (t, n) => (n === 1 ? { ok: false, reason: 'invalid_json', usage } : okNames(t)),
  });
  const job = await runJob(deps, (await createLookup(deps, { eventName: 'Fest', year: 2025 })).id);
  assert.equal(state.calls, 2);
  assert.equal(job?.attempts, 0);
  assert.equal(job?.status, 'needs_review');
  assert.equal(job?.pendingExtraction.length, 0);
  assert.ok(job!.log.some((l) => l.message.includes('invalid_json')));
  assert.equal(job!.candidate!.performers.length, 1);
});

test('an oversized page is skipped by the guard and the next page is read', async () => {
  // The first page is longer than the input cap; the others fit.
  const { deps, state, store } = await setup({ pages: 2, env: { READER_MAX_INPUT_CHARS: '28' }, handler: (t) => okNames(t) });
  const big: SourceAdapter = {
    id: 'promoter',
    enabled: () => true,
    async collect() {
      const a = makeDocument('https://fest.example/big', 'promoter', `LINEUP big\n${'x'.repeat(60)}\nAct9A`, 'text');
      const b = makeDocument('https://fest.example/small', 'promoter', 'LINEUP\nAct1A', 'text');
      return { documents: [a, b], performers: [], facts: {}, extractionQueue: [a.id, b.id], notes: [] };
    },
  };
  deps.adapters = [big];
  const job = await runJob(deps, (await createLookup(deps, { eventName: 'Fest', year: 2025 })).id);
  assert.equal(state.calls, 1, 'the oversized page never reaches the provider');
  assert.equal(job?.attempts, 0);
  assert.ok(job!.log.some((l) => l.message.includes('input_too_large')));
  assert.deepEqual(job!.candidate!.performers.map((p) => p.name), ['Act1A']);
  const rows = await store.listAiCalls(10);
  assert.ok(rows.some((r) => r.outcome === 'blocked_by_guard'));
});

test('verbatim counts reach the call log; names not on the page are rejected, not counted', async () => {
  const { deps, store } = await setup({
    pages: 1,
    handler: () => ({
      ok: true,
      value: [
        { name: 'Act0A', quote: 'Act0A' },
        { name: 'Act0B', quote: 'Act0B' },
        { name: 'Not On Page', quote: 'Not On Page' },
      ],
      usage,
    }),
  });
  const job = await runJob(deps, (await createLookup(deps, { eventName: 'Fest', year: 2025 })).id);
  assert.deepEqual(job!.candidate!.performers.map((p) => p.name).sort(), ['Act0A', 'Act0B']);
  const [row] = (await store.listAiCalls(10)).filter((r) => r.feature === 'lineup_extract');
  assert.equal(row.namesReturned, 3);
  assert.equal(row.namesVerbatim, 2);
  assert.equal(row.namesRejected, 1);
  assert.equal(row.jobId, job!.id);
});

test('a page over the default 30,000 ceiling is skipped whole, never cut into a window', async () => {
  const { deps, state } = await setup({ pages: 1, handler: (t) => okNames(t) });
  const big: SourceAdapter = {
    id: 'promoter',
    enabled: () => true,
    async collect() {
      const a = makeDocument('https://fest.example/long', 'promoter', `LINEUP\nAct0A\n${'filler text '.repeat(3000)}`, 'text');
      return { documents: [a], performers: [], facts: {}, extractionQueue: [a.id], notes: [] };
    },
  };
  deps.adapters = [big];
  const job = await runJob(deps, (await createLookup(deps, { eventName: 'Fest', year: 2025 })).id);
  assert.equal(state.calls, 0, 'nothing is sent to the provider');
  assert.ok(job!.log.some((l) => l.message.includes('input_too_large')));
});

test('no reader: the pages are skipped with a log line, never read another way', async () => {
  const { deps } = await setup({ pages: 1, handler: (t) => okNames(t) });
  deps.reader = null;
  const job = await runJob(deps, (await createLookup(deps, { eventName: 'Fest', year: 2025 })).id);
  assert.ok(job!.log.some((l) => /reader not configured/i.test(l.message)));
  assert.equal(job?.status, 'no_data');
  assert.equal(job?.pendingExtraction.length, 0);
});

test('a 25,000-character page reaches the model whole through the pipeline, not cut', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'reader-window-')));
  const sent: string[] = [];
  const generator = {
    model: 'fake-lite',
    async generate(a: { contents: string }) {
      sent.push(a.contents);
      return { text: JSON.stringify({ performers: [{ name: 'Lateact', quote: 'Lateact' }] }), promptTokens: 10, candidatesTokens: 10, thoughtsTokens: 0 };
    },
  };
  const quota = new QuotaLedger(store, { provider: 'gemini', model: 'fake-lite', dailyLimit: 100, perMinute: 100 });
  const reader = guardedFromGemini(generator as never, store, quota, () => NOW, readReaderConfig({}));
  const body = `LINEUP\n${'filler text '.repeat(2000)}\nLateact`;
  assert.ok(body.length > 20000 && body.length < 30000);
  const page: SourceAdapter = {
    id: 'promoter',
    enabled: () => true,
    async collect() {
      const d = makeDocument('https://fest.example/huge', 'promoter', body, 'text');
      return { documents: [d], performers: [], facts: {}, extractionQueue: [d.id], notes: [] };
    },
  };
  const deps: PipelineDeps = { store, fetcher: fakeFetcher({}).fetcher, adapters: [page], lateAdapters: [], gemini: null, quota, reader, search: null, now: () => NOW };
  const job = await runJob(deps, (await createLookup(deps, { eventName: 'Fest', year: 2025 })).id);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].length > 20000, `sent ${sent[0].length} chars`);
  assert.ok(sent[0].endsWith('Lateact'));
  assert.deepEqual(job!.candidate!.performers.map((p) => p.name), ['Lateact']);
});
