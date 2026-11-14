import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { planArtistChange, type SqlCanonicalEntry } from '../src/server/entities/canonicalManage.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { SupabaseLineupStore } from '../src/server/lineup/store/supabaseStore.ts';
import { CanonicalStoreError } from '../src/server/lineup/store/types.ts';

// Slice 8.6: store contract for canonical artist apply and Undo.
// FileStore runs the real planner (planArtistChange) on a hand-seeded state file. The Supabase store is
// tested against a stub client only: nothing here contacts a Supabase project.

const AT = '2026-11-03T00:00:00.000Z';

const codeIs = (code: string) => (err: unknown) => err instanceof CanonicalStoreError && err.code === code;

async function seededStore(): Promise<{ store: FileLineupStore; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'slice86-'));
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
  return { store: new FileLineupStore(dir), dir };
}

async function renamePlan(store: FileLineupStore) {
  return planArtistChange(store, 'old artist', { op: 'rename', name: 'New Artist' }, AT);
}

test('FileStore apply writes exactly the planned rows', async () => {
  const { store } = await seededStore();
  const plan = await renamePlan(store);
  const fingerprint = await store.canonicalArtistFingerprint(plan.entry);
  const result = await store.applyCanonicalArtistChange(plan.entry, fingerprint);

  assert.deepEqual(result, { id: plan.id, operation: 'canonical-rename' });
  assert.equal(await store.getArtist('old artist'), null);
  assert.deepEqual(await store.getArtist('new artist'), { key: 'new artist', name: 'New Artist' });

  const planned = plan.entry.canonical.performances.after.map((p) => ({ editionId: p.edition_id, artistKey: p.artist_key, name: p.name, days: p.days }));
  const written = (await store.artistPerformances(['new artist'])).map((p) => ({ editionId: p.editionId, artistKey: p.artistKey, name: p.name, days: p.days }));
  assert.deepEqual(written, planned);
  assert.equal(written.length, 1);

  assert.equal((await store.getAliases())['old artist'], 'New Artist');
});

test('FileStore has no performance IDs, so the plan is not SQL-ready and no ID is invented', async () => {
  const { store } = await seededStore();
  const plan = await renamePlan(store);
  assert.equal(plan.sqlReady, false);
  assert.equal(plan.entry.canonical.performances.before[0].id, null);
  const rows = await store.artistPerformances(['old artist']);
  assert.equal('id' in rows[0], false);
});

test('a stale fingerprint is rejected and nothing is written', async () => {
  const { store, dir } = await seededStore();
  const plan = await renamePlan(store);
  const before = await readFile(path.join(dir, 'lineup-store.json'), 'utf8');

  await assert.rejects(store.applyCanonicalArtistChange(plan.entry, 'not-the-fingerprint'), codeIs('stale'));

  assert.equal(await readFile(path.join(dir, 'lineup-store.json'), 'utf8'), before);
  assert.equal(await store.getArtist('new artist'), null);
});

test('a change made after the preview makes the apply stale', async () => {
  const { store } = await seededStore();
  const plan = await renamePlan(store);
  const previewed = await store.canonicalArtistFingerprint(plan.entry);
  await store.upsertArtist({ key: 'old artist', name: 'Old Artist', mbid: 'abc-123' });

  await assert.rejects(store.applyCanonicalArtistChange(plan.entry, previewed), codeIs('stale'));
  assert.equal(await store.getArtist('new artist'), null);
});

test('a member scope cannot apply, Undo or fingerprint a canonical change', async () => {
  const { store } = await seededStore();
  const plan = await renamePlan(store);
  const fingerprint = await store.canonicalArtistFingerprint(plan.entry);
  const member = store.forUser({ userId: 'member-1', role: 'member' });

  await assert.rejects(member.applyCanonicalArtistChange(plan.entry, fingerprint), codeIs('forbidden'));
  await assert.rejects(member.canonicalArtistFingerprint(plan.entry), codeIs('forbidden'));
  await assert.rejects(member.undoCanonicalArtistChange(plan.entry.id), codeIs('forbidden'));

  assert.equal(await store.getArtist('new artist'), null);
  assert.deepEqual(await store.getArtist('old artist'), { key: 'old artist', name: 'Old Artist' });
});

test('Undo restores the before side, and a second Undo is refused', async () => {
  const { store } = await seededStore();
  const plan = await renamePlan(store);
  await store.applyCanonicalArtistChange(plan.entry, await store.canonicalArtistFingerprint(plan.entry));

  assert.deepEqual(await store.undoCanonicalArtistChange(plan.entry.id), { id: plan.entry.id, undone: true });
  assert.deepEqual(await store.getArtist('old artist'), { key: 'old artist', name: 'Old Artist' });
  assert.equal(await store.getArtist('new artist'), null);
  assert.equal((await store.getAliases())['old artist'], undefined);
  assert.equal((await store.artistPerformances(['old artist'])).length, 1);

  await assert.rejects(store.undoCanonicalArtistChange(plan.entry.id), codeIs('stale'));
});

test('Undo is refused when the records changed after the change, and changes nothing', async () => {
  const { store } = await seededStore();
  const plan = await renamePlan(store);
  await store.applyCanonicalArtistChange(plan.entry, await store.canonicalArtistFingerprint(plan.entry));
  await store.upsertArtist({ key: 'new artist', name: 'Newer Artist' });

  await assert.rejects(store.undoCanonicalArtistChange(plan.entry.id), codeIs('stale'));
  assert.deepEqual(await store.getArtist('new artist'), { key: 'new artist', name: 'Newer Artist' });
});

test('two concurrent applies on one FileStore serialize: one is applied, the other is rejected', async () => {
  const { store } = await seededStore();
  const plan = await renamePlan(store);
  const fingerprint = await store.canonicalArtistFingerprint(plan.entry);

  const results = await Promise.allSettled([
    store.applyCanonicalArtistChange(plan.entry, fingerprint),
    store.applyCanonicalArtistChange(plan.entry, fingerprint),
  ]);

  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal((rejected[0].reason as CanonicalStoreError).code, 'stale');
  assert.equal((await store.artistPerformances(['new artist'])).length, 1);
});

// ---- Supabase store, stubbed client (no network) ----

type Reply = { data: unknown; error: { code?: string; message: string } | null };

function stubDb(reply: (name: string) => Reply, rows: unknown[] = []) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return reply(name);
    },
    from: () => ({ select: () => ({ in: async () => ({ data: rows, error: null }) }) }),
  };
  return { db: db as unknown as SupabaseClient, calls };
}

const fakeEntry = { id: 'h-1', operation: 'canonical-rename' } as unknown as SqlCanonicalEntry;

test('Supabase apply calls canonical_apply_artist_change with the named parameters', async () => {
  const { db, calls } = stubDb(() => ({ data: { id: 'h-1', operation: 'canonical-rename' }, error: null }));
  const store = new SupabaseLineupStore(db);

  assert.deepEqual(await store.applyCanonicalArtistChange(fakeEntry, 'fp-1'), { id: 'h-1', operation: 'canonical-rename' });
  assert.equal(calls[0].name, 'canonical_apply_artist_change');
  assert.deepEqual(Object.keys(calls[0].args).sort(), ['p_entry', 'p_fingerprint', 'p_user_id']);
  assert.equal(calls[0].args.p_fingerprint, 'fp-1');
  assert.equal(calls[0].args.p_user_id, null);
  assert.equal(calls[0].args.p_entry, fakeEntry);
});

test('Supabase Undo and fingerprint call their RPCs with the owner id for an owner scope', async () => {
  const { db, calls } = stubDb((name) => ({ data: name === 'canonical_artist_fingerprint' ? 'fp-9' : { id: 'h-1', undone: true }, error: null }));
  const store = new SupabaseLineupStore(db, { userId: 'owner-1', role: 'owner' });

  assert.equal(await store.canonicalArtistFingerprint(fakeEntry), 'fp-9');
  assert.deepEqual(await store.undoCanonicalArtistChange('h-1'), { id: 'h-1', undone: true });
  assert.equal(calls[0].name, 'canonical_artist_fingerprint');
  assert.deepEqual(Object.keys(calls[0].args).sort(), ['p_entry', 'p_user_id']);
  assert.equal(calls[0].args.p_user_id, 'owner-1');
  assert.equal(calls[1].name, 'canonical_undo_artist_change');
  assert.deepEqual(Object.keys(calls[1].args).sort(), ['p_history_id', 'p_user_id']);
  assert.equal(calls[1].args.p_history_id, 'h-1');
});

test('Supabase maps P0409 to stale, 42501 to forbidden, anything else to generic', async () => {
  const cases: Array<[string, string, string]> = [
    ['P0409', 'stale', 'Preview is out of date; review it again'],
    ['42501', 'forbidden', 'Only the owner can do this.'],
    ['23505', 'generic', 'duplicate key'],
  ];
  for (const [code, expected, message] of cases) {
    const { db } = stubDb(() => ({ data: null, error: { code, message } }));
    const store = new SupabaseLineupStore(db);
    await assert.rejects(store.applyCanonicalArtistChange(fakeEntry, 'fp'), (err: unknown) => {
      assert.ok(err instanceof CanonicalStoreError);
      assert.equal(err.code, expected);
      assert.match(err.message, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    });
    await assert.rejects(store.undoCanonicalArtistChange('h-1'), codeIs(expected));
    await assert.rejects(store.canonicalArtistFingerprint(fakeEntry), codeIs(expected));
  }
});

test('Supabase refuses a member scope before any RPC is sent', async () => {
  const { db, calls } = stubDb(() => ({ data: { id: 'h-1', operation: 'canonical-rename' }, error: null }));
  const member = new SupabaseLineupStore(db, { userId: 'member-1', role: 'member' });

  await assert.rejects(member.applyCanonicalArtistChange(fakeEntry, 'fp'), codeIs('forbidden'));
  await assert.rejects(member.undoCanonicalArtistChange('h-1'), codeIs('forbidden'));
  assert.equal(calls.length, 0);
});

test('Supabase artistPerformances returns the performance row ID', async () => {
  const row = {
    id: 'perf-1',
    edition_id: 'ed1',
    artist_key: 'old artist',
    name: 'Old Artist',
    days: [],
    stages: [],
    status: 'billed',
    billing: null,
    confidence: 1,
    sources: [],
    slot_id: null,
    alias: null,
    b2b: null,
    set: null,
  };
  const { db } = stubDb(() => ({ data: null, error: null }), [row]);
  const rows = await new SupabaseLineupStore(db).artistPerformances(['old artist']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'perf-1');
  assert.equal(rows[0].editionId, 'ed1');
});

// Regression: the database holds b2b '{}' (empty array) and NULL as different values, and the canonical
// fingerprint compares them. The reader must hand the planner each value unchanged, or a preview of any
// artist with a '{}' row is refused as stale on every apply.
test('Supabase artistPerformances keeps an empty b2b array and NULL apart', async () => {
  const base = { edition_id: 'ed1', artist_key: 'old artist', name: 'Old Artist', days: [], stages: [], status: 'billed', billing: null, confidence: 1, sources: [], slot_id: null, alias: null, set: null };
  const { db } = stubDb(() => ({ data: null, error: null }), [
    { ...base, id: 'perf-empty', b2b: [] },
    { ...base, id: 'perf-null', b2b: null },
  ]);
  const rows = await new SupabaseLineupStore(db).artistPerformances(['old artist']);
  const byId = new Map(rows.map((r) => [r.id, r.b2b]));
  assert.deepEqual(byId.get('perf-empty'), []);
  assert.equal(byId.get('perf-null'), undefined);
});
