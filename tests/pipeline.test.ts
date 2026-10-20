import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { createLookup, PipelineDeps, runJob } from '../src/server/lineup/pipeline.ts';
import { confirmLookup } from '../src/server/lineup/learning.ts';
import { GeminiClient } from '../src/server/lineup/gemini.ts';
import { QuotaExhaustedError, QuotaLedger } from '../src/server/lineup/quota.ts';
import { makeDocument } from '../src/server/lineup/adapters/common.ts';
import { SourceAdapter } from '../src/server/lineup/types.ts';
import { fakeFetcher } from './fakes.ts';

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
    async discoverLineupUrls() {
      return [];
    },
  };
}

async function setup() {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'pipeline-')));
  const state = { quotaOut: false, calls: 0 };
  const deps: PipelineDeps = {
    store,
    fetcher: fakeFetcher({}).fetcher,
    adapters: [crowdSource, promoterSource],
    lateAdapters: [],
    gemini: fakeGemini(state),
    quota: new QuotaLedger(store, { provider: 'gemini', model: 'fake-lite', dailyLimit: 100, perMinute: 100 }),
    allowDiscovery: true,
    now: () => new Date('2025-06-01T12:00:00Z'),
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

  state.quotaOut = false;
  const stillParked = await runJob(deps, job.id); // worker run respects the pause
  assert.equal(stillParked?.status, 'waiting_quota');
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
  const job = (await runJob(deps, (await createLookup(deps, { eventName: 'Fest', year: 2025, lineupUrl: 'https://fest.example/lineup' })).id))!;
  const byName = (n: string) => job.candidate!.performers.find((p) => p.name === n)!;

  const result = await confirmLookup(store, job, {
    facts: { name: 'Fest 2025', startDate: '2025-05-16' },
    performers: [
      { key: byName('Kaskade').key, name: 'Kaskade', accepted: true, seen: true },
      { key: byName('Dom Dolla').key, name: 'Dom Dolla', accepted: true, seen: false },
      { key: byName('Eric Prydz').key, name: 'Eric Prydz', accepted: true, seen: true },
      { key: byName('Main Stage').key, name: 'Main Stage', accepted: false, rejectReason: 'not_an_act', seen: false },
      { name: 'Surprise Guest DJ', accepted: true, seen: true },
    ],
    attendance: { daysAttended: ['2025-05-16'] },
  });

  assert.equal(result.edition.status, 'confirmed');
  assert.equal(result.edition.performances.length, 4);
  assert.deepEqual(result.attendance?.seenArtistKeys.sort(), ['eric prydz', 'kaskade', 'surprise guest dj']);
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
  await store.bumpBlocklist('clashfinder.com', 'main stage');
  await store.bumpBlocklist('fest.example', 'main stage');
  await store.bumpBlocklist('fest.example', 'main stage');
  await store.bumpBlocklist('clashfinder.com', 'main stage');
  const job = (await runJob(deps, (await createLookup(deps, { eventName: 'Fest', year: 2026 })).id))!;
  assert.ok(!job.candidate!.performers.some((p) => p.name === 'Main Stage'));
  assert.equal(job.candidate!.droppedCount, 2);
});

test('input validation requires a name and year', async () => {
  const { deps } = await setup();
  await assert.rejects(createLookup(deps, { eventName: '', year: 2025 }), /Event name/);
  await assert.rejects(createLookup(deps, { eventName: 'Fest', year: 25 }), /year/);
});
