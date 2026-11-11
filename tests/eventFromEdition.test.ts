import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { eventsRouter } from '../src/server/events/routes.ts';
import { newEvent, newEventFromEdition } from '../src/server/events/service.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import type { PipelineDeps } from '../src/server/lineup/pipeline.ts';
import type { Edition } from '../src/server/lineup/types.ts';
import { fakeFetcher } from './fakes.ts';

const NOW = new Date('2026-11-11T12:00:00Z');

const edition = (extra: Partial<Edition> = {}): Edition => ({
  id: 'ed1',
  key: 'porter-robinson/2024',
  seriesSlug: 'porter-robinson',
  year: 2024,
  name: 'Porter Robinson',
  startDate: '2024-10-05',
  endDate: '2024-10-06',
  venue: 'The Greek Theatre',
  city: 'Los Angeles',
  country: 'United States',
  status: 'confirmed',
  performances: [],
  updatedAt: NOW.toISOString(),
  ...extra,
});

async function withDeps(fn: (deps: PipelineDeps, store: FileLineupStore, calls: string[]) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'edition-event-'));
  try {
    const store = new FileLineupStore(dir);
    const { fetcher, calls } = fakeFetcher({});
    const deps: PipelineDeps = {
      store,
      fetcher,
      adapters: [],
      lateAdapters: [],
      gemini: null,
      quota: null,
      search: null,
      now: () => NOW,
    };
    await fn(deps, store, calls);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function appFor(deps: PipelineDeps) {
  const app = express();
  app.use(express.json());
  app.use('/api', eventsRouter(deps, {} as any, []));
  return app;
}

test('copies only the known facts, each sourced to the edition', () => {
  const ev = newEventFromEdition('Porter Robinson at the Greek', edition(), NOW);
  assert.equal(ev.name, 'Porter Robinson');
  assert.equal(ev.year, 2024);
  assert.equal(ev.startDate, '2024-10-05');
  assert.equal(ev.endDate, '2024-10-06');
  assert.equal(ev.venue, 'The Greek Theatre');
  assert.equal(ev.city, 'Los Angeles');
  assert.equal(ev.country, 'United States');
  for (const f of ['startDate', 'endDate', 'venue', 'city', 'country'] as const) {
    assert.deepEqual(ev.sources[f], { sourceType: 'edition', editionId: 'ed1' }, f);
  }
  assert.equal(ev.input, 'Porter Robinson at the Greek');
});

test('missing facts stay undefined and get no source', () => {
  const ev = newEventFromEdition('Porter Robinson', edition({ startDate: undefined, endDate: undefined, venue: undefined, city: undefined, country: undefined }), NOW);
  assert.equal(ev.startDate, undefined);
  assert.equal(ev.endDate, undefined);
  assert.equal(ev.venue, undefined);
  assert.equal(ev.city, undefined);
  assert.equal(ev.country, undefined);
  assert.equal(ev.sources.venue, undefined);
  assert.equal(ev.sources.city, undefined);
  assert.equal(ev.year, 2024);
});

test('links the edition and marks details matched, so no research runs', () => {
  const ev = newEventFromEdition('Porter Robinson', edition(), NOW);
  assert.equal(ev.editionId, 'ed1');
  assert.deepEqual(ev.details, { status: 'matched', candidates: [], notes: [] });
});

test('copies no personal fields', () => {
  const ev = newEventFromEdition('Porter Robinson', edition(), NOW);
  assert.deepEqual(ev.seen, []);
  assert.deepEqual(ev.companions, []);
  assert.deepEqual(ev.daysAttended, []);
  for (const f of ['rating', 'ticketPrice', 'notes', 'format', 'series', 'kind', 'weekend', 'personIds'] as const) {
    assert.equal(ev[f], undefined, f);
  }
  assert.equal(ev.sources.ticketPrice, undefined);
});

test('an edition still ahead is saved as planned; a past one is not', () => {
  const future = newEventFromEdition('Future Show', edition({ id: 'ed2', year: 2027, startDate: '2027-03-01', endDate: undefined }), NOW);
  assert.equal(future.attendance, 'planned');
  const past = newEventFromEdition('Past Show', edition(), NOW);
  assert.equal(past.attendance, undefined);
});

test('the plain capture path is unchanged without an editionId', () => {
  const ev = newEvent('Porter Robinson at the Greek, Oct 5 2024', NOW);
  assert.equal(ev.editionId, undefined);
  assert.equal(ev.details.status, 'pending');
  assert.deepEqual(ev.sources.startDate, { sourceType: 'user' });
});

test('POST /events with an unknown editionId is 404', async () => {
  await withDeps(async (deps, store) => {
    await store.upsertEdition(edition());
    const res = await dispatch(appFor(deps), { method: 'POST', url: '/api/events', body: { text: 'X', editionId: 'nope' } });
    assert.equal(res.status, 404);
    assert.ok(res.json<{ error: string }>().error);
    assert.deepEqual(await store.listEvents(), []);
  });
});

test('POST /events with a draft edition is 404', async () => {
  await withDeps(async (deps, store) => {
    await store.upsertEdition(edition({ id: 'draft1', status: 'draft' }));
    const res = await dispatch(appFor(deps), { method: 'POST', url: '/api/events', body: { text: 'X', editionId: 'draft1' } });
    assert.equal(res.status, 404);
    assert.deepEqual(await store.listEvents(), []);
  });
});

test('POST /events with editionId saves, links the lineup as needs_review, and makes no fetch', async () => {
  await withDeps(async (deps, store, calls) => {
    await store.upsertEdition(edition());
    const res = await dispatch(appFor(deps), { method: 'POST', url: '/api/events', body: { text: 'Porter Robinson at the Greek', editionId: 'ed1' } });
    assert.equal(res.status, 201);
    const body = res.json<{ event: any; job: any }>();
    assert.equal(body.event.editionId, 'ed1');
    assert.equal(body.event.details.status, 'matched');
    assert.equal(body.event.lineupJobId, body.job.id);
    assert.equal(body.job.status, 'needs_review');
    assert.equal(body.job.editionId, 'ed1');
    assert.equal(body.job.eventId, body.event.id);
    const saved = await store.getEvent(body.event.id);
    assert.equal(saved?.lineupJobId, body.job.id);
    assert.deepEqual(calls, []);
  });
});

test('POST /events without editionId is unchanged', async () => {
  await withDeps(async (deps, store, calls) => {
    const res = await dispatch(appFor(deps), { method: 'POST', url: '/api/events', body: { text: 'Kaskade' } });
    assert.equal(res.status, 201);
    const { event } = res.json<{ event: any }>();
    assert.equal(event.name, 'Kaskade');
    assert.equal(event.editionId, undefined);
    assert.equal(event.details.status, 'pending');
    assert.equal(event.lineupJobId, undefined);
    assert.deepEqual(await store.listEvents().then((l) => l.map((e) => e.id)), [event.id]);
    assert.deepEqual(calls, []);
  });
});
