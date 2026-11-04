import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { planArtistChange } from '../src/server/entities/canonicalManage.ts';
import { CANONICAL_OPERATIONS, type HistoryEntry } from '../src/server/entities/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { SupabaseLineupStore } from '../src/server/lineup/store/supabaseStore.ts';
import {
  CanonicalHistoryCursorError,
  decodeCanonicalHistoryCursor,
  encodeCanonicalHistoryCursor,
  normalizeCanonicalHistoryLimit,
} from '../src/server/lineup/store/types.ts';

// Slice 8.9: canonical history page (listCanonicalHistoryPage) with the operation filter before the limit,
// and a keyset cursor on (createdAt, id) descending. Supabase is tested against a stub client only (no network).

const AT = '2026-11-03T00:00:00.000Z';

function historyEntry(id: string, operation: HistoryEntry['operation'], createdAt: string, undoneAt?: string): HistoryEntry {
  return {
    id,
    operation,
    summary: `${operation} ${id}`,
    sourceEntityId: 'source',
    entities: { before: [], after: [] },
    touched: [],
    aliases: { before: [], after: [] },
    links: { before: [], after: [] },
    events: [],
    createdAt,
    ...(undoneAt ? { undoneAt } : {}),
  };
}

async function emptyStore(): Promise<FileLineupStore> {
  return new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'slice89-')));
}

// Drains every page, failing if the cursor loops.
async function allPages(store: FileLineupStore, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const page = await store.listCanonicalHistoryPage({ limit, cursor });
    assert.ok(page.entries.length <= limit);
    ids.push(...page.entries.map((e) => e.id));
    if (page.nextCursor === null) return ids;
    cursor = page.nextCursor;
  }
  assert.fail('paging did not end');
}

test('FileStore excludes non-canonical operations even when they are newer', async () => {
  const store = await emptyStore();
  await store.putEntityHistory(historyEntry('newest-rename', 'rename', '2026-11-03T03:00:00.000Z'));
  await store.putEntityHistory(historyEntry('alias-add', 'canonical-alias-add', '2026-11-03T02:00:00.000Z'));
  await store.putEntityHistory(historyEntry('merge', 'canonical-merge', '2026-11-03T01:00:00.000Z'));

  const first = await store.listCanonicalHistoryPage({ limit: 1 });
  assert.deepEqual(first.entries.map((e) => e.id), ['alias-add']);
  assert.equal(first.entries[0].operation, 'canonical-alias-add');
  assert.notEqual(first.nextCursor, null);

  const second = await store.listCanonicalHistoryPage({ limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.entries.map((e) => e.id), ['merge']);
  assert.equal(second.nextCursor, null);
});

test('a page boundary inside equal created_at timestamps returns each entry exactly once', async () => {
  const store = await emptyStore();
  for (const id of ['h1', 'h2', 'h3', 'h4', 'h5']) {
    await store.putEntityHistory(historyEntry(id, 'canonical-rename', AT));
  }
  const ids = await allPages(store, 2);
  assert.deepEqual(ids, ['h5', 'h4', 'h3', 'h2', 'h1']);
  assert.equal(new Set(ids).size, ids.length);
});

test('an entry older than the newest N canonical entries is reachable by paging', async () => {
  const store = await emptyStore();
  await store.putEntityHistory(historyEntry('old', 'canonical-merge', '2026-01-01T00:00:00.000Z'));
  for (let i = 1; i <= 4; i++) {
    await store.putEntityHistory(historyEntry(`canon-${i}`, 'canonical-alias-remove', `2026-11-03T0${i}:00:00.000Z`));
  }
  for (let i = 1; i <= 10; i++) {
    await store.putEntityHistory(historyEntry(`plain-${i}`, 'details', `2026-11-03T1${i % 10}:00:00.000Z`));
  }
  const ids = await allPages(store, 2);
  assert.equal(ids.length, 5);
  assert.equal(ids.at(-1), 'old');
  assert.ok(!ids.some((id) => id.startsWith('plain-')));
});

test('the apply path changes are read, with undoneAt after Undo', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'slice89-apply-'));
  const state = {
    artists: { 'old artist': { key: 'old artist', name: 'Old Artist' } },
    editions: {
      ed1: {
        id: 'ed1',
        key: 'fest/2025',
        seriesSlug: 'fest',
        year: 2025,
        name: 'Fest 2025',
        status: 'confirmed',
        updatedAt: AT,
        performances: [{ artistKey: 'old artist', name: 'Old Artist', days: ['Fri'], stages: ['Main'], status: 'billed', confidence: 1, sources: [] }],
      },
    },
    aliases: {},
  };
  await writeFile(path.join(dir, 'lineup-store.json'), JSON.stringify(state));
  const store = new FileLineupStore(dir);
  const plan = await planArtistChange(store, 'old artist', { op: 'rename', name: 'New Artist' }, AT);
  const fingerprint = await store.canonicalArtistFingerprint(plan.entry);
  await store.applyCanonicalArtistChange(plan.entry, fingerprint);
  await store.putEntityHistory(historyEntry('later-alias', 'canonical-alias-add', '2026-11-03T05:00:00.000Z'));

  let page = await store.listCanonicalHistoryPage();
  assert.deepEqual(page.entries.map((e) => [e.id, e.operation]), [
    ['later-alias', 'canonical-alias-add'],
    [plan.id, 'canonical-rename'],
  ]);
  assert.equal(page.entries[1].undoneAt, undefined);

  await store.undoCanonicalArtistChange(plan.id);
  page = await store.listCanonicalHistoryPage();
  assert.equal(page.entries[1].id, plan.id);
  assert.equal(typeof page.entries[1].undoneAt, 'string');
});

test('the cursor round-trips and rejects malformed input with a typed error', () => {
  const key = { createdAt: '2026-11-03T00:00:00.000Z', id: 'abc-123' };
  assert.deepEqual(decodeCanonicalHistoryCursor(encodeCanonicalHistoryCursor(key)), key);

  const hex = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('hex');
  const malformed = [
    '',
    'zz',
    'abc', // odd length
    hex('not json').slice(0, -2) + 'x1', // not hex
    Buffer.from([0xff, 0xfe]).toString('hex'), // not UTF-8
    hex('[1,2]'),
    hex({ c: key.createdAt }),
    hex({ c: key.createdAt, i: key.id, extra: 1 }),
    hex({ c: 'yesterday', i: key.id }),
    hex({ c: key.createdAt, i: 'a,b' }), // a comma would change a PostgREST filter
    hex({ c: key.createdAt, i: 'a.eq.x' }),
    hex({ c: key.createdAt, i: 7 }),
  ];
  for (const cursor of malformed) {
    assert.throws(() => decodeCanonicalHistoryCursor(cursor), CanonicalHistoryCursorError, `cursor ${cursor}`);
  }
  assert.throws(() => encodeCanonicalHistoryCursor({ createdAt: key.createdAt, id: 'a,b' }), CanonicalHistoryCursorError);
});

test('FileStore rejects a malformed cursor before reading any page', async () => {
  const store = await emptyStore();
  await assert.rejects(store.listCanonicalHistoryPage({ cursor: 'not-a-cursor' }), CanonicalHistoryCursorError);
});

test('limit defaults to 50, clamps to 1..100, and rejects non-integers', () => {
  assert.equal(normalizeCanonicalHistoryLimit(undefined), 50);
  assert.equal(normalizeCanonicalHistoryLimit(1), 1);
  assert.equal(normalizeCanonicalHistoryLimit(100), 100);
  assert.equal(normalizeCanonicalHistoryLimit(0), 1);
  assert.equal(normalizeCanonicalHistoryLimit(-5), 1);
  assert.equal(normalizeCanonicalHistoryLimit(500), 100);
  assert.throws(() => normalizeCanonicalHistoryLimit(Number.NaN), RangeError);
  assert.throws(() => normalizeCanonicalHistoryLimit(2.5), RangeError);
});

test('FileStore returns at most the clamped limit', async () => {
  const store = await emptyStore();
  for (const id of ['a', 'b', 'c']) await store.putEntityHistory(historyEntry(id, 'canonical-merge', AT));
  const page = await store.listCanonicalHistoryPage({ limit: 0 });
  assert.equal(page.entries.length, 1);
  assert.notEqual(page.nextCursor, null);
});

// Stub client: records each builder call in order and resolves to the given rows. Nothing touches the network.
function stubClient(rows: unknown[]) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder: any = {};
  for (const method of ['select', 'in', 'order', 'or', 'limit', 'eq']) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve, reject);
  const db = {
    from: (table: string) => {
      calls.push({ method: 'from', args: [table] });
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

const row = (id: string, createdAt: string, undoneAt: string | null = null) => ({
  id,
  operation: 'canonical-rename',
  created_at: createdAt,
  undone_at: undoneAt,
  manifest: { id, operation: 'canonical-rename', createdAt, summary: id },
});

test('Supabase query filters on operation before the limit, ordered by created_at and id desc', async () => {
  const { db, calls } = stubClient([]);
  await new SupabaseLineupStore(db).listCanonicalHistoryPage({ limit: 10 });

  assert.deepEqual(calls.map((c) => c.method), ['from', 'select', 'in', 'order', 'order', 'limit']);
  assert.deepEqual(calls[0].args, ['entity_history']);
  assert.deepEqual(calls[1].args, ['id, operation, created_at, undone_at, manifest']);
  assert.deepEqual(calls[2].args, ['operation', [...CANONICAL_OPERATIONS]]);
  assert.deepEqual(calls[3].args, ['created_at', { ascending: false }]);
  assert.deepEqual(calls[4].args, ['id', { ascending: false }]);
  assert.deepEqual(calls[5].args, [11]);
});

test('Supabase keyset condition applies before the limit and uses the cursor pair', async () => {
  const cursor = encodeCanonicalHistoryCursor({ createdAt: '2026-11-03T00:00:00.000Z', id: 'abc' });
  const { db, calls } = stubClient([]);
  await new SupabaseLineupStore(db).listCanonicalHistoryPage({ limit: 5, cursor });

  const or = calls.find((c) => c.method === 'or');
  assert.deepEqual(or?.args, ['created_at.lt.2026-11-03T00:00:00.000Z,and(created_at.eq.2026-11-03T00:00:00.000Z,id.lt.abc)']);
  const order = calls.map((c) => c.method);
  assert.ok(order.indexOf('in') < order.indexOf('limit'));
  assert.ok(order.indexOf('or') < order.indexOf('limit'));
});

test('Supabase page returns the nextCursor from the last returned row and maps undone_at', async () => {
  const rows = [row('r3', '2026-11-03T03:00:00.000Z'), row('r2', '2026-11-03T02:00:00.000Z', '2026-11-03T09:00:00.000Z'), row('r1', '2026-11-03T01:00:00.000Z')];
  const { db } = stubClient(rows);
  const page = await new SupabaseLineupStore(db).listCanonicalHistoryPage({ limit: 2 });

  assert.deepEqual(page.entries.map((e) => e.id), ['r3', 'r2']);
  assert.equal(page.entries[1].undoneAt, '2026-11-03T09:00:00.000Z');
  assert.equal(page.entries[0].undoneAt, undefined);
  assert.deepEqual(decodeCanonicalHistoryCursor(page.nextCursor as string), { createdAt: '2026-11-03T02:00:00.000Z', id: 'r2' });
});

test('Supabase last page has a null nextCursor', async () => {
  const { db } = stubClient([row('r2', '2026-11-03T02:00:00.000Z'), row('r1', '2026-11-03T01:00:00.000Z')]);
  const page = await new SupabaseLineupStore(db).listCanonicalHistoryPage({ limit: 2 });
  assert.equal(page.entries.length, 2);
  assert.equal(page.nextCursor, null);
});

test('Supabase rejects a malformed cursor before querying', async () => {
  const { db, calls } = stubClient([]);
  await assert.rejects(new SupabaseLineupStore(db).listCanonicalHistoryPage({ cursor: 'zz' }), CanonicalHistoryCursorError);
  assert.equal(calls.length, 0);
});
