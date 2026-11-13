import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { createLookup, PipelineDeps, runJob } from '../src/server/lineup/pipeline.ts';
import { confirmLookup } from '../src/server/lineup/learning.ts';
import { newEvent, startLineupLookup } from '../src/server/events/service.ts';
import { GeminiClient } from '../src/server/lineup/gemini.ts';
import { QuotaExhaustedError, QuotaLedger } from '../src/server/lineup/quota.ts';
import { makeDocument } from '../src/server/lineup/adapters/common.ts';
import { SourceAdapter } from '../src/server/lineup/types.ts';
import { createGuardedReader } from '../src/server/reader/guardedReader.ts';
import { BREAKER_KEY } from '../src/server/reader/guard.ts';
import { readReaderConfig } from '../src/server/reader/config.ts';
import { fakeFetcher } from './fakes.ts';

// Wraps a fake GeminiClient as a guarded reader (the pipeline holds only a reader).
function readerFor(gemini: GeminiClient, store: FileLineupStore, quota: QuotaLedger, now: () => Date) {
  const usage = { provider: 'gemini' as const, model: gemini.model, inputTokens: 10, outputTokens: 10, durationMs: 1 };
  return createGuardedReader({
    client: {
      provider: 'gemini',
      model: gemini.model,
      async extractPerformers(a) {
        return { ok: true, value: await gemini.extractPerformers(a), usage };
      },
      async extractEventDetails() {
        return { ok: true, value: {}, usage };
      },
    },
    store,
    quota,
    config: readReaderConfig({}),
    now,
  });
}

const PAGE = 'LINEUP\nFRIDAY\nKaskade\nMain Stage\nDom Dolla\nSATURDAY\nEric Prydz\nTickets';

const crowdSource: SourceAdapter = {
  id: 'clashfinder',
  enabled: () => true,
  async collect() {
    const doc = makeDocument('https://clashfinder.com/s/fest25/', 'clashfinder', '{"acts":["Kaskade","Main Stage"]}', 'json');
    return {
      documents: [doc],
      performers: ['Kaskade', 'Main Stage'].map((name) => ({
        documentId: doc.id,
        sourceType: 'clashfinder' as const,
        sourceUrl: doc.url,
        name,
        quotedSpan: name,
        evidence: 'crowd' as const,
        extractor: 'clashfinder',
        extractorVersion: 'test',
      })),
      facts: { startDate: [{ value: '2025-05-16', sourceType: 'clashfinder' as const, sourceUrl: doc.url }] },
      extractionQueue: [],
      notes: ['crowd source ran'],
    };
  },
};

const promoterSource: SourceAdapter = {
  id: 'promoter',
  enabled: () => true,
  async collect() {
    const doc = makeDocument('https://fest.example/lineup', 'promoter', PAGE, 'text');
    return { documents: [doc], performers: [], facts: {}, extractionQueue: [doc.id], notes: [] };
  },
};

function fakeGemini(state: { quotaOut: boolean; calls: number }): GeminiClient {
  return {
    model: 'fake-lite',
    async extractPerformers() {
      state.calls += 1;
      if (state.quotaOut) throw new QuotaExhaustedError(new Date('2030-01-01'), 'Gemini daily limit reached');
      return [
        { name: 'Kaskade', quote: 'Kaskade' },
        { name: 'Dom Dolla', quote: 'Dom Dolla' },
        { name: 'Eric Prydz', quote: 'Eric Prydz' },
        { name: 'Skrillex', quote: 'Skrillex' }, // not on the page: must be dropped
        { name: 'Main Stage', quote: 'Main Stage' },
      ];
    },
    async extractEventDetails() {
      return {};
    },
    async discoverLineupUrls() {
      return [];
    },
  };
}

async function setup() {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'pipeline-')));
  const state = { quotaOut: false, calls: 0 };
  const gemini = fakeGemini(state);
  const quota = new QuotaLedger(store, { provider: 'gemini', model: 'fake-lite', dailyLimit: 100, perMinute: 100 });
  const now = () => new Date('2025-06-01T12:00:00Z');
  const deps: PipelineDeps = {
    store,
    fetcher: fakeFetcher({}).fetcher,
    adapters: [crowdSource, promoterSource],
    lateAdapters: [],
    gemini,
    quota,
    reader: readerFor(gemini, store, quota, now),
    search: null,
    now,
  };
  return { store, state, deps };
}

test('quota exhaustion parks the job with sources intact, then resumes', async () => {
  const { store, state, deps } = await setup();
  state.quotaOut = true;
  const job = await createLookup(deps, { eventName: 'Fest', year: 2025 });
  const parked = await runJob(deps, job.id);
  assert.equal(parked?.status, 'waiting_quota');
  assert.equal(parked?.stage, 'extract');
  assert.equal(parked?.nextAttemptAt, '2030-01-01T00:00:00.000Z');
  assert.equal(parked?.pendingExtraction.length, 1);
  assert.equal(parked?.candidate, undefined); // nothing guessed
  assert.equal((await store.listPerformerClaims(job.id)).length, 2); // crowd source kept

  // A provider quota error opens the shared breaker until the retry time; "retry now" does not bypass it.
  state.quotaOut = false;
  const stillParked = await runJob(deps, job.id);
  assert.equal(stillParked?.status, 'waiting_quota');
  const blocked = await runJob(deps, job.id, { force: true });
  assert.equal(blocked?.status, 'waiting_quota');
  assert.equal(state.calls, 1, 'no second provider call while the breaker is open');
  await store.setQuota({ key: BREAKER_KEY, used: 0 }); // the cool-down has passed
  const done = await runJob(deps, job.id, { force: true }); // person pressed retry

  assert.equal(done?.status, 'needs_review');
  const names = done!.candidate!.performers.map((p) => p.name).sort();
  assert.deepEqual(names, ['Dom Dolla', 'Eric Prydz', 'Kaskade', 'Main Stage']);
  assert.ok(!names.includes('Skrillex'), 'hallucinated name must be rejected');
  const kaskade = done!.candidate!.performers.find((p) => p.name === 'Kaskade')!;
  assert.equal(kaskade.sources.length, 2);
  assert.equal(done!.candidate!.facts.startDate, '2025-05-16');
});

test('review teaches aliases, the blocklist, source scores and the cache', async () => {
  const { store, state, deps } = await setup();
  const logged = { ...newEvent('Fest 2025', deps.now()), seen: [{ key: 'opening act', name: 'Opening Act', from: 'you' as const }] };
  await store.putEvent(logged);
  const started = await startLineupLookup(deps, logged, 'https://fest.example/lineup');
  const job = (await runJob(deps, started.job.id))!;
  const byName = (n: string) => job.candidate!.performers.find((p) => p.name === n)!;

  const result = await confirmLookup(store, job, {
    performers: [
      { key: byName('Kaskade').key, name: 'Kaskade', accepted: true, seen: true },
      { key: byName('Dom Dolla').key, name: 'Dom Dolla', accepted: true, seen: false },
      { key: byName('Eric Prydz').key, name: 'Eric Prydz', accepted: true, seen: true },
      { key: byName('Main Stage').key, name: 'Main Stage', accepted: false, rejectReason: 'not_an_act', seen: false },
      { name: 'Surprise Guest DJ', accepted: true, seen: true },
    ],
  });

  assert.equal(result.edition.status, 'confirmed');
  assert.equal(result.edition.performances.length, 4);
  // Facts default to the event's, with the date the sources cited.
  assert.equal(result.edition.name, 'Fest');
  assert.equal(result.edition.startDate, '2025-05-16');
  // Seen acts: what was ticked, plus the act added by hand that the lineup lacks.
  assert.deepEqual(result.event?.seen.map((s) => s.key).sort(), ['eric prydz', 'kaskade', 'opening act', 'surprise guest dj']);
  assert.equal(result.event?.seen.find((s) => s.key === 'kaskade')?.from, 'lineup');
  assert.equal((await store.getEvent(logged.id))?.editionId, result.edition.id);
  const stats = await store.getSourceStats();
  assert.ok(stats.some((s) => s.sourceType === 'clashfinder' && s.scope === 'fest' && s.rejected === 1));
  assert.equal((await store.getBlocklist(['clashfinder.com']))[0]?.normalized, 'main stage');
  assert.equal((await store.getExamples('fest.example')).length, 1);
  assert.equal((await store.getSeries('fest'))?.lineupUrl, 'https://fest.example/lineup');

  // Second lookup of the same edition: served from the database, no calls.
  const before = state.calls;
  const again = await createLookup(deps, { eventName: 'Fest', year: 2025 });
  assert.equal(again.status, 'needs_review');
  assert.equal(again.candidate?.cached, true);
  assert.equal(again.candidate?.performers.length, 4);
  assert.equal(state.calls, before);
});

test('a blocklisted string is dropped once rejected twice on that site', async () => {
  const { store, deps } = await setup();
  await store.bumpBlocklist([{ domain: 'clashfinder.com', normalized: 'main stage' }]);
  await store.bumpBlocklist([{ domain: 'fest.example', normalized: 'main stage' }]);
  await store.bumpBlocklist([{ domain: 'fest.example', normalized: 'main stage' }]);
  await store.bumpBlocklist([{ domain: 'clashfinder.com', normalized: 'main stage' }]);
  const job = (await runJob(deps, (await createLookup(deps, { eventName: 'Fest', year: 2026 })).id))!;
  assert.ok(!job.candidate!.performers.some((p) => p.name === 'Main Stage'));
  assert.equal(job.candidate!.droppedCount, 2);
});

test('input validation requires a name and year', async () => {
  const { deps } = await setup();
  await assert.rejects(createLookup(deps, { eventName: '', year: 2025 }), /Event name/);
  await assert.rejects(createLookup(deps, { eventName: 'Fest', year: 25 }), /year/);
});

test('web search only reads pages that name the event and year, and keeps only quoted names', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'search-')));
  const relevant = '<html><body><h1>Sun Soaked 2026</h1><p>Lineup: Kaskade, Dom Dolla</p></body></html>';
  const otherYear = '<html><body><h1>Sun Soaked 2027</h1><p>Lineup: Somebody Else</p></body></html>';
  const { fetcher, calls } = fakeFetcher({
    'https://news.example/sun-soaked-2026': { body: relevant },
    'https://fest.example/next-year': { body: otherYear },
  });
  let extractedFrom: string[] = [];
  const gemini: GeminiClient = {
    model: 'fake-lite',
    async extractPerformers({ text }) {
      extractedFrom.push(text);
      return [
        { name: 'Kaskade', quote: 'Lineup: Kaskade, Dom Dolla' },
        { name: 'Dom Dolla', quote: 'Kaskade, Dom Dolla' },
        { name: 'Zedd', quote: 'Zedd' }, // not on the page
      ];
    },
    async extractEventDetails() {
      return {};
    },
    async discoverLineupUrls() {
      throw new Error('grounded search must not be used when another provider is set');
    },
  };
  const searchQuota = new QuotaLedger(store, { provider: 'gemini', model: 'fake-lite', dailyLimit: 100, perMinute: 100 });
  const searchNow = () => new Date('2026-10-01T12:00:00Z');
  const deps: PipelineDeps = {
    store,
    fetcher,
    adapters: [],
    lateAdapters: [],
    gemini,
    quota: searchQuota,
    reader: readerFor(gemini, store, searchQuota, searchNow),
    search: {
      id: 'brave',
      usesGeminiQuota: false,
      async findLineupUrls() {
        return ['https://fest.example/next-year', 'https://news.example/sun-soaked-2026', 'https://down.example/x'];
      },
    },
    now: () => new Date('2026-10-01T12:00:00Z'),
  };
  const job = await runJob(deps, (await createLookup(deps, { eventName: 'Sun Soaked', year: 2026 })).id);
  assert.equal(job?.status, 'needs_review');
  assert.deepEqual(job!.candidate!.performers.map((p) => p.name).sort(), ['Dom Dolla', 'Kaskade']);
  assert.equal(extractedFrom.length, 1, 'only the page about this edition is sent to Gemini');
  assert.ok(job!.candidate!.performers.every((p) => p.sources.some((s) => s.sourceUrl === 'https://news.example/sun-soaked-2026' && s.sourceType === 'discovered')));
  assert.ok(calls.includes('https://down.example/x'));
  assert.ok(job!.log.some((l) => l.message.includes('Skipped https://fest.example/next-year')));
});

test('web search reads the event site first, as a promoter page, even if stored earlier as discovered', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'search-official-')));
  const official = '<h1>Sun Soaked 2026</h1><p>Friday: ATICA. Saturday: Cut Snake</p>';
  const { fetcher } = fakeFetcher({ 'https://sunsoaked.promoter.example/': { body: official } });
  // Stored by an earlier run as a plain search result.
  await store.putDocument(makeDocument('https://sunsoaked.promoter.example/', 'discovered', 'Sun Soaked 2026 Friday: ATICA. Saturday: Cut Snake', 'text'));
  const read: string[] = [];
  const gemini: GeminiClient = {
    model: 'fake-lite',
    async extractPerformers({ text }) {
      read.push(text);
      return [
        { name: 'ATICA', quote: 'Friday: ATICA' },
        { name: 'Cut Snake', quote: 'Saturday: Cut Snake' },
      ];
    },
    async extractEventDetails() {
      return {};
    },
    async discoverLineupUrls() {
      return [];
    },
  };
  const urls = Array.from({ length: 7 }, (_, i) => `https://other${i}.example/x`).concat('https://sunsoaked.promoter.example/');
  const searchQuota = new QuotaLedger(store, { provider: 'gemini', model: 'fake-lite', dailyLimit: 100, perMinute: 100 });
  const searchNow = () => new Date('2026-10-01T12:00:00Z');
  const deps: PipelineDeps = {
    store,
    fetcher,
    adapters: [],
    lateAdapters: [],
    gemini,
    quota: searchQuota,
    reader: readerFor(gemini, store, searchQuota, searchNow),
    search: { id: 'brave', usesGeminiQuota: false, findLineupUrls: async () => urls },
    now: () => new Date('2026-10-01T12:00:00Z'),
  };
  const job = await runJob(deps, (await createLookup(deps, { eventName: 'Sun Soaked', year: 2026 })).id);
  assert.ok(read[0].includes('ATICA'), 'the event site is read first');
  assert.deepEqual(job!.candidate!.performers.map((p) => p.name).sort(), ['Atica', 'Cut Snake']); // all caps on the page, put in Proper Case
  assert.ok(job!.candidate!.performers.every((p) => p.sources.every((s) => s.sourceType === 'promoter')));

  // Confirming teaches the series where its lineup lives.
  await confirmLookup(store, job!, {
    facts: { name: 'Sun Soaked 2026' },
    performers: job!.candidate!.performers.map((p) => ({ key: p.key, name: p.name, accepted: true, seen: false })),
  });
  assert.equal((await store.getSeries('sun-soaked'))?.lineupUrl, 'https://sunsoaked.promoter.example/');
});

test('confirming a large lineup makes the same few store writes as a small one', async () => {
  // Workers Free allows 50 subrequests per request; per-act writes broke
  // confirming festival lineups (bumpSourceStat "Too many subrequests").
  const inner = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'confirm-')));
  const calls: string[] = [];
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function'
        ? (...args: unknown[]) => {
            calls.push(String(prop));
            return v.apply(target, args);
          }
        : v;
    },
  });
  const confirmWith = async (acts: number) => {
    const names = Array.from({ length: acts }, (_, i) => `Act ${i}`);
    const performers = names.map((name) => ({
      key: name.toLowerCase(),
      name,
      days: [],
      stages: [],
      status: 'billed' as const,
      confidence: 0.9,
      flagged: false,
      sources: [
        { sourceType: 'clashfinder' as const, sourceUrl: 'https://clashfinder.com/s/fest/', quotedSpan: name, evidence: 'crowd' as const, extractor: 'clashfinder' },
        { sourceType: 'promoter' as const, sourceUrl: 'https://fest.example/', quotedSpan: name, evidence: 'billed' as const, extractor: 'gemini:x' },
      ],
    }));
    const job = {
      id: `job-${acts}`,
      kind: 'lineup' as const,
      input: { eventName: `Fest ${acts}`, year: 2025 },
      editionKey: `fest-${acts}/2025`,
      status: 'needs_review' as const,
      stage: 'done' as const,
      attempts: 1,
      pendingExtraction: [],
      discoveryDone: true,
      facts: {},
      candidate: { editionKey: `fest-${acts}/2025`, cached: false, facts: { sources: {} }, performers, droppedCount: 0 },
      log: [],
      createdAt: '2025-06-01',
      updatedAt: '2025-06-01',
    };
    await inner.createJob(job);
    calls.length = 0;
    await confirmLookup(store, job, {
      facts: { name: `Fest ${acts}` },
      performers: performers.map((p, i) => ({
        key: p.key,
        name: i % 7 === 0 ? `${p.name}!` : p.name, // some renames
        accepted: i % 5 !== 0, // some rejections
        rejectReason: 'not_an_act' as const,
        seen: i % 3 === 0,
      })),
    });
    return calls.length;
  };
  const small = await confirmWith(5);
  const large = await confirmWith(150);
  assert.equal(large, small);
  assert.ok(large < 25, `${large} store calls`);
});

test('one step at a time: a Worker run stays small and the lookup still finishes', async () => {
  // A whole lookup in one Worker invocation went past the 50-subrequest
  // limit after reading three pages and was left "running" forever.
  const { store, deps } = await setup();
  const twoPages: SourceAdapter = {
    id: 'promoter',
    enabled: () => true,
    async collect() {
      const a = makeDocument('https://fest.example/lineup', 'promoter', PAGE, 'text');
      const b = makeDocument('https://fest.example/lineup2', 'promoter', `${PAGE}\nmore`, 'text');
      return { documents: [a, b], performers: [], facts: {}, extractionQueue: [a.id, b.id], notes: [] };
    },
  };
  deps.adapters = [crowdSource, twoPages];
  const job = await createLookup(deps, { eventName: 'Fest', year: 2025 });
  const stages: string[] = [];
  let current = job;
  for (let i = 0; i < 10 && current.status === 'queued'; i++) {
    current = (await runJob(deps, job.id, { oneStep: true }))!;
    stages.push(current.stage);
  }
  // collect, one page, the other page, choose the next stage, merge.
  assert.deepEqual(stages, ['extract', 'extract', 'extract', 'merge', 'done']);
  assert.equal(current.status, 'needs_review');
  assert.equal(current.pendingExtraction.length, 0);
  assert.ok((await store.listPerformerClaims(job.id)).length > 0);
});

test('a run cut off mid-way is picked up again once stale, and not before', async () => {
  const { store, deps } = await setup();
  const job = await createLookup(deps, { eventName: 'Fest', year: 2025 });
  await store.updateJob({ ...job, status: 'running', stage: 'collect', updatedAt: '2025-06-01T11:55:00Z' });
  assert.equal((await store.dueJobs(deps.now(), 5)).length, 0);
  assert.equal((await runJob(deps, job.id))?.status, 'running'); // another run may still be going

  await store.updateJob({ ...job, status: 'running', stage: 'collect', updatedAt: '2025-06-01T11:40:00Z' });
  assert.deepEqual((await store.dueJobs(deps.now(), 5)).map((j) => j.id), [job.id]);
  const done = await runJob(deps, job.id);
  assert.equal(done?.status, 'needs_review');
});

test('a second lookup of the same edition reuses the page reading instead of calling Gemini', async () => {
  const { store, state, deps } = await setup();
  const first = await runJob(deps, (await createLookup(deps, { eventName: 'Fest', year: 2025 })).id);
  assert.equal(state.calls, 1);
  const again = await runJob(deps, (await createLookup(deps, { eventName: 'Fest', year: 2025 })).id);
  assert.equal(state.calls, 1, 'no second Gemini call for the same page');
  assert.equal(again?.status, 'needs_review');
  assert.deepEqual(
    again!.candidate!.performers.map((p) => p.name).sort(),
    first!.candidate!.performers.map((p) => p.name).sort(),
  );
  assert.ok(again!.log.some((l) => l.message.includes('no Gemini call')));
  // Each job keeps its own claims, so the reuse does not double them.
  assert.equal((await store.listPerformerClaims(again!.id)).length, (await store.listPerformerClaims(first!.id)).length);

  // The same page for a different edition is read again.
  await runJob(deps, (await createLookup(deps, { eventName: 'Fest', year: 2024 })).id);
  assert.equal(state.calls, 2);
});
