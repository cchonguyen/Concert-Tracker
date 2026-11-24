import assert from 'node:assert/strict';
import test from 'node:test';
import { braveWebSearch } from '../src/server/lineup/search.ts';
import { setlistfmSearch } from '../src/server/lineup/adapters/setlistfm.ts';
import { ticketmasterEvents } from '../src/server/lineup/adapters/ticketmaster.ts';
import type { FetchResponse, Fetcher } from '../src/server/lineup/types.ts';

// One client per source, shared by Check details and Find the lineup (docs/specs/streamlining-plan.md, slice 3).
function fetcherAnswering(status: number, body: string, headers: Record<string, string> = {}) {
  const urls: string[] = [];
  const fetcher = {
    async get(url: string): Promise<FetchResponse> {
      urls.push(url);
      return { url, status, headers, body };
    },
  } as unknown as Fetcher;
  return { fetcher, urls };
}

test('Brave client: a 429 reports the longest reset window instead of throwing', async () => {
  const { fetcher } = fetcherAnswering(429, '', { 'x-ratelimit-reset': '1, 86400' });
  assert.deepEqual(await braveWebSearch(fetcher, '"Fest" 2026', 'k'), { limited: true, resetSeconds: 86400 });
});

test('Brave client: a rejected key throws with its reason', async () => {
  const { fetcher } = fetcherAnswering(401, '');
  await assert.rejects(braveWebSearch(fetcher, 'x', 'k'), /rejected the key/);
});

test('Brave client: results come back with title and description', async () => {
  const { fetcher } = fetcherAnswering(200, JSON.stringify({ web: { results: [{ url: 'https://a.example', title: 'Fest', description: 'May 16' }] } }));
  const r = await braveWebSearch(fetcher, 'x', 'k');
  assert.equal(r.limited, false);
  assert.equal(r.limited === false && r.results[0].title, 'Fest');
});

test('setlist.fm client: a 404 means no setlists, not an error', async () => {
  const { fetcher } = fetcherAnswering(404, 'not found');
  assert.deepEqual((await setlistfmSearch(fetcher, { artistName: 'Kaskade', p: '1' })).setlist, []);
});

test('Ticketmaster client: sends the window and city, returns the listings', async () => {
  const { fetcher, urls } = fetcherAnswering(200, JSON.stringify({ _embedded: { events: [{ id: '1', name: 'Fest' }] } }));
  const events = await ticketmasterEvents(fetcher, { keyword: 'Fest', from: '2026-05-01', to: '2026-05-31', city: 'Austin' });
  assert.equal(events.length, 1);
  const u = new URL(urls[0]);
  assert.equal(u.searchParams.get('startDateTime'), '2026-05-01T00:00:00Z');
  assert.equal(u.searchParams.get('endDateTime'), '2026-05-31T23:59:59Z');
  assert.equal(u.searchParams.get('city'), 'Austin');
  assert.equal(u.searchParams.get('classificationName'), 'music');
});
