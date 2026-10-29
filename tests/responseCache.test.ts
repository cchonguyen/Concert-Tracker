import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { CACHEABLE_HOSTS, cacheKey, cachingFetcher, CACHE_TTL_MS } from '../src/server/lineup/responseCache.ts';
import type { Fetcher } from '../src/server/lineup/types.ts';

const TM = 'https://app.ticketmaster.com/discovery/v2/events.json?keyword=Fest&apikey=SECRET1&size=5';

function setup(status = 200) {
  const calls: string[] = [];
  const inner: Fetcher = { async get(url) { calls.push(url); return { url, status, headers: {}, body: `body-${calls.length}` }; } };
  return { calls, inner };
}
async function store() {
  return new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'cache-')));
}

test('cache: the key ignores the API key and parameter order, and differs by query', () => {
  const a = cacheKey(TM).key;
  assert.equal(cacheKey('https://app.ticketmaster.com/discovery/v2/events.json?size=5&apikey=OTHER&keyword=Fest').key, a);
  assert.notEqual(cacheKey(TM.replace('Fest', 'Other')).key, a);
  assert.ok(!JSON.stringify(cacheKey(TM)).includes('SECRET1'));
});

test('cache: a Ticketmaster response is reused for 24 hours, then fetched again', async () => {
  const s = await store();
  const { calls, inner } = setup();
  let now = new Date('2026-10-29T12:00:00Z');
  const f = cachingFetcher(inner, s, () => now);
  assert.equal((await f.get(TM)).body, 'body-1');
  assert.equal((await f.get(TM.replace('SECRET1', 'ANOTHER_KEY'))).body, 'body-1');
  assert.equal(calls.length, 1);
  now = new Date(now.getTime() + CACHE_TTL_MS - 1000);
  assert.equal((await f.get(TM)).body, 'body-1');
  now = new Date(now.getTime() + 2000);
  assert.equal((await f.get(TM)).body, 'body-2');
  assert.equal(calls.length, 2);
});

test('cache: Brave Search and every other host are never stored', async () => {
  assert.deepEqual([...CACHEABLE_HOSTS], ['app.ticketmaster.com']);
  const s = await store();
  const { calls, inner } = setup();
  const f = cachingFetcher(inner, s);
  for (const url of ['https://api.search.brave.com/res/v1/web/search?q=fest', 'https://clashfinder.com/data/event/x.json', 'https://example.com/lineup']) {
    await f.get(url);
    await f.get(url);
  }
  assert.equal(calls.length, 6);
  assert.deepEqual(Object.keys(((s as any).state ?? (await (s as any).load()))?.responseCache ?? {}), []);
});

test('cache: errors and rate limits are not kept', async () => {
  const s = await store();
  const { calls, inner } = setup(429);
  const f = cachingFetcher(inner, s);
  await f.get(TM);
  await f.get(TM);
  assert.equal(calls.length, 2);
});
