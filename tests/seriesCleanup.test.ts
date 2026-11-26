import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { writeEdition } from '../src/server/canon/editions.ts';
import { newEvent } from '../src/server/events/service.ts';
import { runSeriesCleanup, type CleanupStep } from '../src/server/entities/seriesCleanup.ts';
import type { Edition } from '../src/server/lineup/types.ts';

const NOW = new Date('2026-11-26T00:00:00.000Z');
const OPTS = { actor: 'system:series-cleanup', reason: 'series cleanup (approved 2026-11-26)', now: () => NOW };

const ed = (id: string, seriesSlug: string, year: number, city: string, over: Partial<Edition> = {}): Edition => ({
  id,
  key: `${seriesSlug}/${year}`,
  seriesSlug,
  year,
  name: `Lost In Dreams ${year}`,
  city,
  startDate: `${year}-07-11`,
  status: 'provisional',
  updatedAt: NOW.toISOString(),
  performances: [],
  ...over,
});

async function seeded(fn: (store: FileLineupStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'series-cleanup-'));
  try {
    const store = new FileLineupStore(dir);
    await store.upsertSeries({ slug: 'lost-in-dreams', name: 'Lost In Dreams SoCal', brand: 'Lost In Dreams', kind: 'festival' });
    await store.upsertSeries({ slug: 'lid-dupe', name: 'Lost In Dreams LA', kind: 'festival' });
    await writeEdition(store, { edition: ed('lv22', 'lost-in-dreams', 2022, 'Las Vegas'), actor: 'owner', reason: 'seed' });
    await writeEdition(store, { edition: ed('la24', 'lost-in-dreams', 2024, 'Los Angeles'), actor: 'owner', reason: 'seed' });
    await writeEdition(store, { edition: ed('la26', 'lid-dupe', 2026, 'Los Angeles'), actor: 'owner', reason: 'seed' });
    await store.putEvent({ ...newEvent('Lost In Dreams 2024', NOW), editionId: 'la24', series: 'Lost In Dreams SoCal' });
    await fn(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const STEPS: CleanupStep[] = [
  { op: 'series', slug: 'lost-in-dreams-las-vegas', create: true, brand: 'Lost In Dreams', qualifier: 'Las Vegas', kind: 'festival' },
  { op: 'edition', id: 'lv22', seriesSlug: 'lost-in-dreams-las-vegas' },
  { op: 'series', slug: 'lost-in-dreams', qualifier: 'Los Angeles' },
  { op: 'mergeSeries', keep: 'lost-in-dreams', drop: 'lid-dupe' },
  { op: 'edition', id: 'la26', subtitle: 'Opening night' },
  { op: 'series', slug: 'no-such-series', name: 'Ghost' },
  { op: 'linkEvents' },
];

test('a preview checks every step and changes nothing', async () => {
  await seeded(async (store) => {
    const preview = await runSeriesCleanup(store, STEPS, { ...OPTS, apply: false });
    assert.deepEqual(
      preview.map((r) => r.outcome),
      ['ready', 'ready', 'ready', 'ready', 'ready', 'missing', 'ready'],
    );
    assert.equal(await store.getSeries('lost-in-dreams-las-vegas'), null);
    assert.equal((await store.getSeries('lost-in-dreams'))?.name, 'Lost In Dreams SoCal');
    assert.equal((await store.getEdition('lv22'))?.seriesSlug, 'lost-in-dreams');
  });
});

test('apply runs each step through its logged path, and a second run changes nothing', async () => {
  await seeded(async (store) => {
    const done = await runSeriesCleanup(store, STEPS, { ...OPTS, apply: true });
    assert.deepEqual(
      done.map((r) => r.outcome),
      ['done', 'done', 'done', 'done', 'done', 'missing', 'done'],
    );
    assert.equal((await store.getSeries('lost-in-dreams-las-vegas'))?.name, 'Lost In Dreams Las Vegas');
    assert.equal((await store.getSeries('lost-in-dreams'))?.name, 'Lost In Dreams Los Angeles');
    assert.equal(await store.getSeries('lid-dupe'), null);
    assert.equal((await store.getEdition('lv22'))?.seriesSlug, 'lost-in-dreams-las-vegas');
    const la26 = await store.getEdition('la26');
    assert.equal(la26?.seriesSlug, 'lost-in-dreams');
    assert.equal(la26?.subtitle, 'Opening night');
    const moved = (await store.listEditionChanges('lv22')).find((c) => c.actor === OPTS.actor);
    assert.equal(moved?.reason, OPTS.reason);

    const [event] = await store.listEvents();
    assert.equal(event.series, 'Lost In Dreams SoCal');
    assert.equal(event.seriesSlug, 'lost-in-dreams');

    const again = await runSeriesCleanup(store, STEPS, { ...OPTS, apply: true });
    assert.deepEqual(
      again.map((r) => r.outcome),
      ['unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged', 'missing', 'unchanged'],
    );
  });
});
