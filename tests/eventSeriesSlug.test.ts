import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { eventSeriesSlug, eventsRouter } from '../src/server/events/routes.ts';
import { newEvent } from '../src/server/events/service.ts';
import type { PipelineDeps } from '../src/server/lineup/pipeline.ts';
import type { EditionHeader } from '../src/server/lineup/types.ts';

const NOW = new Date('2026-11-26T00:00:00.000Z');

async function withStore(fn: (store: FileLineupStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'event-series-slug-'));
  try {
    const store = new FileLineupStore(dir);
    await store.upsertSeries({ slug: 'dreamstate-socal', name: 'Dreamstate SoCal', brand: 'Dreamstate', qualifier: 'SoCal', aliases: ['Dreamstate Long Beach'] });
    await store.upsertSeries({ slug: 'edc-las-vegas', name: 'EDC Las Vegas', brand: 'EDC' });
    await fn(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const edition: EditionHeader = {
  id: 'ed-1',
  key: 'dreamstate-socal/2024',
  seriesSlug: 'dreamstate-socal',
  seriesName: 'Dreamstate SoCal',
  seriesBrand: 'Dreamstate',
  seriesQualifier: 'SoCal',
  seriesKind: 'festival',
  year: 2024,
  name: 'Dreamstate SoCal 2024',
  status: 'verified',
  updatedAt: NOW.toISOString(),
};

test('a linked event showing the shared name points at its edition series', async () => {
  await withStore(async (store) => {
    const e = { ...newEvent('Dreamstate 2024', NOW), editionId: 'ed-1', series: 'Dreamstate' };
    assert.equal(await eventSeriesSlug(store, e, edition), 'dreamstate-socal');
  });
});

test('your own wording points at the one shared series it matches, else none', async () => {
  await withStore(async (store) => {
    const own = { ...newEvent('Dreamstate 2023', NOW), series: 'Dreamstate Long Beach 2023' };
    assert.equal(await eventSeriesSlug(store, own, null), 'dreamstate-socal');
    assert.equal(await eventSeriesSlug(store, { ...own, series: 'Ultra Miami' }, null), undefined);
    assert.equal(await eventSeriesSlug(store, { ...own, series: undefined }, null), undefined);
    const linkedOwn = { ...own, editionId: 'ed-1', overrides: { series: 'EDC Las Vegas' } };
    assert.equal(await eventSeriesSlug(store, linkedOwn, edition), 'edc-las-vegas');
  });
});

test('saving a series on an event stores the link and keeps your wording', async () => {
  await withStore(async (store) => {
    const deps = { store, fetcher: null, adapters: [], lateAdapters: [], gemini: null, quota: null, search: null, now: () => NOW } as unknown as PipelineDeps;
    const app = express();
    app.use(express.json());
    app.use('/api', eventsRouter(deps, { kick() {} }, []));
    const ev = newEvent('Dreamstate 2023', NOW);
    await store.putEvent(ev);

    const res = await dispatch(app, { method: 'PATCH', url: `/api/events/${ev.id}`, headers: { 'content-type': 'application/json' }, body: { series: 'Dreamstate Long Beach' } });
    assert.equal(res.status, 200);
    const saved = await store.getEvent(ev.id);
    assert.equal(saved?.series, 'Dreamstate Long Beach');
    assert.equal(saved?.seriesSlug, 'dreamstate-socal');

    await dispatch(app, { method: 'PATCH', url: `/api/events/${ev.id}`, headers: { 'content-type': 'application/json' }, body: { series: null } });
    assert.equal((await store.getEvent(ev.id))?.seriesSlug, undefined);
  });
});
