import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { BRAVE_SETTING, BraveCount, braveCapFetcher, tagBraveFetcher } from '../src/server/events/braveBudget.ts';
import { braveSearch } from '../src/server/lineup/search.ts';
import { braveResults } from '../src/server/events/details.ts';
import type { Fetcher } from '../src/server/lineup/types.ts';

const NOW = new Date('2026-11-24T12:00:00Z');

test('braveCapFetcher records per-feature bySource across stage2_lineup, stage1_details, stage1_gemini and stage1_batch', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brave-attr-'));
  const store = new FileLineupStore(dir);
  const okJson = JSON.stringify({ web: { results: [{ url: 'https://example.com/fest', title: 'Coachella 2026', description: 'Apr 10, 2026' }] } });
  const inner: Fetcher = {
    async get(url) {
      return { url, status: 200, headers: {}, body: okJson };
    },
  };
  const fetcher = braveCapFetcher(inner, store, () => NOW);
  const prevKey = process.env.BRAVE_SEARCH_API_KEY;
  process.env.BRAVE_SEARCH_API_KEY = 'test-key';

  try {
    await braveSearch(fetcher, 'test-key', () => NOW).findLineupUrls({ eventName: 'Coachella', year: 2026 });
    await braveResults({ name: 'Coachella', year: 2026 }, fetcher);
    await braveResults({ name: 'Coachella', year: 2026 }, fetcher, 'stage1_gemini');
    await braveResults({ name: 'Coachella', year: 2026 }, tagBraveFetcher(fetcher, 'stage1_batch'));

    const counted = await store.getSetting<BraveCount>(BRAVE_SETTING);
    assert.deepEqual(counted, {
      month: '2026-11',
      used: 4,
      bySource: {
        stage2_lineup: 1,
        stage1_details: 1,
        stage1_gemini: 1,
        stage1_batch: 1,
      },
    });

    // At the 200 cap, braveCapFetcher short-circuits with 429 and stops incrementing.
    await store.putSetting<BraveCount>(BRAVE_SETTING, {
      month: '2026-11',
      used: 200,
      bySource: counted!.bySource,
    });
    const blocked = await fetcher.get('https://api.search.brave.com/res/v1/web/search?q=test', { braveSource: 'stage1_details' });
    assert.equal(blocked.status, 429);
    const after = await store.getSetting<BraveCount>(BRAVE_SETTING);
    assert.equal(after?.used, 200);
    assert.deepEqual(after?.bySource, counted!.bySource);
  } finally {
    if (prevKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = prevKey;
  }
});
