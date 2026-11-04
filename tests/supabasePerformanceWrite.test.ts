import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseLineupStore } from '../src/server/lineup/store/supabaseStore.ts';
import type { ArtistEditionRow } from '../src/server/entities/types.ts';

// performances is keyed by `id` (migration 0029), so an ON CONFLICT upsert on (edition_id, artist_key) fails
// in Postgres. putArtistPerformances must replace rows with delete and insert, and never upsert.
function recordingDb() {
  const calls: Array<{ table: string; op: string; args?: any; filters: any[] }> = [];
  const db = {
    from(table: string) {
      const entry = { table, op: 'select', args: undefined as any, filters: [] as any[] };
      const b: any = {
        delete: () => ((entry.op = 'delete'), b),
        insert: (rows: any[]) => ((entry.op = 'insert'), (entry.args = rows), b),
        upsert: (rows: any[], opts: any) => ((entry.op = 'upsert'), (entry.args = { rows, opts }), b),
        eq: (c: string, v: any) => (entry.filters.push(['eq', c, v]), b),
        in: (c: string, vs: any[]) => (entry.filters.push(['in', c, vs]), b),
        then(resolve: any, reject: any) {
          calls.push(entry);
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
      return b;
    },
  };
  return { db, calls };
}

const row = (editionId: string, artistKey: string): ArtistEditionRow => ({
  editionId,
  artistKey,
  name: 'Act',
  days: [],
  stages: [],
  status: 'billed' as const,
  confidence: 1,
  sources: [],
});

test('putArtistPerformances never upserts on (edition_id, artist_key); it deletes then inserts per artist', async () => {
  const { db, calls } = recordingDb();
  const store = new SupabaseLineupStore(db as any);
  await store.putArtistPerformances([row('e1', 'target'), row('e2', 'target'), row('e1', 'other')]);

  assert.equal(calls.some((c) => c.op === 'upsert'), false, 'no ON CONFLICT upsert');
  const deletes = calls.filter((c) => c.op === 'delete');
  assert.equal(deletes.length, 2, 'one delete per artist key');
  const targetDelete = deletes.find((c) => c.filters.some((f) => f[0] === 'eq' && f[2] === 'target'));
  assert.deepEqual(targetDelete?.filters.find((f) => f[0] === 'in')?.[2], ['e1', 'e2']);

  const inserts = calls.filter((c) => c.op === 'insert');
  assert.equal(inserts.reduce((n, c) => n + c.args.length, 0), 3, 'every row is inserted');
  for (const c of inserts) assert.ok(c.args.every((r: any) => r.edition_id && r.artist_key));
});

test('putArtistPerformances with no rows makes no queries', async () => {
  const { db, calls } = recordingDb();
  await new SupabaseLineupStore(db as any).putArtistPerformances([]);
  assert.equal(calls.length, 0);
});
