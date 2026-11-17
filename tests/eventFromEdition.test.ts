import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { eventsRouter } from '../src/server/events/routes.ts';
import { newEvent, newEventFromEdition } from '../src/server/events/service.ts';
import { resolveEvent } from '../src/server/events/inherit.ts';
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
  performances: [{ name: 'Act One' } as any],
  updatedAt: NOW.toISOString(),
  ...extra,
});

const GEO = 'https://geocoding-api.open-meteo.com/';
const ARCHIVE = 'https://archive-api.open-meteo.com/';
const LA = { name: 'Los Angeles', admin1: 'California', country_code: 'US', country: 'United States', feature_code: 'PPLA2', latitude: 34.05, longitude: -118.24 };
const LA_TWIN = { ...LA, admin1: 'Other State', latitude: 40.1, longitude: -90.2 };
const archiveDays = { daily: { time: ['2024-10-05', '2024-10-06'], temperature_2m_max: [24.1, 22.0], temperature_2m_min: [15.2, 14.8], precipitation_sum: [0, 2.1], weather_code: [1, 61] } };
const cityRoutes = (results: unknown[]) => ({
  [GEO]: { body: { results } },
  [ARCHIVE]: { body: archiveDays },
});

async function withDeps(
  fn: (deps: PipelineDeps, store: FileLineupStore, calls: string[]) => Promise<void>,
  routes: Record<string, { status?: number; body: unknown }> = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'edition-event-'));
  try {
    const store = new FileLineupStore(dir);
    const { fetcher, calls } = fakeFetcher(routes);
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

test('links the edition and copies none of its facts; the typed line is captured once', () => {
  const ev = newEventFromEdition('Porter Robinson', edition(), NOW);
  assert.equal(ev.editionId, 'ed1');
  // Own columns hold only what was typed.
  assert.equal(ev.name, 'Porter Robinson');
  assert.equal(ev.startDate, undefined);
  assert.equal(ev.endDate, undefined);
  assert.equal(ev.venue, undefined);
  assert.equal(ev.city, undefined);
  assert.equal(ev.country, undefined);
  assert.deepEqual(ev.sources, {});
  assert.equal(ev.input, 'Porter Robinson');
  assert.equal(ev.captured?.name, ev.name);
  assert.equal(ev.captured?.start_date, null);
  assert.deepEqual(ev.overrides, {});
  // Display comes from inheritance on read.
  const shown = resolveEvent(ev, edition());
  assert.equal(shown.name, 'Porter Robinson');
  assert.equal(shown.startDate, '2024-10-05');
  assert.equal(shown.venue, 'The Greek Theatre');
  assert.equal(shown.country, 'United States');
  // A later edition correction reaches the event.
  assert.equal(resolveEvent(ev, edition({ venue: 'Hollywood Bowl' })).venue, 'Hollywood Bowl');
});

test('typed facts are kept as captured and as own values, not replaced', () => {
  const ev = newEventFromEdition('Porter Robinson, Oct 5 2024', edition(), NOW);
  assert.equal(ev.startDate, '2024-10-05');
  assert.equal(ev.captured?.start_date, '2024-10-05');
  assert.deepEqual(ev.sources.startDate, { sourceType: 'user' });
  const missing = resolveEvent(newEventFromEdition('Porter', edition({ venue: undefined }), NOW), edition({ venue: undefined }));
  assert.equal(missing.venue, undefined);
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
    assert.equal(body.event.venue, 'The Greek Theatre'); // shown through inheritance
    const saved = await store.getEvent(body.event.id);
    assert.equal(saved?.lineupJobId, body.job.id);
    assert.equal(saved?.venue, 'the Greek'); // only what was typed is stored, not the edition's venue
    assert.equal(saved?.country, undefined);
    assert.equal(saved?.captured?.venue, 'the Greek');
    // No research or lineup fetches: the only calls allowed are the weather lookup on Open-Meteo.
    assert.ok(calls.every((url) => url.startsWith(GEO) || url.startsWith(ARCHIVE)), calls.join('\n'));
  });
});

test('an edition save with one matching city stores weather once, with its source URL', async () => {
  await withDeps(async (deps, store, calls) => {
    await store.upsertEdition(edition());
    const res = await dispatch(appFor(deps), { method: 'POST', url: '/api/events', body: { text: 'Porter Robinson at the Greek', editionId: 'ed1' } });
    assert.equal(res.status, 201);
    const body = res.json<{ event: any; job: any }>();
    assert.equal(body.event.weather?.place, 'Los Angeles, CA');
    assert.ok(body.event.weather.sourceUrl.startsWith(ARCHIVE));
    assert.equal(body.event.weather.days.length, 2);
    const saved = await store.getEvent(body.event.id);
    assert.ok(saved?.weather?.sourceUrl);
    assert.equal(saved?.weather?.days[0].date, '2024-10-05');
    assert.equal(body.job.status, 'needs_review');
    assert.equal(calls.filter((url) => url.startsWith(GEO)).length, 1);
    assert.ok(calls.every((url) => url.startsWith(GEO) || url.startsWith(ARCHIVE)), calls.join('\n'));
  }, cityRoutes([LA]));
});

test('an ambiguous city stores no weather and the save is still 201', async () => {
  await withDeps(async (deps, store) => {
    await store.upsertEdition(edition());
    const res = await dispatch(appFor(deps), { method: 'POST', url: '/api/events', body: { text: 'Porter Robinson', editionId: 'ed1' } });
    assert.equal(res.status, 201);
    const body = res.json<{ event: any; job: any }>();
    assert.equal(body.event.weather, undefined);
    assert.equal(body.job.status, 'needs_review');
    const saved = await store.getEvent(body.event.id);
    assert.equal(saved?.weather, undefined);
  }, cityRoutes([LA, LA_TWIN]));
});

test('a failing weather lookup never fails the save', async () => {
  await withDeps(async (deps, store) => {
    await store.upsertEdition(edition());
    const res = await dispatch(appFor(deps), { method: 'POST', url: '/api/events', body: { text: 'Porter Robinson', editionId: 'ed1' } });
    assert.equal(res.status, 201);
    const body = res.json<{ event: any; job: any }>();
    assert.equal(body.event.weather, undefined);
    assert.equal(body.job.status, 'needs_review');
    assert.equal((await store.getEvent(body.event.id))?.weather, undefined);
  }, {
    [GEO]: { body: { results: [LA] } },
    [ARCHIVE]: { status: 500, body: '' },
  });
});

test('a thrown weather fetch never fails the save', async () => {
  await withDeps(async (deps, store) => {
    await store.upsertEdition(edition());
    deps.fetcher = {
      async get(url: string) {
        if (url.startsWith(GEO)) throw new Error('network down');
        return { url, status: 404, headers: {}, body: '' };
      },
    };
    const res = await dispatch(appFor(deps), { method: 'POST', url: '/api/events', body: { text: 'Porter Robinson', editionId: 'ed1' } });
    assert.equal(res.status, 201);
    const body = res.json<{ event: any; job: any }>();
    assert.equal(body.event.weather, undefined);
    assert.equal((await store.getEvent(body.event.id))?.weather, undefined);
  });
});

test('a plain save without editionId makes no weather call', async () => {
  await withDeps(async (deps, store, calls) => {
    const res = await dispatch(appFor(deps), { method: 'POST', url: '/api/events', body: { text: 'Kaskade, Los Angeles, Oct 5 2024' } });
    assert.equal(res.status, 201);
    assert.equal(calls.some((url) => url.startsWith(GEO) || url.startsWith(ARCHIVE)), false);
  }, cityRoutes([LA]));
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
