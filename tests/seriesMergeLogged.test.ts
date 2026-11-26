import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { undoEditionChange, writeEdition } from '../src/server/canon/editions.ts';
import { mergeSeriesLogged, undoHistory } from '../src/server/entities/canonicalManage.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';
import type { Edition } from '../src/server/lineup/types.ts';

const AT = '2026-11-26T00:00:00.000Z';
const ACTOR = { actor: 'system:series-cleanup', reason: 'series cleanup (approved 2026-11-26)' };

const ed = (id: string, seriesSlug: string, over: Partial<Edition> = {}): Edition => ({
  id,
  key: `${seriesSlug}/2022`,
  seriesSlug,
  year: 2022,
  name: `Edition ${id}`,
  status: 'provisional',
  updatedAt: AT,
  performances: [],
  ...over,
});

async function withStore(fn: (store: FileLineupStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'series-merge-'));
  try {
    await fn(new FileLineupStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const asOwner = <T>(store: FileLineupStore, fn: () => Promise<T>) =>
  new Promise<T>((resolve, reject) => runAsMember({ role: 'owner', uid: 'u0' } as any, store as any, () => fn().then(resolve, reject)));

test('an edition subtitle change is recorded, kept when a save leaves it out, and undone', async () => {
  await withStore(async (store) => {
    await store.upsertSeries({ slug: 'asot-la', name: 'A State of Trance Los Angeles' });
    await writeEdition(store, { edition: ed('e1', 'asot-la'), actor: 'owner', reason: 'seed' });
    const set = await writeEdition(store, { edition: { ...(await store.getEdition('e1'))!, subtitle: '1000' }, ...ACTOR });
    assert.deepEqual(set.change?.after, { subtitle: '1000' });
    assert.deepEqual(set.change?.before, { subtitle: null });

    const { subtitle: _s, ...without } = (await store.getEdition('e1'))!;
    const kept = await writeEdition(store, { edition: { ...without, venue: 'Shrine' }, ...ACTOR });
    assert.equal('subtitle' in (kept.change?.after ?? {}), false);
    assert.equal((await store.getEdition('e1'))?.subtitle, '1000');

    const undone = await undoEditionChange(store, 'e1', set.change!.id, 'owner');
    assert.equal(undone.ok, true);
    assert.equal((await store.getEdition('e1'))?.subtitle || undefined, undefined);
  });
});

test('a logged merge moves each edition with its own change, and undo puts the dropped series back', async () => {
  await withStore(async (store) => {
    await store.upsertSeries({ slug: 'illenium-gorge', name: 'Illenium at the Gorge', brand: 'Illenium', kind: 'tour' });
    await store.upsertSeries({ slug: 'illenium-the-gorge-2022', name: 'Illenium @ the Gorge 2022', kind: 'festival' });
    await writeEdition(store, { edition: ed('g22', 'illenium-the-gorge-2022'), actor: 'owner', reason: 'seed' });
    await writeEdition(store, { edition: ed('g23', 'illenium-gorge', { year: 2023 }), actor: 'owner', reason: 'seed' });

    const entry = await mergeSeriesLogged(store, 'illenium-gorge', 'illenium-the-gorge-2022', ACTOR, AT);
    assert.equal((await store.getEdition('g22'))?.seriesSlug, 'illenium-gorge');
    assert.equal(await store.getSeries('illenium-the-gorge-2022'), null);
    const moved = (await store.listEditionChanges('g22')).find((c) => c.actor === ACTOR.actor);
    assert.equal(moved?.after?.seriesSlug, 'illenium-gorge');
    assert.equal(entry.series?.dropped?.name, 'Illenium @ the Gorge 2022');

    await asOwner(store, () => undoHistory(store, entry.id));
    assert.equal((await store.getSeries('illenium-the-gorge-2022'))?.name, 'Illenium @ the Gorge 2022');
    const back = await undoEditionChange(store, 'g22', moved!.id, 'owner');
    assert.equal(back.ok, true);
    assert.equal((await store.getEdition('g22'))?.seriesSlug, 'illenium-the-gorge-2022');
  });
});
