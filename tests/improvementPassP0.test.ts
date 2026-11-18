import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { entitiesRouter } from '../src/server/entities/routes.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import {
  BRAVE_INTERACTIVE_RESERVE,
  BRAVE_MONTHLY_CAP,
  BRAVE_SETTING,
  braveBatchRemaining,
  braveHasBatchBudget,
  takeBrave,
} from '../src/server/events/braveBudget.ts';
import { runResearchBackfill } from '../src/server/events/backfillResearch.ts';
import { runQueuedResearch, ticketmasterFinder, type DetailFinder } from '../src/server/events/details.ts';
import { newEvent } from '../src/server/events/service.ts';
import { makeBudget, runWithBudget } from '../src/server/lineup/budget.ts';
import { REFUSED_SETTING } from '../src/server/events/refusedHosts.ts';
import type { Edition } from '../src/server/lineup/types.ts';
import type { IngestTraceRow } from '../src/server/lineup/store/types.ts';
import { fakeFetcher } from './fakes.ts';

const NOW = new Date('2026-11-18T12:00:00Z');

async function withTempStore(fn: (store: FileLineupStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'p0-pass-'));
  try {
    await fn(new FileLineupStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('P0.1: GET /api/canon/lineup-offers uses batched getEditions once for 60 IDs and never calls getEdition', async () => {
  await withTempStore(async (store) => {
    await store.ensureArtists([{ key: 'tsha', name: 'Tsha' }]);
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      const id = `ed-${i}`;
      ids.push(id);
      await store.upsertEdition({
        id,
        key: `k/${i}`,
        year: 2026,
        name: i === 0 ? 'Tsha at Sound Nightclub' : `Other Show ${i}`,
        status: 'verified',
        performances: [],
        updatedAt: NOW.toISOString(),
      } as Edition);
    }

    let getEditionCalls = 0;
    let getEditionsCalls = 0;
    const spyStore = Object.assign(Object.create(store), {
      getEdition: async (id: string) => {
        getEditionCalls++;
        return store.getEdition(id);
      },
      getEditions: async (list: string[]) => {
        getEditionsCalls++;
        return store.getEditions(list);
      },
    }) as FileLineupStore;

    const app = express();
    app.use((_req, _res, next) => runAsMember({ role: 'member', uid: 'u1' } as any, spyStore as any, next));
    app.use('/api', entitiesRouter({ store: spyStore } as any));

    const res = await dispatch(app, { method: 'GET', url: `/api/canon/lineup-offers?editionIds=${ids.join(',')}` });
    assert.equal(res.status, 200);
    assert.equal(getEditionsCalls, 1, 'should batch via getEditions');
    assert.equal(getEditionCalls, 0, 'must not do N+1 getEdition calls');
    assert.deepEqual(res.json().offers, [{ editionId: 'ed-0', artistKey: 'tsha', artistName: 'Tsha' }]);
  });
});

test('P0.2: Brave interactive reserve stops batch at 140/200 while keeping 60 interactive queries', async () => {
  await withTempStore(async (store) => {
    const threshold = BRAVE_MONTHLY_CAP - BRAVE_INTERACTIVE_RESERVE;
    assert.equal(threshold, 140);
    await store.putSetting(BRAVE_SETTING, { month: '2026-11', used: threshold - 1 });
    assert.equal(await braveBatchRemaining(store, NOW), 1);
    assert.equal(await braveHasBatchBudget(store, NOW), true);

    assert.equal(await takeBrave(store, NOW, 1, 'batch'), true);
    assert.equal(await braveBatchRemaining(store, NOW), 0);
    assert.equal(await braveHasBatchBudget(store, NOW), false);

    // Interactive queries can still use the remaining 60 queries up to 200.
    assert.equal(await takeBrave(store, NOW, 1, 'interactive'), true);
    const saved = await store.getSetting<{ month: string; used: number; bySource?: Record<string, number> }>(BRAVE_SETTING);
    assert.equal(saved?.used, threshold + 1);
    assert.deepEqual(saved?.bySource, { batch: 1, interactive: 1 });
  });
});

test('P0.2 & P0.3: runResearchBackfill drops Brave once reserve is reached and persists refused_hosts to catalogStore', async () => {
  const dirA = await mkdtemp(path.join(tmpdir(), 'p0-user-'));
  const dirB = await mkdtemp(path.join(tmpdir(), 'p0-cat-'));
  try {
    const userStore = new FileLineupStore(dirA);
    const catalogStore = new FileLineupStore(dirB);
    await catalogStore.putSetting(BRAVE_SETTING, { month: '2026-11', used: 140 });

    const ev = { ...newEvent('Test Artist 2024', NOW), city: 'Los Angeles' };
    await userStore.putEvent(ev);

    const called: string[] = [];
    const freeFinder: DetailFinder = {
      id: 'setlistfm',
      enabled: () => true,
      withoutYear: true,
      find: async (_q, f) => {
        called.push('setlistfm');
        await f.get('https://refused.example/page');
        return [];
      },
    };
    const braveFinder: DetailFinder = {
      id: 'discovered',
      enabled: () => true,
      withoutYear: true,
      find: async () => {
        called.push('discovered');
        return [];
      },
    };

    const { fetcher } = fakeFetcher({ 'https://refused.example/': { status: 403, body: '' } });
    await runResearchBackfill(userStore, [freeFinder, braveFinder], fetcher, NOW, {
      budgetLeft: () => 1000,
      role: 'member',
      userId: 'u2',
      catalogStore,
    });

    assert.deepEqual(called, ['setlistfm'], 'Brave is skipped when batch budget is exhausted');
    assert.equal(await userStore.getSetting(REFUSED_SETTING), null, 'user store must not hold global refused_hosts');
    const globalRefused = await catalogStore.getSetting<Record<string, string>>(REFUSED_SETTING);
    assert.ok(globalRefused && typeof globalRefused['refused.example'] === 'string', 'refused host saved to catalogStore');
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test('P0.2: ticketmasterFinder skips network calls for past years when now is provided', async () => {
  process.env.TICKETMASTER_API_KEY = 'k';
  try {
    const { fetcher, calls } = fakeFetcher({
      'https://app.ticketmaster.com/': { body: { _embedded: { events: [] } } },
    });
    const past = await ticketmasterFinder.find({ name: 'Porter Robinson', year: 2024 }, fetcher, NOW);
    assert.deepEqual(past, []);
    assert.equal(calls.length, 0, 'past-year event does not hit Ticketmaster');

    await ticketmasterFinder.find({ name: 'Porter Robinson', year: 2026 }, fetcher, NOW);
    assert.equal(calls.length, 1, 'current-year event still queries Ticketmaster');
  } finally {
    delete process.env.TICKETMASTER_API_KEY;
  }
});

test('P3.2 / P0: runQueuedResearch records subrequests count on ingest_traces', async () => {
  await withTempStore(async (store) => {
    const ev = { ...newEvent('Test Fest Oct 5 2026', NOW), city: 'Los Angeles' };
    await store.putEvent(ev);
    const traces: IngestTraceRow[] = [];
    const spyStore = Object.assign(Object.create(store), {
      addIngestTrace: async (row: IngestTraceRow) => {
        traces.push(row);
      },
    });
    const budget = makeBudget();
    const countedStore = {
      getEvent: async (id: string) => {
        budget.take();
        return store.getEvent(id);
      },
      putEvent: async (event: typeof ev) => {
        budget.take();
        return store.putEvent(event);
      },
      addIngestTrace: spyStore.addIngestTrace,
    };
    const stubFinder: DetailFinder = {
      id: 'setlistfm',
      enabled: () => true,
      withoutYear: true,
      find: async (_q, f) => {
        budget.take();
        await f.get('https://api.setlist.fm/test');
        return [];
      },
    };
    const { fetcher } = fakeFetcher({ 'https://api.setlist.fm/': { status: 200, body: '{}' } });

    await runWithBudget(budget, async () => {
      await runQueuedResearch(countedStore, ev.id, [stubFinder], fetcher, NOW);
    });

    assert.equal(traces.length, 1);
    assert.equal(traces[0].trigger, 'research');
    assert.equal(typeof traces[0].subrequests, 'number');
    assert.ok((traces[0].subrequests ?? 0) >= 3, `expected >= 3 subrequests, got ${traces[0].subrequests}`);
  });
});
