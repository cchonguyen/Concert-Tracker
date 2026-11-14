import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BRAVE_MONTHLY_CAP, BRAVE_SETTING, braveCapFetcher, braveUsed, takeBrave } from '../src/server/events/braveBudget.ts';
import { researchEvent, type DetailFinder } from '../src/server/events/details.ts';
import { newEvent } from '../src/server/events/service.ts';
import { braveSearch } from '../src/server/lineup/search.ts';
import { QuotaExhaustedError } from '../src/server/lineup/quota.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { fakeFetcher } from './fakes.ts';

const NOW = new Date('2026-11-14T12:00:00Z');
const BRAVE = 'https://api.search.brave.com/res/v1/web/search?q=test&count=10';
const TM = 'https://app.ticketmaster.com/discovery/v2/events.json?keyword=x';

async function withStore(fn: (store: FileLineupStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'brave-budget-'));
  try {
    await fn(new FileLineupStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function braveInner() {
  return fakeFetcher({
    'https://api.search.brave.com/': { body: { web: { results: [] } } },
    'https://app.ticketmaster.com/': { body: { _embedded: {} } },
  });
}

test('the first 200 Brave calls pass through; the 201st is a 429 with a reset time and never reaches the network', async () => {
  await withStore(async (store) => {
    const { fetcher, calls } = braveInner();
    const capped = braveCapFetcher(fetcher, store, () => NOW);
    for (let i = 0; i < BRAVE_MONTHLY_CAP; i++) {
      const res = await capped.get(BRAVE);
      assert.equal(res.status, 200);
    }
    assert.equal(calls.length, BRAVE_MONTHLY_CAP);
    assert.equal(await braveUsed(store, NOW), BRAVE_MONTHLY_CAP);

    const res = await capped.get(BRAVE);
    assert.equal(res.status, 429);
    assert.equal(res.body, '');
    // 2026-11-14 12:00 UTC to 2026-12-01 00:00 UTC is 16.5 days.
    assert.equal(res.headers['x-ratelimit-reset'], String((Date.parse('2026-12-01T00:00:00Z') - NOW.getTime()) / 1000));
    assert.equal(calls.length, BRAVE_MONTHLY_CAP, 'inner fetcher not called once capped');
  });
});

test('non-Brave hosts pass straight through and never consume the Brave counter', async () => {
  await withStore(async (store) => {
    const { fetcher, calls } = braveInner();
    const capped = braveCapFetcher(fetcher, store, () => NOW);
    for (let i = 0; i < BRAVE_MONTHLY_CAP + 5; i++) {
      const res = await capped.get(TM);
      assert.equal(res.status, 200);
    }
    assert.equal(calls.length, BRAVE_MONTHLY_CAP + 5);
    assert.equal(await braveUsed(store, NOW), 0);
    assert.equal(await store.getSetting(BRAVE_SETTING), null);
  });
});

test('the counter resets when the calendar month changes', async () => {
  await withStore(async (store) => {
    await store.putSetting(BRAVE_SETTING, { month: '2026-11', used: BRAVE_MONTHLY_CAP });
    const { fetcher, calls } = braveInner();
    const capped = braveCapFetcher(fetcher, store, () => new Date('2026-11-30T23:59:59Z'));
    assert.equal((await capped.get(BRAVE)).status, 429);
    assert.equal(calls.length, 0);

    const december = braveCapFetcher(fetcher, store, () => new Date('2026-12-01T00:00:01Z'));
    assert.equal((await december.get(BRAVE)).status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(await store.getSetting(BRAVE_SETTING), { month: '2026-12', used: 1 });
    assert.equal(await takeBrave(store, new Date('2026-12-01T00:00:01Z'), BRAVE_MONTHLY_CAP), false);
  });
});

test('braveSearch turns the capped 429 into a QuotaExhaustedError', async () => {
  await withStore(async (store) => {
    await store.putSetting(BRAVE_SETTING, { month: '2026-11', used: BRAVE_MONTHLY_CAP });
    const { fetcher, calls } = braveInner();
    const search = braveSearch(braveCapFetcher(fetcher, store, () => NOW), 'k', () => NOW);
    await assert.rejects(
      search.findLineupUrls({ eventName: 'Test Fest', year: 2024 }),
      (err: unknown) => err instanceof QuotaExhaustedError,
    );
    assert.equal(calls.length, 0);
  });
});

test('queued research with a Brave finder never writes the shared catalog', async () => {
  await withStore(async (store) => {
    const ev = newEvent('Test Fest Oct 5 2024', NOW);
    assert.equal(ev.startDate, '2024-10-05');
    const discovered: DetailFinder = {
      id: 'discovered',
      enabled: () => true,
      withoutYear: true,
      find: async () => [
        {
          id: 'c-discovered',
          name: 'Test Fest',
          startDate: '2024-10-05',
          venue: 'Greek Theatre',
          city: 'Los Angeles',
          sources: [{ sourceType: 'discovered', sourceUrl: 'https://x.example/e/1', fields: ['startDate', 'venue', 'city'] }],
        },
      ],
    };
    const out = await researchEvent(ev, [discovered], fakeFetcher({}).fetcher, NOW, undefined, {
      store,
      persist: true,
      persistOwn: false,
    });
    assert.equal(out.details.status, 'matched');
    assert.equal((await store.listEditions(10)).length, 0, 'no shared edition written from a Brave result');
    assert.ok(!out.details.notes.some((n) => n.startsWith('catalog:')), 'no persisted catalog line in notes');
  });
});
