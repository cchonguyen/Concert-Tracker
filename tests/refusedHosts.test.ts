import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeRefusals, hostOf, refusalFetcher, REFUSAL_WINDOW_MS, saveRefusals } from '../src/server/events/refusedHosts.ts';
import { fakeFetcher } from './fakes.ts';

// Stage 4.3: a host that answered 403 in the last 30 days is not fetched again; the list is learned and kept in app_settings.

const NOW = new Date('2026-11-18T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

test('stage 4.3: hostOf drops www. and lower-cases', () => {
  assert.equal(hostOf('https://WWW.Example.com/a?b=1'), 'example.com');
  assert.equal(hostOf('not a url'), null);
});

test('stage 4.3: refusals older than 30 days are dropped', () => {
  const map = {
    'fresh.example': new Date(NOW.getTime() - 5 * DAY).toISOString(),
    'stale.example': new Date(NOW.getTime() - (REFUSAL_WINDOW_MS + DAY)).toISOString(),
    'garbage.example': 'not a date',
  };
  assert.deepEqual(Object.keys(activeRefusals(map, NOW)), ['fresh.example']);
});

test('stage 4.3: a refused host is answered 403 without a request, other hosts pass through', async () => {
  const { fetcher, calls } = fakeFetcher({
    'https://blocked.example/': { status: 403, body: '' },
    'https://open.example/': { body: '<html>ok</html>' },
  });
  const refusals: Record<string, string> = {};
  const guarded = refusalFetcher(fetcher, refusals, NOW);

  const first = await guarded.get('https://blocked.example/page');
  assert.equal(first.status, 403);
  assert.equal(refusals['blocked.example'], NOW.toISOString(), 'the new 403 is recorded');
  assert.equal(calls.length, 1);

  const second = await guarded.get('https://blocked.example/other');
  assert.equal(second.status, 403);
  assert.equal(calls.length, 1, 'no request was made for the refused host');

  const open = await guarded.get('https://open.example/x');
  assert.equal(open.status, 200);
  assert.equal(calls.length, 2);
});

test('stage 4.3: saveRefusals writes only when the list changed', async () => {
  const writes: Array<{ key: string; data: unknown }> = [];
  const store = { putSetting: async (key: string, data: unknown) => void writes.push({ key, data }) } as any;
  const before = { 'a.example': NOW.toISOString() };
  await saveRefusals(store, before, { ...before }, NOW);
  assert.equal(writes.length, 0, 'an unchanged list is not written');
  await saveRefusals(store, before, { ...before, 'b.example': NOW.toISOString() }, NOW);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, 'refused_hosts');
});
