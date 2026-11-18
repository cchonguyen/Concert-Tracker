import assert from 'node:assert/strict';
import test from 'node:test';
import { clashfinderFinder, resetClashfinderListMemo } from '../src/server/events/details.ts';
import type { FetchResponse, Fetcher } from '../src/server/lineup/types.ts';

// A fetcher that counts the list downloads and answers with an empty list.
function countingFetcher() {
  const calls: string[] = [];
  const fetcher = {
    async get(url: string): Promise<FetchResponse> {
      calls.push(url);
      return { url, status: 200, headers: {}, body: '{}' };
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

test('the Clashfinder list is downloaded once and reused for a day', async () => {
  resetClashfinderListMemo();
  const { fetcher, calls } = countingFetcher();
  const q = { name: 'Some Festival', year: 2026 } as Parameters<typeof clashfinderFinder.find>[0];
  await clashfinderFinder.find(q, fetcher);
  await clashfinderFinder.find(q, fetcher);
  assert.equal(calls.length, 1);
});

test('a failed download is not remembered, so the next check tries again', async () => {
  resetClashfinderListMemo();
  let calls = 0;
  const fetcher = {
    async get(url: string): Promise<FetchResponse> {
      calls += 1;
      return { url, status: 503, headers: {}, body: '' };
    },
  } as unknown as Fetcher;
  const q = { name: 'Some Festival', year: 2026 } as Parameters<typeof clashfinderFinder.find>[0];
  await clashfinderFinder.find(q, fetcher);
  await clashfinderFinder.find(q, fetcher);
  assert.equal(calls, 2);
});
