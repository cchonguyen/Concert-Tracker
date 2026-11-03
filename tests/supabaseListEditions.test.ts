import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseLineupStore } from '../src/server/lineup/store/supabaseStore.ts';

// Counts each query (one from() call = one Worker subrequest). listEditions used
// to load every edition with its own query, which broke Workers' limit of 50.
function mockDb(editions: any[], perfs: any[]) {
  const counter = { calls: 0 };
  const db = {
    from(table: string) {
      counter.calls++;
      const st: any = {};
      const b: any = {
        select: () => b,
        order: () => b,
        eq: (c: string, v: any) => ((st.eq = [c, v]), b),
        in: (c: string, vs: any[]) => ((st.in = [c, vs]), b),
        limit: (n: number) => ((st.limit = n), b),
        range: (f: number, t: number) => ((st.range = [f, t]), b),
        maybeSingle: () => b,
        then(resolve: any, reject: any) {
          let rows = table === 'event_editions' ? editions.slice() : perfs.slice();
          if (st.in) rows = rows.filter((r) => st.in[1].includes(r[st.in[0]]));
          if (st.eq) rows = rows.filter((r) => r[st.eq[0]] === st.eq[1]);
          if (st.limit != null) rows = rows.slice(0, st.limit);
          if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1);
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return b;
    },
  };
  return { db, counter };
}

test('listEditions loads many editions in a handful of queries, in list order', async () => {
  const editions = Array.from({ length: 250 }, (_, i) => ({
    id: `e${i}`,
    key: `series/${i}`,
    series_slug: 'series',
    year: 2000 + (i % 25),
    name: `Edition ${i}`,
    status: 'confirmed',
    updated_at: `2026-01-${String(i % 28 + 1).padStart(2, '0')}T00:00:00Z`,
  }));
  const perfs = editions.flatMap((e) =>
    [0, 1, 2].map((k) => ({ edition_id: e.id, artist_key: `${e.id}-${k}`, name: `Act ${k}`, days: [], stages: [], status: 'billed', confidence: 1, sources: [] })),
  );
  const { db, counter } = mockDb(editions, perfs);
  const store = new SupabaseLineupStore(db as any);
  const out = await store.listEditions(200);

  assert.equal(out.length, 200);
  assert.equal(out[0].id, 'e0');
  assert.equal(out[0].performances.length, 3);
  assert.ok(counter.calls <= 8, `expected a handful of queries, got ${counter.calls}`);
});
