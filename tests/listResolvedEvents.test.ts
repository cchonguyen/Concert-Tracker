import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listResolvedEvents } from '../src/server/events/inherit.ts';
import type { LoggedEvent } from '../src/server/events/types.ts';

const ev = (id: string, editionId?: string): LoggedEvent =>
  ({ id, name: 'Show', venue: 'Typed Venue', startDate: '2026-07-01', editionId } as unknown as LoggedEvent);

test('listResolvedEvents shows the edition venue for linked events and fetches each edition once', async () => {
  const asked: string[][] = [];
  const store = {
    listEvents: async () => [ev('a', 'ed1'), ev('b', 'ed1'), ev('c')],
    getEditions: async (ids: string[]) => {
      asked.push(ids);
      return [{ id: 'ed1', venue: 'Edition Venue' }] as any;
    },
  };
  const out = await listResolvedEvents(store as any);
  assert.equal(out[0].venue, 'Edition Venue');
  assert.equal(out[1].venue, 'Edition Venue');
  assert.equal(out[2].venue, 'Typed Venue');
  assert.deepEqual(asked, [['ed1']]);
});

test('listResolvedEvents asks for no editions when nothing is linked', async () => {
  let called = false;
  const store = {
    listEvents: async () => [ev('c')],
    getEditions: async () => { called = true; return []; },
  };
  await listResolvedEvents(store as any);
  assert.equal(called, false);
});
