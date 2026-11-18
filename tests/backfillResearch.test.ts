import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  BRAVE_MONTHLY_CAP,
  RESEARCH_BATCH_SIZE,
  braveUsed,
  runResearchBackfill,
  takeBrave,
  yearOnlyEvents,
} from '../src/server/events/backfillResearch.ts';
import type { DetailFinder } from '../src/server/events/details.ts';
import { newEvent } from '../src/server/events/service.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { fakeFetcher } from './fakes.ts';

const NOW = new Date('2026-11-13T12:00:00Z');
const fetcher = fakeFetcher({}).fetcher;

function finder(id: 'ticketmaster' | 'discovered', calls: string[]): DetailFinder {
  return {
    id,
    enabled: () => true,
    withoutYear: true,
    find: async (q) => {
      calls.push(`${id}:${q.name}`);
      return [
        {
          id: `c-${id}`,
          name: 'Test Fest',
          startDate: '2024-10-05',
          venue: 'Greek Theatre',
          city: 'Los Angeles',
          sources: [{ sourceType: id === 'ticketmaster' ? 'ticketmaster' : 'discovered', sourceUrl: 'https://x.example/e/1', fields: ['startDate', 'venue', 'city'] }],
        },
      ];
    },
  };
}

async function withStore(fn: (store: FileLineupStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'backfill-research-'));
  try {
    await fn(new FileLineupStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const dated = (n: number) => newEvent(`Test Fest ${n} Oct 5 2024`, NOW);

test('at most 5 pending events are researched per run, and the rest on the next', async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 7; i++) await store.putEvent(dated(i));
    const calls: string[] = [];
    const r1 = await runResearchBackfill(store, [finder('ticketmaster', calls)], fetcher, NOW, { budgetLeft: () => 1000, role: 'owner' });
    assert.equal(r1?.researched, RESEARCH_BATCH_SIZE);
    const left = (await store.listEvents()).filter((e) => e.details.status === 'pending');
    assert.equal(left.length, 2);
    const r2 = await runResearchBackfill(store, [finder('ticketmaster', calls)], fetcher, NOW, { budgetLeft: () => 1000, role: 'owner' });
    assert.equal(r2?.researched, 2);
    assert.equal((await store.listEvents()).filter((e) => e.details.status === 'pending').length, 0);
  });
});

test('the owner persists a shared occurrence; a member does not; Brave is not called when the free finders answer', async () => {
  await withStore(async (store) => {
    await store.putEvent(dated(1));
    const calls: string[] = [];
    await runResearchBackfill(store, [finder('ticketmaster', calls), finder('discovered', calls)], fetcher, NOW, { budgetLeft: () => 1000, role: 'owner', userId: 'u1' });
    assert.ok(!calls.some((c) => c.startsWith('discovered')), 'Brave (discovered) is not called when the free finders answer the gaps (Slice 3.3)');
    // Slice 11.23: the owner's own entry also makes a provisional edition, beside the Ticketmaster occurrence.
    assert.equal((await store.listEditions(100)).length, 2);
  });
  await withStore(async (store) => {
    await store.putEvent(dated(1));
    const r = await runResearchBackfill(store, [finder('ticketmaster', [])], fetcher, NOW, { budgetLeft: () => 1000, role: 'member', userId: 'u2' });
    assert.equal(r?.researched, 1);
    assert.equal((await store.listEvents())[0].details.status, 'matched', 'the member event is still researched');
    const rows = await store.listEditions(100);
    assert.equal(rows.length, 1, 'only the member\'s own entry is written (Slice 11.23), never the outside occurrence');
    assert.equal(rows[0].status, 'provisional');
  });
});

test('year-only events are not researched and are listed for confirmation', async () => {
  await withStore(async (store) => {
    const yo = newEvent('Kaskade 2024', NOW);
    await store.putEvent(yo);
    await store.putEvent(dated(1));
    const calls: string[] = [];
    const r = await runResearchBackfill(store, [finder('ticketmaster', calls)], fetcher, NOW, { budgetLeft: () => 1000, role: 'owner' });
    assert.equal(r?.researched, 1);
    assert.equal(r?.year_only, 1);
    assert.equal((await store.getEvent(yo.id))?.details.status, 'pending', 'untouched');
    assert.ok(!calls.some((c) => c.includes('Kaskade')));
    assert.deepEqual(yearOnlyEvents(await store.listEvents()).map((e) => e.id), [yo.id]);
  });
});

test('idempotent: a second run does nothing, and a failing event is not retried within a day', async () => {
  await withStore(async (store) => {
    await store.putEvent(dated(1));
    const calls: string[] = [];
    const f = finder('ticketmaster', calls);
    await runResearchBackfill(store, [f], fetcher, NOW, { budgetLeft: () => 1000, role: 'owner' });
    const n = calls.length;
    const again = await runResearchBackfill(store, [f], fetcher, NOW, { budgetLeft: () => 1000, role: 'owner' });
    assert.equal(again?.researched, 0);
    assert.equal(calls.length, n, 'no new finder calls');
  });
  await withStore(async (store) => {
    const ev = dated(2);
    await store.putEvent(ev);
    const failing = Object.assign(Object.create(store), {
      getEvent: async () => { throw new Error('store down'); },
    }) as FileLineupStore;
    const orig = console.error;
    console.error = () => {};
    try {
      const a = await runResearchBackfill(failing, [finder('ticketmaster', [])], fetcher, NOW, { budgetLeft: () => 1000, role: 'owner' });
      assert.equal(a?.researched, 1);
      const b = await runResearchBackfill(failing, [finder('ticketmaster', [])], fetcher, new Date(NOW.getTime() + 3600_000), { budgetLeft: () => 1000, role: 'owner' });
      assert.equal(b?.researched, 0, 'not retried within 24 hours');
      assert.equal(b?.skipped_recent, 1);
      const c = await runResearchBackfill(failing, [finder('ticketmaster', [])], fetcher, new Date(NOW.getTime() + 25 * 3600_000), { budgetLeft: () => 1000, role: 'owner' });
      assert.equal(c?.researched, 1, 'retried after a day');
    } finally {
      console.error = orig;
    }
  });
});

test('an event checked recently is skipped, and a short subrequest budget does nothing', async () => {
  await withStore(async (store) => {
    const ev = dated(1);
    await store.putEvent({ ...ev, details: { ...ev.details, checkedAt: NOW.toISOString() } });
    const r = await runResearchBackfill(store, [finder('ticketmaster', [])], fetcher, NOW, { budgetLeft: () => 1000, role: 'owner' });
    assert.equal(r?.skipped_recent, 1);
    assert.equal(r?.researched, 0);
    assert.equal(await runResearchBackfill(store, [finder('ticketmaster', [])], fetcher, NOW, { budgetLeft: () => 10 }), null);
  });
});

test('Brave monthly counter stops at the cap and resets with the calendar month', async () => {
  await withStore(async (store) => {
    assert.equal(await braveUsed(store, NOW), 0);
    for (let i = 0; i < BRAVE_MONTHLY_CAP; i++) assert.equal(await takeBrave(store, NOW), true);
    assert.equal(await takeBrave(store, NOW), false, 'the 201st is refused');
    assert.equal(await braveUsed(store, NOW), BRAVE_MONTHLY_CAP);
    assert.equal(await takeBrave(store, new Date('2026-11-30T23:59:59Z')), false, 'same month');
    assert.equal(await takeBrave(store, new Date('2026-12-01T00:00:00Z')), true, 'new month resets');
    assert.equal(await braveUsed(store, new Date('2026-12-02T00:00:00Z')), 1);
  });
});

test('Slice 3.1: a year and a city with no date is researched in the batch, and nothing is filled on its own', async () => {
  await withStore(async (store) => {
    const ev = { ...newEvent('Test Fest 2024', NOW), city: 'Los Angeles' };
    assert.equal(ev.year, 2024);
    await store.putEvent(ev);
    const calls: string[] = [];
    const r = await runResearchBackfill(store, [finder('ticketmaster', calls)], fetcher, NOW, { budgetLeft: () => 1000, role: 'owner' });
    assert.equal(r?.researched, 1);
    assert.ok(calls.some((c) => c.startsWith('ticketmaster:')), 'the structured finder searched');
    const after = await store.getEvent(ev.id);
    assert.notEqual(after?.details.status, 'pending', 'it left the queue');
    assert.equal(after?.startDate, undefined, 'no date is filled without your tap');
  });
});

test('Slice 3.1: a year alone, with no city, is still listed and not researched', async () => {
  await withStore(async (store) => {
    const yo = newEvent('Test Fest 2024', NOW);
    await store.putEvent(yo);
    const calls: string[] = [];
    const r = await runResearchBackfill(store, [finder('ticketmaster', calls)], fetcher, NOW, { budgetLeft: () => 1000, role: 'owner' });
    assert.equal(r?.researched, 0);
    assert.equal(calls.length, 0);
    assert.equal(r?.year_only, 1);
  });
});

test('Slice 3.4: the member batch is off unless its setting says on', async () => {
  const { membersResearchOn, RESEARCH_MEMBERS_SETTING } = await import('../src/server/events/backfillResearch.ts');
  assert.equal(RESEARCH_MEMBERS_SETTING, 'research_batch_members');
  assert.equal(membersResearchOn(null), false);
  assert.equal(membersResearchOn(undefined), false);
  assert.equal(membersResearchOn({ on: false }), false);
  assert.equal(membersResearchOn({ on: 'yes' as unknown as boolean }), false);
  assert.equal(membersResearchOn({ on: true }), true);
});
