import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { eventsRouter, type EventsRunner } from '../src/server/events/routes.ts';
import { runQueuedResearch, type DetailFinder } from '../src/server/events/details.ts';
import { newEvent } from '../src/server/events/service.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import type { PipelineDeps } from '../src/server/lineup/pipeline.ts';
import { fakeFetcher } from './fakes.ts';

const NOW = new Date('2026-11-13T12:00:00Z');

const found: DetailFinder = {
  id: 'setlistfm',
  enabled: () => true,
  find: async () => [
    {
      id: 'c1',
      startDate: '2024-10-05',
      venue: 'Greek Theatre',
      city: 'Los Angeles',
      sources: [{ sourceType: 'setlistfm', sourceUrl: 'https://setlistfm.example/x', fields: ['startDate', 'venue', 'city'] }],
    },
  ],
};

async function withStore(fn: (store: FileLineupStore, deps: PipelineDeps) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'queued-research-'));
  try {
    const store = new FileLineupStore(dir);
    const deps: PipelineDeps = { store, fetcher: fakeFetcher({}).fetcher, adapters: [], lateAdapters: [], gemini: null, quota: null, search: null, now: () => NOW };
    await fn(store, deps);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const appFor = (deps: PipelineDeps, runner: EventsRunner) => {
  const app = express();
  app.use(express.json());
  app.use('/api', eventsRouter(deps, runner, []));
  return app;
};

test('queued research fills empty fields, keeps what was typed, and saves the result', async () => {
  await withStore(async (store) => {
    const ev = newEvent('Porter Robinson at the Greek Oct 5 2024', NOW);
    await store.putEvent(ev);
    const out = await runQueuedResearch(store, ev.id, [found], fakeFetcher({}).fetcher, NOW);
    assert.equal(out?.details.status, 'matched');
    assert.equal(out?.venue, 'the Greek', 'typed venue is kept');
    assert.equal(out?.city, 'Los Angeles');
    assert.equal((await store.getEvent(ev.id))?.details.status, 'matched');
  });
});

test('queued research leaves an event alone that is no longer pending, or is gone', async () => {
  await withStore(async (store) => {
    const ev = { ...newEvent('Porter Robinson Oct 5 2024', NOW), details: { status: 'none' as const, candidates: [], notes: [] } };
    await store.putEvent(ev);
    assert.equal(await runQueuedResearch(store, ev.id, [found], fakeFetcher({}).fetcher, NOW), null);
    assert.equal((await store.getEvent(ev.id))?.details.status, 'none');
    assert.equal(await runQueuedResearch(store, 'missing', [found], fakeFetcher({}).fetcher, NOW), null);
  });
});

test('POST /events with research: true saves, enqueues research and returns at once', async () => {
  await withStore(async (store, deps) => {
    const sent: string[] = [];
    const res = await dispatch(appFor(deps, { kick() {}, kickResearch: (id) => void sent.push(id) }), {
      method: 'POST',
      url: '/api/events',
      body: { text: 'Kaskade 2024', research: true },
    });
    assert.equal(res.status, 201);
    const body = res.json();
    assert.equal(body.research, 'queued');
    assert.equal(body.event.details.status, 'pending');
    assert.deepEqual(sent, [body.event.id]);
    assert.ok(await store.getEvent(body.event.id));
  });
});

test('a failed queue send never loses the save: the event stays pending', async () => {
  await withStore(async (store, deps) => {
    const runner: EventsRunner = { kick() {}, kickResearch: async () => { throw new Error('queue down'); } };
    const res = await dispatch(appFor(deps, runner), { method: 'POST', url: '/api/events', body: { text: 'Kaskade 2024', research: true } });
    assert.equal(res.status, 201);
    assert.equal(res.json().research, 'pending');
    assert.equal((await store.getEvent(res.json().event.id))?.details.status, 'pending');
  });
});

test('without research: true (imports) or without a queue, nothing is enqueued and no flag is returned', async () => {
  await withStore(async (_store, deps) => {
    const sent: string[] = [];
    const queued: EventsRunner = { kick() {}, kickResearch: (id) => void sent.push(id) };
    const plain = await dispatch(appFor(deps, queued), { method: 'POST', url: '/api/events', body: { text: 'Kaskade 2024' } });
    assert.equal(plain.json().research, undefined);
    const noQueue = await dispatch(appFor(deps, { kick() {} }), { method: 'POST', url: '/api/events', body: { text: 'Kaskade 2024', research: true } });
    assert.equal(noQueue.status, 201);
    assert.equal(noQueue.json().research, undefined);
    assert.deepEqual(sent, []);
  });
});
