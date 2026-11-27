import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { SupabaseLineupStore } from '../src/server/lineup/store/supabaseStore.ts';
import type { ArtistGenres } from '../src/server/events/genres.ts';
import type { LoggedEvent } from '../src/server/events/types.ts';

const OWNER = { userId: 'u-owner', role: 'owner' as const };
const ANN = { userId: 'u-ann', role: 'member' as const };
const BOB = { userId: 'u-bob', role: 'member' as const };

const row = (key: string, source: ArtistGenres['source'], style = 'house', checkedAt = '2026-01-01T00:00:00Z'): ArtistGenres => ({
  key,
  name: key,
  source,
  genres: [{ parent: 'electronic', style, weight: 1 }],
  checkedAt,
});

const ev = (id: string, seen: Array<[string, string]>, patch: Partial<LoggedEvent> = {}): LoggedEvent => ({
  id,
  input: id,
  name: id,
  sources: {},
  details: { status: 'resolved', candidates: [], notes: [] },
  seen: seen.map(([key, name]) => ({ key, name, from: 'you' as const })),
  daysAttended: [],
  companions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...patch,
});

async function fileStore() {
  return new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'canonical-genres-')));
}

test('file store: a member reads the shared genres plus their own as added', async () => {
  const s = await fileStore();
  await s.writeArtistGenres([{ key: 'zedd', source: 'owner', row: row('zedd', 'owner') }], { actor: 'owner', reason: 'Set in the app' });
  await s.forUser(ANN).putArtistGenres([row('zedd', 'added', 'techno')]);
  const ann = await s.forUser(ANN).listArtistGenres();
  assert.deepEqual(ann.map((g) => `${g.key}:${g.source}`).sort(), ['zedd:added', 'zedd:owner']);
  assert.deepEqual((await s.forUser(BOB).listArtistGenres()).map((g) => `${g.key}:${g.source}`), ['zedd:owner']);
  assert.deepEqual((await s.forUser(OWNER).listArtistGenres()).map((g) => `${g.key}:${g.source}`), ['zedd:owner']);
});

test('file store: a member put writes only their added row, never the shared one', async () => {
  const s = await fileStore();
  await s.forUser(ANN).putArtistGenres([row('moon garden', 'added')]);
  assert.deepEqual(await s.listArtistGenres(), []);
  await assert.rejects(s.forUser(ANN).putArtistGenres([row('moon garden', 'owner')]), /only keep genres they set/);
  await assert.rejects(s.forUser(ANN).putArtistGenres([row('moon garden', 'music-story')]), /only keep genres they set/);
  await s.forUser(ANN).deleteArtistGenres('moon garden', 'owner');
  assert.equal((await s.forUser(ANN).listArtistGenres()).length, 1);
  await s.forUser(ANN).deleteArtistGenres('moon garden', 'added');
  assert.deepEqual(await s.forUser(ANN).listArtistGenres(), []);
  assert.deepEqual(await s.listGenreChanges({}), []);
});

test('file store: writeArtistGenres logs before and after, and skips a change of checkedAt only', async () => {
  const s = await fileStore();
  const first = await s.writeArtistGenres([{ key: 'zedd', source: 'owner', row: row('zedd', 'owner') }], { actor: 'owner', reason: 'Genres file upload', batchId: 'b1' });
  assert.equal(first.length, 1);
  assert.equal(first[0].before, null);
  assert.equal(first[0].after?.genres[0].style, 'house');
  assert.equal(first[0].batchId, 'b1');
  assert.equal(first[0].actor, 'owner');

  const recheck = await s.writeArtistGenres([{ key: 'zedd', source: 'owner', row: row('zedd', 'owner', 'house', '2026-02-01T00:00:00Z') }], { actor: 'system:musicbrainz', reason: 'MusicBrainz lookup' });
  assert.deepEqual(recheck, []);
  assert.equal((await s.listArtistGenres())[0].checkedAt, '2026-02-01T00:00:00Z');

  const changed = await s.writeArtistGenres([{ key: 'zedd', source: 'owner', row: row('zedd', 'owner', 'techno') }], { actor: 'owner', reason: 'Set in the app' });
  assert.equal(changed[0].before?.genres[0].style, 'house');
  assert.equal(changed[0].after?.genres[0].style, 'techno');

  const removed = await s.writeArtistGenres([{ key: 'zedd', source: 'owner', row: null }], { actor: 'owner', reason: 'Reset to found genres' });
  assert.equal(removed[0].after, null);
  assert.equal(removed[0].before?.genres[0].style, 'techno');
  assert.deepEqual(await s.listArtistGenres(), []);
  assert.equal((await s.listGenreChanges({})).length, 3);
});

test('file store: listGenreChanges filters by key, batch, latest batch reason and limit', async () => {
  const s = await fileStore();
  const up = { actor: 'owner' as const, reason: 'Genres file upload' };
  await s.writeArtistGenres([{ key: 'a', source: 'owner', row: row('a', 'owner') }, { key: 'b', source: 'owner', row: row('b', 'owner') }], { ...up, batchId: 'b1' });
  await s.writeArtistGenres([{ key: 'a', source: 'owner', row: row('a', 'owner', 'techno') }], { ...up, batchId: 'b2' });
  await s.writeArtistGenres([{ key: 'c', source: 'music-story', row: row('c', 'music-story') }], { actor: 'system:music-story', reason: 'music-story file upload', batchId: 'm1' });

  const all = await s.listGenreChanges({});
  assert.deepEqual(all.map((c) => c.key), ['c', 'a', 'b', 'a']);
  assert.deepEqual((await s.listGenreChanges({ key: 'a' })).map((c) => c.batchId), ['b2', 'b1']);
  assert.deepEqual((await s.listGenreChanges({ key: 'a', limit: 1 })).map((c) => c.batchId), ['b2']);
  assert.deepEqual((await s.listGenreChanges({ batchId: 'b1' })).map((c) => c.key).sort(), ['a', 'b']);
  assert.deepEqual((await s.listGenreChanges({ latestBatchReason: 'Genres file upload' })).map((c) => c.batchId), ['b2']);

  const b2 = await s.listGenreChanges({ batchId: 'b2' });
  await s.markGenreChangesUndone(b2.map((c) => c.id), '2026-03-01T00:00:00Z');
  assert.deepEqual((await s.listGenreChanges({ latestBatchReason: 'Genres file upload' })).map((c) => c.batchId), ['b1', 'b1']);
  assert.deepEqual(await s.listGenreChanges({ latestBatchReason: 'nothing like this' }), []);
});

test('file store: markGenreChangesUndone sets undoneAt once and never removes a change', async () => {
  const s = await fileStore();
  const [c] = await s.writeArtistGenres([{ key: 'zedd', source: 'owner', row: row('zedd', 'owner') }], { actor: 'owner', reason: 'Set in the app' });
  await s.markGenreChangesUndone([c.id], '2026-03-01T00:00:00Z');
  await s.markGenreChangesUndone([c.id], '2026-04-01T00:00:00Z');
  const [after] = await s.listGenreChanges({});
  assert.equal(after.undoneAt, '2026-03-01T00:00:00Z');
  assert.equal(after.reason, 'Set in the app');
  assert.equal((await s.listGenreChanges({})).length, 1);
});

test('file store: listSeenActNames returns key and name only, one per key, across members', async () => {
  const s = await fileStore();
  await s.forUser(ANN).putEvent(ev('a1', [['zedd', 'Zedd'], ['moon garden', 'Moon Garden']]));
  await s.forUser(BOB).putEvent(ev('b1', [['zedd', 'ZEDD'], ['', 'No Key'], ['blank', '  '], ['secret', 'v1:abc']]));
  await s.forUser(BOB).putEvent(ev('b2', [['gone', 'Gone']]));
  await s.forUser(BOB).deleteEvent('b2');
  const names = await s.listSeenActNames();
  assert.deepEqual(names.sort((x, y) => x.key.localeCompare(y.key)), [
    { key: 'moon garden', name: 'Moon Garden' },
    { key: 'zedd', name: 'ZEDD' },
  ]);
  for (const n of names) assert.deepEqual(Object.keys(n).sort(), ['key', 'name']);
  assert.equal((await s.forUser(OWNER).listSeenActNames()).length, 2);
});

test('file store: a member scope is refused for the shared genre writes, the log and seen act names', async () => {
  const s = await fileStore();
  const ann = s.forUser(ANN);
  await assert.rejects(ann.writeArtistGenres([{ key: 'zedd', source: 'owner', row: row('zedd', 'owner') }], { actor: 'owner', reason: 'x' }), /Only the owner/);
  await assert.rejects(ann.listGenreChanges({}), /Only the owner/);
  await assert.rejects(ann.markGenreChangesUndone(['x'], '2026-01-01T00:00:00Z'), /Only the owner/);
  await assert.rejects(ann.listSeenActNames(), /Only the owner/);
  assert.deepEqual(await s.listArtistGenres(), []);
});

// A tiny stand-in for the Supabase client: records each query and rpc, answers from fixed rows.
function fakeDb(tables: Record<string, any[]>, rpcs: Record<string, (args: any) => any[]> = {}) {
  const calls: Array<{ table: string; op: string; args: any[] }[]> = [];
  const rpcCalls: Array<{ name: string; args: any }> = [];
  const from = (table: string) => {
    const ops: { table: string; op: string; args: any[] }[] = [];
    calls.push(ops);
    const builder: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            return (resolve: (v: any) => void) => {
              let data = [...(tables[table] ?? [])];
              for (const o of ops) if (o.op === 'eq') data = data.filter((r) => r[o.args[0]] === o.args[1]);
              for (const o of ops) if (o.op === 'range') data = data.slice(o.args[0], o.args[1] + 1);
              resolve({ data, error: null });
            };
          }
          return (...args: any[]) => {
            ops.push({ table, op: prop, args });
            return builder;
          };
        },
      },
    );
    return builder;
  };
  const db = {
    from,
    rpc(name: string, args: any) {
      const ops: { op: string; args: any[] }[] = [];
      const builder: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === 'then') {
              return (resolve: (v: any) => void) => {
                rpcCalls.push({ name, args });
                let data = rpcs[name] ? rpcs[name](args) : [];
                for (const o of ops) if (o.op === 'range') data = data.slice(o.args[0], o.args[1] + 1);
                resolve({ data, error: null });
              };
            }
            return (...opArgs: any[]) => {
              ops.push({ op: prop, args: opArgs });
              return builder;
            };
          },
        },
      );
      return builder;
    },
  };
  return { db: db as any, calls, rpcCalls };
}

const sharedRow = { artist_key: 'zedd', source: 'owner', name: 'Zedd', mbid: null, genres: [{ parent: 'electronic', style: 'house', weight: 1 }], source_url: null, inputs: [], checked_at: '2026-01-01T00:00:00Z' };

test('supabase store: a member reads artist_genres through the service client plus their own rows as added', async () => {
  const { db, calls } = fakeDb({
    artist_genres: [sharedRow],
    user_artist_genres: [
      { user_id: 'u-ann', artist_key: 'zedd', name: 'Zedd', genres: [{ parent: 'electronic', style: 'techno', weight: 1 }], updated_at: '2026-01-02T00:00:00Z' },
      { user_id: 'u-bob', artist_key: 'moon', name: 'Moon', genres: [], updated_at: '2026-01-02T00:00:00Z' },
    ],
  });
  const ann = new SupabaseLineupStore(db).forUser(ANN);
  const rows = await ann.listArtistGenres();
  assert.deepEqual(rows.map((r) => `${r.key}:${r.source}`), ['zedd:owner', 'zedd:added']);
  assert.ok(calls.some((ops) => ops[0]?.table === 'artist_genres'));
  const own = calls.find((ops) => ops[0]?.table === 'user_artist_genres')!;
  assert.ok(own.some((o) => o.op === 'eq' && o.args[0] === 'user_id' && o.args[1] === 'u-ann'));

  const owner = await new SupabaseLineupStore(db).forUser(OWNER).listArtistGenres();
  assert.deepEqual(owner.map((r) => `${r.key}:${r.source}`), ['zedd:owner']);
});

test('supabase store: a member put and delete touch only user_artist_genres', async () => {
  const { db, calls } = fakeDb({});
  const ann = new SupabaseLineupStore(db).forUser(ANN);
  await ann.putArtistGenres([row('zedd', 'added')]);
  await ann.deleteArtistGenres('zedd', 'added');
  await ann.deleteArtistGenres('zedd', 'owner');
  await assert.rejects(ann.putArtistGenres([row('zedd', 'owner')]), /only keep genres they set/);
  const tables = calls.map((ops) => ops[0]?.table);
  assert.deepEqual(tables, ['user_artist_genres', 'user_artist_genres']);
  const upsert = calls[0].find((o) => o.op === 'upsert')!;
  assert.equal(upsert.args[0][0].user_id, 'u-ann');
});

test('supabase store: writeArtistGenres calls artist_genres_write and maps the change rows', async () => {
  const { db, rpcCalls } = fakeDb({}, {
    artist_genres_write: () => [
      { id: 'c1', artist_key: 'zedd', source: 'owner', at: '2026-01-01T00:00:00Z', actor: 'owner', reason: 'Genres file upload', batch_id: 'b1', before: null, after: sharedRow, undone_at: null },
    ],
  });
  const s = new SupabaseLineupStore(db).forUser(OWNER);
  const changes = await s.writeArtistGenres([{ key: 'zedd', source: 'owner', row: row('zedd', 'owner') }, { key: 'old', source: 'you', row: null }], { actor: 'owner', reason: 'Genres file upload', batchId: 'b1' });
  assert.equal(rpcCalls[0].name, 'artist_genres_write');
  assert.equal(rpcCalls[0].args.p_actor, 'owner');
  assert.equal(rpcCalls[0].args.p_reason, 'Genres file upload');
  assert.equal(rpcCalls[0].args.p_batch, 'b1');
  assert.deepEqual(rpcCalls[0].args.p_rows[1], { artist_key: 'old', source: 'you', row: null });
  assert.equal(rpcCalls[0].args.p_rows[0].row.checked_at, '2026-01-01T00:00:00Z');
  assert.equal(changes[0].key, 'zedd');
  assert.equal(changes[0].batchId, 'b1');
  assert.equal(changes[0].before, null);
  assert.equal(changes[0].after?.name, 'Zedd');
  assert.equal(changes[0].undoneAt, undefined);
});

test('supabase store: listGenreChanges filters, markGenreChangesUndone sets undone_at on rows not yet undone', async () => {
  const { db, calls } = fakeDb({
    artist_genre_changes: [{ id: 'c1', artist_key: 'zedd', source: 'owner', at: '2026-01-01T00:00:00Z', actor: 'owner', reason: 'Set in the app', batch_id: null, before: null, after: sharedRow, undone_at: null }],
  });
  const s = new SupabaseLineupStore(db);
  const list = await s.listGenreChanges({ key: 'zedd', limit: 1 });
  assert.equal(list[0].id, 'c1');
  const ops = calls[0];
  assert.ok(ops.some((o) => o.op === 'eq' && o.args[0] === 'artist_key' && o.args[1] === 'zedd'));
  assert.ok(ops.some((o) => o.op === 'limit' && o.args[0] === 1));
  await s.markGenreChangesUndone(['c1'], '2026-03-01T00:00:00Z');
  const upd = calls[1];
  assert.deepEqual(upd.find((o) => o.op === 'update')!.args[0], { undone_at: '2026-03-01T00:00:00Z' });
  assert.ok(upd.some((o) => o.op === 'is' && o.args[0] === 'undone_at' && o.args[1] === null));
});

test('supabase store: listSeenActNames calls seen_act_names and returns key and name only', async () => {
  const { db, rpcCalls } = fakeDb({}, { seen_act_names: () => [{ artist_key: 'zedd', name: 'Zedd' }] });
  assert.deepEqual(await new SupabaseLineupStore(db).forUser(OWNER).listSeenActNames(), [{ key: 'zedd', name: 'Zedd' }]);
  assert.equal(rpcCalls[0].name, 'seen_act_names');
});

test('supabase store: a member scope is refused for the four owner methods before any call', async () => {
  const { db, calls, rpcCalls } = fakeDb({});
  const ann = new SupabaseLineupStore(db).forUser(ANN);
  await assert.rejects(ann.writeArtistGenres([], { actor: 'owner', reason: 'x' }), /Only the owner/);
  await assert.rejects(ann.listGenreChanges({}), /Only the owner/);
  await assert.rejects(ann.markGenreChangesUndone(['c1'], '2026-01-01T00:00:00Z'), /Only the owner/);
  await assert.rejects(ann.listSeenActNames(), /Only the owner/);
  assert.equal(calls.length + rpcCalls.length, 0);
});

test('supabase store: listArtistGenres, listGenreChanges and listSeenActNames paginate past 1000 rows', async () => {
  const total = 1050;
  const genreRows = Array.from({ length: total }, (_, i) => ({
    ...sharedRow,
    artist_key: `artist-${String(i).padStart(4, '0')}`,
    name: `Artist ${i}`,
  }));
  const changeRows = Array.from({ length: total }, (_, i) => ({
    id: `c-${i}`,
    artist_key: `artist-${String(i).padStart(4, '0')}`,
    source: 'owner',
    at: '2026-01-01T00:00:00Z',
    actor: 'owner',
    reason: 'Genres file upload',
    batch_id: 'b1',
    before: null,
    after: sharedRow,
    undone_at: null,
  }));
  const seenRows = Array.from({ length: total }, (_, i) => ({
    artist_key: `artist-${String(i).padStart(4, '0')}`,
    name: `Artist ${i}`,
  }));

  const { db, calls, rpcCalls } = fakeDb(
    { artist_genres: genreRows, artist_genre_changes: changeRows },
    { seen_act_names: () => seenRows },
  );
  const s = new SupabaseLineupStore(db).forUser(OWNER);

  const genres = await s.listArtistGenres();
  const changes = await s.listGenreChanges({});
  const seen = await s.listSeenActNames();

  assert.equal(genres.length, total);
  assert.equal(changes.length, total);
  assert.equal(seen.length, total);
  assert.equal(calls.filter((ops) => ops[0]?.table === 'artist_genres').length, 2);
  assert.equal(calls.filter((ops) => ops[0]?.table === 'artist_genre_changes').length, 2);
  assert.equal(rpcCalls.filter((c) => c.name === 'seen_act_names').length, 2);
});
