import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newEvent } from '../src/server/events/service.ts';
import { undoActivity } from '../src/server/events/undo.ts';
import { canonicalIds } from '../src/server/events/activityLog.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import type { Entity } from '../src/server/entities/types.ts';

// Undo of a note or of the people you went with, through the real store. The ciphertext strings only need
// the shape the server checks (v1:<iv>:<data>); nothing here decrypts them.
const NOW = new Date('2026-10-29T12:00:00Z');
const CIPHER_1 = 'v1:aXZpdml2aXZpdml2:Y2lwaGVydGV4dDE=';
const CIPHER_2 = 'v1:aXZpdml2aXZpdml3:Y2lwaGVydGV4dDI=';
const CIPHER_3 = 'v1:aXZpdml2aXZpdml4:Y2lwaGVydGV4dDM=';
const P1 = '10000000-0000-4000-8000-000000000001';
const P2 = '10000000-0000-4000-8000-000000000002';

async function freshStore() {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'undo-vault-')));
  const person = (id: string): Entity => ({
    id, kind: 'person', name: '', nameNormalized: '', nameEncrypted: CIPHER_1, attrs: {},
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  await store.putEntities([person(P1), person(P2)]);
  return store;
}

async function rowWith(store: FileLineupStore, field: string, match: (a: { before: unknown; after: unknown }) => boolean) {
  const row = (await store.listActivity(50)).find((a) => a.action === 'update' && a.field === field && match(a));
  assert.ok(row, `a ${field} row is logged`);
  return row;
}

test('undo never writes an empty note over a note whose text was not stored', async () => {
  const store = await freshStore();
  const e = newEvent('Blur at Roundhouse, Oct 5 2026', NOW);
  await store.putEvent({ ...e, notes: 'my diary' });
  await store.putEvent({ ...e, notes: CIPHER_1 }); // what the vault does on unlock
  // Neither side of a row that dropped plaintext is kept, so the encryption row is the one with no before.
  const encrypt = await rowWith(store, 'notes', (a) => a.before === null && a.after === null);

  assert.deepEqual(await undoActivity(store, encrypt.id, false), { ok: false, reason: 'not-undoable' });
  assert.equal((await store.getEvent(e.id))?.notes, CIPHER_1, 'the note is still there');
});

test('undo of a note with the vault open writes back the earlier ciphertext, and not while locked', async () => {
  const store = await freshStore();
  const e = newEvent('Blur at Roundhouse, Oct 5 2026', NOW);
  await store.putEvent({ ...e, notes: CIPHER_1 });
  await store.putEvent({ ...e, notes: CIPHER_2 });
  const edit = await rowWith(store, 'notes', (a) => a.after === CIPHER_2);

  assert.deepEqual(await undoActivity(store, edit.id, true), { ok: false, reason: 'vault-locked' });
  assert.equal((await store.getEvent(e.id))?.notes, CIPHER_2);

  assert.deepEqual(await undoActivity(store, edit.id, false), { ok: true });
  assert.equal((await store.getEvent(e.id))?.notes, CIPHER_1);
});

test('undo of a note refuses when it was changed again after the logged write', async () => {
  const store = await freshStore();
  const e = newEvent('Blur at Roundhouse, Oct 5 2026', NOW);
  await store.putEvent({ ...e, notes: CIPHER_1 });
  await store.putEvent({ ...e, notes: CIPHER_2 });
  const edit = await rowWith(store, 'notes', (a) => a.after === CIPHER_2);
  await store.putEvent({ ...e, notes: CIPHER_3 });

  assert.deepEqual(await undoActivity(store, edit.id, false), { ok: false, reason: 'value-changed' });
  assert.equal((await store.getEvent(e.id))?.notes, CIPHER_3);
});

test('undo of the people you went with writes the earlier ids back once the vault is open', async () => {
  const store = await freshStore();
  const e = newEvent('Blur at Roundhouse, Oct 5 2026', NOW);
  await store.putEvent({ ...e, personIds: [P1] });
  await store.putEvent({ ...e, personIds: [P1, P2] });
  const add = await rowWith(store, 'personIds', (a) => canonicalIds(a.after)?.length === 2);

  assert.deepEqual(await undoActivity(store, add.id, true), { ok: false, reason: 'vault-locked' });
  assert.deepEqual(await undoActivity(store, add.id, false), { ok: true });
  assert.deepEqual(canonicalIds((await store.getEvent(e.id))?.personIds), [P1]);
});

test('undo of a clear puts the people back', async () => {
  const store = await freshStore();
  const e = newEvent('Blur at Roundhouse, Oct 5 2026', NOW);
  await store.putEvent({ ...e, personIds: [P1] });
  await store.putEvent({ ...e, personIds: [] });
  const clear = await rowWith(store, 'personIds', (a) => canonicalIds(a.after) === null);

  assert.deepEqual(await undoActivity(store, clear.id, false), { ok: true });
  assert.deepEqual(canonicalIds((await store.getEvent(e.id))?.personIds), [P1]);
});

test('undo of the people you went with refuses when one of them was merged away', async () => {
  const store = await freshStore();
  const e = newEvent('Blur at Roundhouse, Oct 5 2026', NOW);
  await store.putEvent({ ...e, personIds: [P1] });
  await store.putEvent({ ...e, personIds: [P2] });
  const swap = await rowWith(store, 'personIds', (a) => canonicalIds(a.after)?.[0] === P2);
  await store.putEntities([{ ...(await store.listEntities()).find((x) => x.id === P1)!, mergedIntoId: P2 }]);

  assert.deepEqual(await undoActivity(store, swap.id, false), { ok: false, reason: 'person-gone' });
  assert.deepEqual(canonicalIds((await store.getEvent(e.id))?.personIds), [P2], 'the event keeps its current people');
});
