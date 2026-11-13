import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { createLookup, PipelineDeps, runJob } from '../src/server/lineup/pipeline.ts';
import { GeminiClient } from '../src/server/lineup/gemini.ts';
import { QuotaLedger } from '../src/server/lineup/quota.ts';
import { makeDocument } from '../src/server/lineup/adapters/common.ts';
import { SourceAdapter } from '../src/server/lineup/types.ts';
import { createGuardedReader } from '../src/server/reader/guardedReader.ts';
import { readReaderConfig } from '../src/server/reader/config.ts';
import { fakeFetcher } from './fakes.ts';

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

function makeStubAdapter(performers: string[], facts: Record<string, { value: string; sourceType: 'ticketmaster'; sourceUrl: string }[]> = {}): SourceAdapter {
  return {
    id: 'ticketmaster',
    enabled: () => true,
    async collect() {
      const doc = makeDocument('https://ticketmaster.example/event', 'ticketmaster', JSON.stringify({ performers }), 'json');
      return {
        documents: [doc],
        performers: performers.map((name) => ({
          documentId: doc.id,
          sourceType: 'ticketmaster' as const,
          sourceUrl: doc.url,
          name,
          quotedSpan: name,
          evidence: 'billed' as const,
          extractor: 'ticketmaster',
          extractorVersion: 'test',
        })),
        facts,
        extractionQueue: [],
        notes: ['ticketmaster stub ran'],
      };
    },
  };
}

test('sparse festival with 1 claim transitions to discover and keeps existing claims alongside discovered ones', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'pipeline-sparse-')));
  const discoveredHtml = '<html><body><h1>Desert Fest 2025</h1><p>Lineup: Rufus Du Sol, ODESZA, Justice</p></body></html>';
  const { fetcher } = fakeFetcher({
    'https://news.example/desert-fest-2025': { body: discoveredHtml },
  });

  let searchCalls = 0;
  const search = {
    id: 'brave' as const,
    usesGeminiQuota: false,
    async findLineupUrls() {
      searchCalls += 1;
      return ['https://news.example/desert-fest-2025'];
    },
  };

  const gemini: GeminiClient = {
    model: 'fake-lite',
    async extractPerformers() {
      return [
        { name: 'Rufus Du Sol', quote: 'Rufus Du Sol' },
        { name: 'ODESZA', quote: 'ODESZA' },
        { name: 'Justice', quote: 'Justice' },
      ];
    },
    async extractEventDetails() {
      return {};
    },
    async discoverLineupUrls() {
      return [];
    },
  };

  const stubAdapter = makeStubAdapter(['Headliner Act']);

  const quota = new QuotaLedger(store, { provider: 'gemini', model: 'fake-lite', dailyLimit: 100, perMinute: 100 });
  const now = () => new Date('2025-06-01T12:00:00Z');
  const deps: PipelineDeps = {
    store,
    fetcher,
    adapters: [stubAdapter],
    lateAdapters: [],
    gemini,
    quota,
    reader: readerFor(gemini, store, quota, now),
    search,
    now,
  };

  // Multi-day festival via input dates:
  const job = await createLookup(deps, {
    eventName: 'Desert Fest',
    year: 2025,
    startDate: '2025-05-16',
    endDate: '2025-05-18',
  });

  // Step 1: collect -> transitions to 'extract'
  const afterCollect = (await runJob(deps, job.id, { oneStep: true }))!;
  assert.equal(afterCollect.stage, 'extract');

  // Step 2: extract (no pending extraction) -> transitions to 'discover' because claims=1 < 5 and multi-day
  const afterExtract = (await runJob(deps, job.id, { oneStep: true }))!;
  assert.equal(afterExtract.stage, 'discover', 'Sparse festival with 1 claim should transition to discover');

  // Finish running the job to done
  const completed = (await runJob(deps, job.id))!;
  assert.equal(completed.status, 'needs_review');
  assert.equal(searchCalls, 1, 'Search should be invoked');

  // Verify that the initial stub claim ('Headliner Act') AND discovered claims are all kept
  const candidateNames = completed.candidate!.performers.map((p) => p.name).sort();
  assert.deepEqual(candidateNames, ['Headliner Act', 'Justice', 'Odesza', 'Rufus Du Sol']);

  const headliner = completed.candidate!.performers.find((p) => p.name === 'Headliner Act')!;
  assert.ok(headliner.sources.some((s) => s.sourceType === 'ticketmaster'));

  const discoveredAct = completed.candidate!.performers.find((p) => p.name === 'Justice')!;
  assert.ok(discoveredAct.sources.some((s) => s.sourceType === 'discovered'));
});

test('multi-day festival detected from adapter facts transitions to discover when claims are sparse', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'pipeline-facts-sparse-')));
  const { fetcher } = fakeFetcher({
    'https://news.example/island-fest-2025': { body: '<html><body><h1>Island Fest 2025</h1><p>Lineup: Disclosure</p></body></html>' },
  });

  let searchCalls = 0;
  const search = {
    id: 'brave' as const,
    usesGeminiQuota: false,
    async findLineupUrls() {
      searchCalls += 1;
      return ['https://news.example/island-fest-2025'];
    },
  };

  const gemini: GeminiClient = {
    model: 'fake-lite',
    async extractPerformers() {
      return [{ name: 'Disclosure', quote: 'Disclosure' }];
    },
    async extractEventDetails() {
      return {};
    },
    async discoverLineupUrls() {
      return [];
    },
  };

  // Dates provided via adapter facts instead of input dates:
  const stubAdapter = makeStubAdapter(['Solo Star'], {
    startDate: [{ value: '2025-07-10', sourceType: 'ticketmaster', sourceUrl: 'https://ticketmaster.example/event' }],
    endDate: [{ value: '2025-07-12', sourceType: 'ticketmaster', sourceUrl: 'https://ticketmaster.example/event' }],
  });

  const quota = new QuotaLedger(store, { provider: 'gemini', model: 'fake-lite', dailyLimit: 100, perMinute: 100 });
  const now = () => new Date('2025-06-01T12:00:00Z');
  const deps: PipelineDeps = {
    store,
    fetcher,
    adapters: [stubAdapter],
    lateAdapters: [],
    gemini,
    quota,
    reader: readerFor(gemini, store, quota, now),
    search,
    now,
  };

  const job = await createLookup(deps, {
    eventName: 'Island Fest',
    year: 2025,
  });

  // Step 1: collect
  const afterCollect = (await runJob(deps, job.id, { oneStep: true }))!;
  assert.equal(afterCollect.stage, 'extract');

  // Step 2: extract -> should transition to discover based on facts.startDate !== facts.endDate
  const afterExtract = (await runJob(deps, job.id, { oneStep: true }))!;
  assert.equal(afterExtract.stage, 'discover');
});

test('single-day event with 1 claim transitions directly to merge instead of discover', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'pipeline-single-day-')));
  const { fetcher } = fakeFetcher({});

  let searchCalls = 0;
  const search = {
    id: 'brave' as const,
    usesGeminiQuota: false,
    async findLineupUrls() {
      searchCalls += 1;
      return [];
    },
  };

  const stubAdapter = makeStubAdapter(['Solo Artist']);

  const deps: PipelineDeps = {
    store,
    fetcher,
    adapters: [stubAdapter],
    lateAdapters: [],
    gemini: {
      model: 'fake-lite',
      extractPerformers: async () => [],
      extractEventDetails: async () => ({}),
      discoverLineupUrls: async () => [],
    },
    quota: new QuotaLedger(store, { provider: 'gemini', model: 'fake-lite', dailyLimit: 100, perMinute: 100 }),
    search,
    now: () => new Date('2025-06-01T12:00:00Z'),
  };

  // Single-day show (same startDate and endDate)
  const job = await createLookup(deps, {
    eventName: 'Arena Tour',
    year: 2025,
    startDate: '2025-05-16',
    endDate: '2025-05-16',
  });

  // Step 1: collect -> extract
  await runJob(deps, job.id, { oneStep: true });

  // Step 2: extract -> merge (not discover)
  const afterExtract = (await runJob(deps, job.id, { oneStep: true }))!;
  assert.equal(afterExtract.stage, 'merge');
  assert.equal(searchCalls, 0, 'Single-day event should not trigger web search when claims exist');
});

test('festival with >= 5 claims transitions directly to merge instead of discover', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'pipeline-rich-fest-')));
  const { fetcher } = fakeFetcher({});

  let searchCalls = 0;
  const search = {
    id: 'brave' as const,
    usesGeminiQuota: false,
    async findLineupUrls() {
      searchCalls += 1;
      return [];
    },
  };

  const stubAdapter = makeStubAdapter(['Act 1', 'Act 2', 'Act 3', 'Act 4', 'Act 5']);

  const deps: PipelineDeps = {
    store,
    fetcher,
    adapters: [stubAdapter],
    lateAdapters: [],
    gemini: {
      model: 'fake-lite',
      extractPerformers: async () => [],
      extractEventDetails: async () => ({}),
      discoverLineupUrls: async () => [],
    },
    quota: new QuotaLedger(store, { provider: 'gemini', model: 'fake-lite', dailyLimit: 100, perMinute: 100 }),
    search,
    now: () => new Date('2025-06-01T12:00:00Z'),
  };

  const job = await createLookup(deps, {
    eventName: 'Massive Fest',
    year: 2025,
    startDate: '2025-05-16',
    endDate: '2025-05-18',
  });

  // Step 1: collect -> extract
  await runJob(deps, job.id, { oneStep: true });

  // Step 2: extract -> merge (not discover, because claims.length >= 5)
  const afterExtract = (await runJob(deps, job.id, { oneStep: true }))!;
  assert.equal(afterExtract.stage, 'merge');
  assert.equal(searchCalls, 0, 'Rich festival with 5 claims should not trigger discovery');
});
