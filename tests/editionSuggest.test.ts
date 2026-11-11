import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { lineupRouter } from '../src/server/lineup/routes.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import type { Edition } from '../src/server/lineup/types.ts';

const makeEdition = (id: string, name: string, year: number, extra: Partial<Edition> = {}): Edition => ({
  id,
  key: `${id}/${year}`,
  seriesSlug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, ''),
  year,
  name,
  status: 'confirmed',
  updatedAt: '2026-01-01T00:00:00.000Z',
  performances: [],
  ...extra,
});

async function withStore(fn: (store: FileLineupStore, dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'edition-suggest-'));
  try {
    await fn(new FileLineupStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// An event row shaped like the ones the file store keeps (only the fields the suggestion route reads).
const liveEvent = (id: string, editionId?: string) => ({
  id,
  input: `Event ${id}`,
  name: `Event ${id}`,
  editionId,
  sources: {},
  details: {},
  seen: [],
  daysAttended: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

test('draft editions are never suggested', async () => {
  await withStore(async (store) => {
    await store.upsertEdition(makeEdition('e1', 'EDC Las Vegas', 2026, { status: 'draft' }));
    await store.upsertEdition(makeEdition('e2', 'EDC Las Vegas', 2025));
    const found = await store.suggestEditions('edc las', { excludeIds: [], limit: 8 });
    assert.deepEqual(found.map((e) => e.id), ['e2']);
  });
});

test('a typed word matches a word prefix of the edition name', async () => {
  await withStore(async (store) => {
    await store.upsertEdition(makeEdition('e1', 'EDC Las Vegas', 2025));
    await store.upsertEdition(makeEdition('e2', 'Ultra Music Festival', 2025));
    const found = await store.suggestEditions('edc las', { excludeIds: [], limit: 8 });
    assert.deepEqual(found.map((e) => e.name), ['EDC Las Vegas']);
    const partial = await store.suggestEditions('ultr', { excludeIds: [], limit: 8 });
    assert.deepEqual(partial.map((e) => e.id), ['e2']);
  });
});

test('a substring that starts no word does not match', async () => {
  await withStore(async (store) => {
    await store.upsertEdition(makeEdition('e1', 'EDC Las Vegas', 2025));
    assert.deepEqual(await store.suggestEditions('egas', { excludeIds: [], limit: 8 }), []);
    assert.deepEqual(await store.suggestEditions('as', { excludeIds: [], limit: 8 }), []);
    assert.deepEqual(await store.suggestEditions('vegas edc', { excludeIds: [], limit: 8 }), [
      { id: 'e1', name: 'EDC Las Vegas', year: 2025, actCount: 0 },
    ]);
  });
});

test('an edition whose year is in the query ranks first, then the newest', async () => {
  await withStore(async (store) => {
    await store.upsertEdition(makeEdition('y2023', 'Summer Fest', 2023, { startDate: '2023-07-01' }));
    await store.upsertEdition(makeEdition('y2024', 'Summer Fest', 2024, { startDate: '2024-07-01' }));
    await store.upsertEdition(makeEdition('y2025', 'Summer Fest', 2025, { startDate: '2025-07-01' }));
    const byYear = await store.suggestEditions('summer fest 2023', { excludeIds: [], limit: 8 });
    assert.deepEqual(byYear.map((e) => e.id), ['y2023', 'y2025', 'y2024']);
    const noYear = await store.suggestEditions('summer', { excludeIds: [], limit: 8 });
    assert.deepEqual(noYear.map((e) => e.id), ['y2025', 'y2024', 'y2023']);
  });
});

test('a year typed alone is not matched on, so it returns nothing', async () => {
  await withStore(async (store) => {
    await store.upsertEdition(makeEdition('e1', 'Summer Fest', 2025));
    assert.deepEqual(await store.suggestEditions('2025', { excludeIds: [], limit: 8 }), []);
  });
});

test('editions on your live events are excluded', async () => {
  await withStore(async (store) => {
    await store.upsertEdition(makeEdition('e1', 'Summer Fest', 2025));
    await store.upsertEdition(makeEdition('e2', 'Summer Fest', 2024));
    const found = await store.suggestEditions('summer', { excludeIds: ['e1'], limit: 8 });
    assert.deepEqual(found.map((e) => e.id), ['e2']);
  });
});

test('a deleted event does not exclude its edition', async () => {
  await withStore(async (store) => {
    await store.upsertEdition(makeEdition('e1', 'Summer Fest', 2025));
    await store.putEvent(liveEvent('ev1', 'e1') as any);
    await store.deleteEvent('ev1');
    // The route passes the live events' edition ids; a deleted event contributes none.
    const liveIds = (await store.listEvents()).map((e) => e.editionId).filter((id): id is string => Boolean(id));
    assert.deepEqual(liveIds, []);
    const found = await store.suggestEditions('summer', { excludeIds: liveIds, limit: 8 });
    assert.deepEqual(found.map((e) => e.id), ['e1']);
  });
});

test('short queries return nothing', async () => {
  await withStore(async (store) => {
    await store.upsertEdition(makeEdition('e1', 'Summer Fest', 2025));
    assert.deepEqual(await store.suggestEditions('s', { excludeIds: [], limit: 8 }), []);
    assert.deepEqual(await store.suggestEditions('  s ', { excludeIds: [], limit: 8 }), []);
    assert.deepEqual(await store.suggestEditions('', { excludeIds: [], limit: 8 }), []);
  });
});

test('the limit is capped at 8', async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 12; i++) await store.upsertEdition(makeEdition(`e${i}`, 'Summer Fest', 2000 + i));
    assert.equal((await store.suggestEditions('summer', { excludeIds: [], limit: 20 })).length, 8);
    assert.equal((await store.suggestEditions('summer', { excludeIds: [], limit: 3 })).length, 3);
  });
});

test('returned keys are exactly the allowed ones and missing facts are omitted', async () => {
  await withStore(async (store) => {
    await store.upsertEdition(
      makeEdition('full', 'Summer Fest', 2025, {
        startDate: '2025-07-01',
        endDate: '2025-07-03',
        venue: 'Park',
        city: 'Austin',
        country: 'US',
        performances: [{ artistKey: 'a', name: 'A', role: 'headliner', setType: 'full' } as any, { artistKey: 'b', name: 'B', role: 'support', setType: 'full' } as any],
        factSourceNote: 'owner note',
      } as Partial<Edition>),
    );
    await store.upsertEdition(makeEdition('bare', 'Summer Fest Bare', 2024));
    const found = await store.suggestEditions('summer', { excludeIds: [], limit: 8 });
    const full = found.find((e) => e.id === 'full');
    assert.ok(full);
    assert.deepEqual(Object.keys(full).sort(), ['actCount', 'city', 'country', 'endDate', 'id', 'name', 'startDate', 'venue', 'year']);
    assert.equal(full.actCount, 2);
    const bare = found.find((e) => e.id === 'bare');
    assert.ok(bare);
    assert.deepEqual(Object.keys(bare).sort(), ['actCount', 'id', 'name', 'year']);
  });
});

test('GET /api/editions/suggest answers for a member and respects the rules', async () => {
  await withStore(async (store) => {
    await store.upsertEdition(makeEdition('e1', 'EDC Las Vegas', 2025));
    await store.upsertEdition(makeEdition('e2', 'EDC Orlando', 2025));
    await store.upsertEdition(makeEdition('e3', 'EDC Mexico', 2025, { status: 'draft' }));
    await store.putEvent(liveEvent('ev1', 'e2') as any);
    let tick = 0;
    const deps = { store, now: () => new Date(Date.UTC(2026, 10, 11, 12, 0, tick++)) } as any;
    const app = express();
    app.use('/api', lineupRouter(deps, { kick: async () => undefined } as any));

    const res = await dispatch(app, { url: '/api/editions/suggest?q=edc' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { editions: Array<{ id: string }> };
    assert.deepEqual(body.editions.map((e) => e.id), ['e1']);

    const short = await dispatch(app, { url: '/api/editions/suggest?q=e' });
    assert.deepEqual(await short.json(), { editions: [] });

    const missing = await dispatch(app, { url: '/api/editions/suggest' });
    assert.deepEqual(await missing.json(), { editions: [] });
  });
});
