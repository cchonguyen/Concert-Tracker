import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveSeriesLogged, undoHistory } from '../src/server/entities/canonicalManage.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';

const owner = { role: 'owner', uid: 'owner-1' } as any;

async function freshStore() {
  return new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'series-undo-')));
}

test('a series type change is logged and undo restores the old record', async () => {
  const store = await freshStore();
  await store.upsertSeries({ slug: 'eras', name: 'The Eras Tour', kind: 'festival' });
  const existing = (await store.getSeries('eras'))!;
  const next = { ...existing, kind: 'tour' as const };

  await runAsMember(owner, store as any, async () => {
    const entry = await saveSeriesLogged(store, existing, next);
    assert.ok(entry, 'a change is logged');
    assert.equal(entry!.operation, 'canonical-series');
    assert.equal((await store.getSeries('eras'))!.kind, 'tour');

    await undoHistory(store, entry!.id);
    assert.equal((await store.getSeries('eras'))!.kind, 'festival');
  });
});

test('saving an unchanged series logs nothing', async () => {
  const store = await freshStore();
  await store.upsertSeries({ slug: 'same', name: 'Same', kind: 'festival' });
  const existing = (await store.getSeries('same'))!;
  await runAsMember(owner, store as any, async () => {
    assert.equal(await saveSeriesLogged(store, existing, { ...existing }), null);
  });
});

test('undo refuses when the series changed after the logged change', async () => {
  const store = await freshStore();
  await store.upsertSeries({ slug: 'later', name: 'Later', kind: 'festival' });
  const existing = (await store.getSeries('later'))!;
  await runAsMember(owner, store as any, async () => {
    const entry = await saveSeriesLogged(store, existing, { ...existing, kind: 'tour' });
    await store.upsertSeries({ ...existing, kind: 'tour', name: 'Renamed later' });
    await assert.rejects(() => undoHistory(store, entry!.id), /changed after this/);
  });
});
