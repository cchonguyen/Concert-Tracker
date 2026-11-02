import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { SupabaseLineupStore } from '../src/server/lineup/store/supabaseStore.ts';
import type { LoggedEvent } from '../src/server/events/types.ts';

const ev = (id: string, artists: string[], patch: Partial<LoggedEvent> = {}): LoggedEvent => ({
  id,
  input: id,
  name: id,
  sources: {},
  details: { status: 'resolved', candidates: [], notes: [] },
  seen: artists.map((name) => ({ key: name.toLowerCase(), name, from: 'you' as const })),
  daysAttended: [],
  companions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...patch,
});

const ANN = { userId: 'u-ann', role: 'member' as const };
const BOB = { userId: 'u-bob', role: 'member' as const };

test('scopedFileStore: returns only the scoped member\'s seen artist names', async () => {
  const baseStore = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'seen-names-')));
  const annStore = baseStore.forUser(ANN);
  const bobStore = baseStore.forUser(BOB);

  await annStore.putEvents([
    ev('a1', ['Radiohead', 'The Smile']),
    ev('a2', ['Thom Yorke']),
  ]);
  await bobStore.putEvent(ev('b1', ['Portishead', 'Massive Attack']));

  const annNames = await annStore.listSeenArtistNames();
  const bobNames = await bobStore.listSeenArtistNames();

  assert.deepEqual(annNames.sort(), ['Radiohead', 'The Smile', 'Thom Yorke'].sort());
  assert.deepEqual(bobNames.sort(), ['Massive Attack', 'Portishead'].sort());

  // Base store contains all seen artist names across members
  const allNames = await baseStore.listSeenArtistNames();
  assert.deepEqual(
    allNames.sort(),
    ['Massive Attack', 'Portishead', 'Radiohead', 'The Smile', 'Thom Yorke'].sort(),
  );
});

test('scopedFileStore: excludes deleted events from listSeenArtistNames', async () => {
  const baseStore = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'seen-names-del-')));
  const annStore = baseStore.forUser(ANN);

  await annStore.putEvents([
    ev('a1', ['Radiohead']),
    ev('a2', ['Thom Yorke']),
  ]);

  let names = await annStore.listSeenArtistNames();
  assert.deepEqual(names.sort(), ['Radiohead', 'Thom Yorke'].sort());

  // Delete event a2
  await annStore.deleteEvent('a2');

  names = await annStore.listSeenArtistNames();
  assert.deepEqual(names, ['Radiohead']);

  // Base store also excludes deleted events
  assert.deepEqual(await baseStore.listSeenArtistNames(), ['Radiohead']);
});

test('SupabaseLineupStore: pages through rows and respects scoping in listSeenArtistNames', async () => {
  const queries: Array<{ table: string; select?: string; range?: [number, number]; filters: any[] }> = [];

  // Mock Supabase client
  const createMockDb = (totalRows: number) => {
    return {
      from(table: string) {
        const queryState: any = {
          table,
          filters: [],
        };
        const builder: any = {
          select(cols: string) {
            queryState.select = cols;
            return builder;
          },
          is(col: string, val: any) {
            queryState.filters.push({ op: 'is', col, val });
            return builder;
          },
          eq(col: string, val: any) {
            queryState.filters.push({ op: 'eq', col, val });
            return builder;
          },
          range(from: number, to: number) {
            queryState.range = [from, to];
            queries.push({ ...queryState });

            // Generate mock page data
            const count = Math.max(0, Math.min(to - from + 1, totalRows - from));
            const data: any[] = [];
            for (let i = 0; i < count; i++) {
              const idx = from + i;
              data.push({ seen: [{ name: `Artist ${idx}` }] });
            }
            return Promise.resolve({ data, error: null });
          },
        };
        return builder;
      },
    } as any;
  };

  // Test with 1500 rows to verify paging (page 1: 1000 rows, page 2: 500 rows)
  const mockDb = createMockDb(1500);
  const store = new SupabaseLineupStore(mockDb).forUser(ANN);

  const names = await store.listSeenArtistNames();
  assert.equal(names.length, 1500);
  assert.equal(names[0], 'Artist 0');
  assert.equal(names[1499], 'Artist 1499');

  // Verify pagination ranges called
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0].range, [0, 999]);
  assert.deepEqual(queries[1].range, [1000, 1999]);

  // Verify scoping filter was applied to each query
  for (const q of queries) {
    assert.equal(q.table, 'logged_events');
    assert.equal(q.select, 'seen');
    assert.ok(q.filters.some((f) => f.col === 'user_id' && f.val === ANN.userId));
    assert.ok(q.filters.some((f) => f.col === 'deleted_at' && f.val === null));
  }
});
