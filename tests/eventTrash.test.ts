import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diffEvent, stableJson } from '../src/server/events/activityLog.ts';
import { newEvent } from '../src/server/events/service.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';

const NOW = new Date('2026-10-29T12:00:00Z');

async function freshStore() {
  return new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'trash-')));
}

test('stableJson ignores key order', () => {
  assert.equal(stableJson({ a: 1, b: { c: 2, d: 3 } }), stableJson({ b: { d: 3, c: 2 }, a: 1 }));
});

test('diffEvent: a new event gives one create row, an edit gives one row per changed field', () => {
  const e = newEvent('Blur at Roundhouse, Oct 5 2026', NOW);
  assert.deepEqual(diffEvent(null, e).map((d) => d.action), ['create']);
  const edited = { ...e, venue: 'Brixton', updatedAt: '2026-10-30T00:00:00Z' };
  const rows = diffEvent(e, edited);
  assert.deepEqual(rows.map((d) => [d.action, d.field, d.before, d.after]), [['update', 'venue', 'Roundhouse', 'Brixton']]);
});

test('diffEvent blanks sensitive values', () => {
  const e = newEvent('Blur at Roundhouse, Oct 5 2026', NOW);
  const edited = { ...e, details: { ...e.details }, companions: ['Sam'] } as typeof e & { companions: string[] };
  const rows = diffEvent(e, edited);
  const row = rows.find((r) => r.field === 'companions');
  assert.ok(row);
  assert.equal(row.sensitive, true);
  assert.equal(row.before, null);
  assert.equal(row.after, null);
});

test('delete permanently erases only a trashed show, and empty trash clears all of them', async () => {
  const store = await freshStore();
  const kept = newEvent('Blur at Roundhouse, Oct 5 2026', NOW);
  const gone = newEvent('Brixton Academy, Oct 6 2026', NOW);
  const other = newEvent('Fred again.. at Alexandra Palace, Oct 7 2026', NOW);
  await store.putEvent(kept);
  await store.putEvent(gone);
  await store.putEvent(other);
  assert.equal(await store.eraseDeletedEvent(gone.id), false, 'a show that is not in the trash is not erased');
  await store.deleteEvent(gone.id);
  await store.deleteEvent(other.id);
  assert.equal(await store.eraseDeletedEvent(gone.id), true);
  assert.equal((await store.listDeletedEvents()).map((e) => e.id).join(), other.id);
  assert.equal(await store.emptyTrash(), 1);
  assert.deepEqual((await store.listDeletedEvents()), []);
  assert.equal((await store.listEvents())[0].id, kept.id, 'active shows are never touched');
});

test('delete hides a show, logs it, and restore brings it back', async () => {
  const store = await freshStore();
  const e = newEvent('Blur at Roundhouse, Oct 5 2026', NOW);
  await store.putEvent(e);
  assert.equal((await store.listEvents()).length, 1);

  await store.deleteEvent(e.id);
  assert.deepEqual(await store.listEvents(), []);
  assert.equal(await store.getEvent(e.id), null);
  const trash = await store.listDeletedEvents();
  assert.equal(trash.length, 1);
  assert.ok(trash[0].deletedAt);

  assert.equal(await store.restoreEvent(e.id), true);
  assert.equal((await store.listEvents()).length, 1);
  assert.equal((await store.listDeletedEvents()).length, 0);
  assert.equal(await store.restoreEvent(e.id), false);

  const actions = (await store.listActivity(10)).map((r) => r.action);
  assert.deepEqual(actions, ['restore', 'delete', 'create']);
});

test('saving a deleted show does not undelete it', async () => {
  const store = await freshStore();
  const e = newEvent('Blur at Roundhouse, Oct 5 2026', NOW);
  await store.putEvent(e);
  await store.deleteEvent(e.id);
  await store.putEvent({ ...e, venue: 'Brixton' });
  assert.equal((await store.listEvents()).length, 0);
  assert.equal((await store.listDeletedEvents())[0].venue, 'Brixton');
});

test('purge erases trash older than the cutoff and keeps live shows', async () => {
  const store = await freshStore();
  const gone = newEvent('Blur at Roundhouse, Oct 5 2026', NOW);
  const kept = newEvent('Pulp at Brixton, Oct 6 2026', NOW);
  await store.putEvent(gone);
  await store.putEvent(kept);
  await store.deleteEvent(gone.id);
  assert.equal(await store.purgeDeletedEvents('2000-01-01T00:00:00Z'), 0);
  assert.equal(await store.purgeDeletedEvents('2100-01-01T00:00:00Z'), 1);
  assert.deepEqual((await store.listEvents()).map((x) => x.id), [kept.id]);
  assert.equal((await store.listDeletedEvents()).length, 0);
});

test('a second delete does not log twice', async () => {
  const store = await freshStore();
  const e = newEvent('Blur at Roundhouse, Oct 5 2026', NOW);
  await store.putEvent(e);
  await store.deleteEvent(e.id);
  await store.deleteEvent(e.id);
  const deletes = (await store.listActivity(50)).filter((r) => r.action === 'delete');
  assert.equal(deletes.length, 1);
});
