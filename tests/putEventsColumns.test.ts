import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseLineupStore } from '../src/server/lineup/store/supabaseStore.ts';
import type { LoggedEvent } from '../src/server/events/types.ts';

const ev = (id: string, patch: Partial<LoggedEvent> = {}): LoggedEvent => ({
  id,
  input: id,
  name: id,
  sources: {},
  details: { status: 'resolved', candidates: [], notes: [] },
  seen: [],
  daysAttended: [],
  companions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...patch,
});

// A client that records each upsert and answers every read with no rows.
function mockDb(upserts: Array<{ table: string; rows: Record<string, unknown>[] }>) {
  return {
    from(table: string) {
      const done = Promise.resolve({ data: [], error: null });
      const builder: any = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === 'then') return done.then.bind(done);
            if (prop === 'upsert' || prop === 'insert')
              return (rows: Record<string, unknown>[] | Record<string, unknown>) => {
                upserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
                return builder;
              };
            if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve({ data: null, error: null });
            return () => builder;
          },
        },
      );
      return builder;
    },
  } as any;
}

test('putEvents never sends a null for a column only some rows set', async () => {
  const upserts: Array<{ table: string; rows: Record<string, unknown>[] }> = [];
  const store = new SupabaseLineupStore(mockDb(upserts)).forUser({ userId: 'u-ann', role: 'member' });
  await store.putEvents([ev('a', { overrides: { venue: 'Mine' } as any }), ev('b'), ev('c')]);
  const events = upserts.filter((u) => u.table === 'logged_events');
  assert.equal(events.length, 2);
  for (const { rows } of events) {
    const keys = Object.keys(rows[0]).sort().join(',');
    assert.ok(rows.every((r) => Object.keys(r).sort().join(',') === keys));
  }
  const all = events.flatMap((u) => u.rows);
  assert.deepEqual(all.map((r) => r.id).sort(), ['a', 'b', 'c']);
  assert.ok(!all.some((r) => 'overrides' in r && r.overrides == null));
});
