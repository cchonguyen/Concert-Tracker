import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newEvent } from '../src/server/events/service.ts';
import { undoActivity } from '../src/server/events/undo.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';

const NOW = new Date('2026-10-29T12:00:00Z');

async function freshStore() {
  return new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'undo-')));
}

test('undo puts an edited field back, and refuses when it changed again', async () => {
  const store = await freshStore();
  const e = newEvent('Blur at Roundhouse, Oct 5 2026', NOW);
  await store.putEvent(e);
  await store.putEvent({ ...e, venue: 'Brixton' });
  const edit = (await store.listActivity(50)).find((a) => a.action === 'update' && a.field === 'venue');
  assert.ok(edit, 'the venue edit is logged');

  assert.deepEqual(await undoActivity(store, edit.id), { ok: true });
  assert.equal((await store.getEvent(e.id))?.venue, 'Roundhouse');

  await store.putEvent({ ...e, venue: 'Electric Ballroom' });
  assert.deepEqual(await undoActivity(store, edit.id), { ok: false, reason: 'value-changed' }, 'a later change is not overwritten');
  assert.equal((await store.getEvent(e.id))?.venue, 'Electric Ballroom');
});

test('undo of an add moves the show to Recently deleted, and undo of a delete restores it', async () => {
  const store = await freshStore();
  const e = newEvent('Blur at Roundhouse, Oct 5 2026', NOW);
  await store.putEvent(e);
  const add = (await store.listActivity(50)).find((a) => a.action === 'create');
  assert.ok(add);
  assert.deepEqual(await undoActivity(store, add.id), { ok: true });
  assert.equal(await store.getEvent(e.id), null);
  assert.equal((await store.listDeletedEvents()).length, 1);

  await store.restoreEvent(e.id);
  await store.deleteEvent(e.id);
  const del = (await store.listActivity(50)).filter((a) => a.action === 'delete')[0];
  assert.deepEqual(await undoActivity(store, del.id), { ok: true });
  assert.ok(await store.getEvent(e.id));
});
