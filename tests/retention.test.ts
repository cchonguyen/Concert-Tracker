import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isRetentionTime, retentionCutoffs, runRetention } from '../src/server/events/retention.ts';
import { newEvent } from '../src/server/events/service.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';

const DAY = 24 * 60 * 60 * 1000;

test('the job runs only at 03:00 UTC', () => {
  assert.equal(isRetentionTime(new Date('2026-10-29T03:00:00Z')), true);
  assert.equal(isRetentionTime(new Date('2026-10-29T03:01:00Z')), false);
  assert.equal(isRetentionTime(new Date('2026-10-29T04:00:00Z')), false);
});

test('cutoffs are 90 days for trash and one year for the Log', () => {
  const now = new Date('2026-10-29T03:00:00Z');
  const cutoffs = retentionCutoffs(now);
  assert.equal(cutoffs.trashBefore, new Date(now.getTime() - 90 * DAY).toISOString());
  assert.equal(cutoffs.logBefore, new Date(now.getTime() - 365 * DAY).toISOString());
});

test('the nightly run erases old trash and old Log rows, and keeps the rest', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'retention-')));
  const now = new Date('2026-10-29T03:00:00Z');
  const oldDelete = newEvent('Old at Venue One, Oct 5 2024', new Date(now.getTime() - 200 * DAY));
  const recentDelete = newEvent('Recent at Venue Two, Oct 5 2026', now);
  await store.putEvent(oldDelete);
  await store.putEvent(recentDelete);
  await store.deleteEvent(oldDelete.id);
  await store.deleteEvent(recentDelete.id);

  // Backdate the first delete and its Log rows past the trash window.
  const state = (store as any).state ?? (await (store as any).load());
  state.events[oldDelete.id].deletedAt = new Date(now.getTime() - 100 * DAY).toISOString();
  for (const row of state.activity) row.at = new Date(now.getTime() - 400 * DAY).toISOString();
  const logRows = state.activity.length;
  await (store as any).save();

  const purged = await runRetention(store, now);
  assert.equal(purged.events, 1);
  assert.equal(purged.activity, logRows);
  assert.equal((await store.listActivity(100)).length, 0);
  const trash = await store.listDeletedEvents();
  assert.deepEqual(trash.map((e) => e.id), [recentDelete.id]);
});
