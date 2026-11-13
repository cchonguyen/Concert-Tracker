import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Edition } from '../src/server/lineup/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { SupabaseLineupStore } from '../src/server/lineup/store/supabaseStore.ts';
import { ExternalIdConflictError, PersonalFieldError, isVerifiedStatus } from '../src/server/lineup/store/types.ts';
import { normalizeName } from '../src/server/lineup/normalizeName.ts';

const fresh = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'canon-')));
const edition = (id: string, performances: Edition['performances'] = []): Edition => ({
  id, key: `s-2026-${id}`, seriesSlug: 's', year: 2026, name: `Edition ${id}`, status: 'provisional', updatedAt: '2026-01-01T00:00:00.000Z', performances,
});
const perf = (artistKey: string, slotId?: string) => ({ artistKey, name: artistKey, slotId, days: [], stages: [], status: 'billed' as const, sources: [] }) as any;

test('isVerifiedStatus treats confirmed and verified alike', () => {
  assert.ok(isVerifiedStatus('verified'));
  assert.ok(isVerifiedStatus('confirmed'));
  assert.ok(!isVerifiedStatus('provisional'));
  assert.ok(!isVerifiedStatus('draft'));
});

test('venues: upsert is stable, alias lookup works, aliases are idempotent', async () => {
  const s = await fresh();
  const a = await s.upsertVenue({ name: 'The Fillmore', city: 'San Francisco', region: 'CA', country: 'US' });
  const b = await s.upsertVenue({ name: 'the  fillmore', city: 'san francisco', region: 'ca', country: 'us' });
  assert.equal(a.id, b.id);
  assert.equal((await s.findVenueByAlias(normalizeName('The Fillmore')))?.id, a.id);
  assert.equal(await s.findVenueByAlias('nowhere'), null);
  await s.addVenueAlias(a.id, 'fillmore sf', 'songkick', '123');
  await s.addVenueAlias(a.id, 'fillmore sf', 'songkick', '123');
  assert.equal((await s.findVenueByAlias('fillmore sf'))?.id, a.id);
  const other = await s.upsertVenue({ name: 'Other Hall', city: 'Austin' });
  await assert.rejects(s.addVenueAlias(other.id, 'other alias', 'songkick', '123'), ExternalIdConflictError);
  // The same alias on two venues is ambiguous: not guessed.
  await s.addVenueAlias(other.id, 'fillmore sf');
  assert.equal(await s.findVenueByAlias('fillmore sf'), null);
});

test('external ids are idempotent and never silently overwritten', async () => {
  const s = await fresh();
  await s.upsertEdition(edition('e1'));
  await s.upsertEdition(edition('e2'));
  assert.equal(await s.addEditionExternalId('e1', 'songkick', 'x1'), 'added');
  assert.equal(await s.addEditionExternalId('e1', 'songkick', 'x1'), 'exists');
  await assert.rejects(s.addEditionExternalId('e2', 'songkick', 'x1'), (e: any) => e instanceof ExternalIdConflictError && e.existingId === 'e1');
  assert.equal((await s.findEditionByExternalId('songkick', 'x1'))?.id, 'e1');
  assert.equal(await s.findEditionByExternalId('songkick', 'nope'), null);
});

test('edition changes append, list newest first, and can be undone once', async () => {
  const s = await fresh();
  const c1 = await s.recordEditionChange({ editionId: 'e1', actor: 'owner', reason: 'typo', before: { name: 'A' }, after: { name: 'B' } });
  const c2 = await s.recordEditionChange({ editionId: 'e1', actor: 'job', after: { city: 'X' } });
  await s.recordEditionChange({ editionId: 'e2', actor: 'owner' });
  const list = await s.listEditionChanges('e1');
  assert.deepEqual(list.map((c) => c.id), [c2.id, c1.id]);
  assert.equal(list[1].before?.name, 'A');
  assert.equal(await s.markChangeUndone(c1.id), true);
  assert.equal(await s.markChangeUndone(c1.id), false);
  assert.equal(await s.markChangeUndone('missing'), false);
  const after = (await s.listEditionChanges('e1')).find((c) => c.id === c1.id)!;
  assert.ok(after.undoneAt);
  assert.equal(after.after?.name, 'B', 'nothing else changes');
  await assert.rejects(s.recordEditionChange({ editionId: 'e1', actor: 'x', after: { rating: 5 } }), PersonalFieldError);
});

test('review queue: add, list by status and kind, resolve once, no personal fields', async () => {
  const s = await fresh();
  const a = await s.addReviewItem({ kind: 'merge_suggestion', editionId: 'e1', payload: { other: 'e2' } });
  const b = await s.addReviewItem({ kind: 'failed_lookup', eventId: 'ev1', payload: {} });
  assert.equal((await s.listReviewItems()).length, 2);
  assert.deepEqual((await s.listReviewItems({ kind: 'failed_lookup' })).map((r) => r.id), [b.id]);
  assert.equal(await s.resolveReviewItem(a.id, 'owner', 'done'), true);
  assert.equal(await s.resolveReviewItem(a.id, 'owner', 'again'), false);
  assert.equal(await s.resolveReviewItem('missing', 'owner', 'done'), false);
  assert.deepEqual((await s.listReviewItems({ status: 'open' })).map((r) => r.id), [b.id]);
  const done = (await s.listReviewItems({ status: 'done' }))[0];
  assert.equal(done.resolvedBy, 'owner');
  assert.ok(done.resolvedAt);
  for (const key of ['companions', 'notes', 'rating', 'price', 'attendance', 'Rating']) {
    await assert.rejects(s.addReviewItem({ kind: 'override', payload: { field: 'name', nested: [{ deep: { [key]: 1 } }] } }), PersonalFieldError, key);
  }
  assert.equal((await s.listReviewItems()).length, 2, 'rejected items are not stored');
});

test('mergeEditions moves events, acts and external ids, records a change and deletes the dropped edition', async () => {
  const s = await fresh();
  await s.upsertEdition(edition('keep', [perf('a'), perf('b', 'slot1')]));
  await s.upsertEdition(edition('drop', [perf('a'), perf('c')]));
  await s.addEditionExternalId('drop', 'songkick', 'd1');
  const item = await s.addReviewItem({ kind: 'merge_suggestion', editionId: 'drop', payload: {} });
  await s.putEvent({ id: 'ev1', name: 'Show', editionId: 'drop', seen: [] } as any);
  const summary = await s.mergeEditions('keep', 'drop', 'owner', 'same show');
  assert.equal(summary.events_moved, 1);
  assert.equal(summary.performances_moved, 1);
  assert.equal(summary.performances_duplicate_dropped, 1);
  assert.equal(await s.getEdition('drop'), null);
  assert.deepEqual((await s.getEdition('keep'))!.performances.map((p) => p.artistKey).sort(), ['a', 'b', 'c']);
  assert.equal((await s.getEvent('ev1'))!.editionId, 'keep');
  assert.equal((await s.findEditionByExternalId('songkick', 'd1'))?.id, 'keep');
  assert.equal((await s.listReviewItems()).find((r) => r.id === item.id)!.editionId, 'keep');
  const [change] = await s.listEditionChanges('keep');
  assert.equal(change.actor, 'owner');
  assert.equal(change.reason, 'same show');
  assert.equal((change.before as any).merged_edition.id, 'drop');
  assert.equal((change.after as any).merged_into, 'keep');
  await assert.rejects(s.mergeEditions('keep', 'keep', 'owner'));
  await assert.rejects(s.mergeEditions('keep', 'gone', 'owner'));
});

// Supabase with a recording fake client -----------------------------------------------------------------

function fakeDb(results: Record<string, any> = {}) {
  const log: any[] = [];
  const db = {
    rpc(fn: string, args: any) {
      log.push({ rpc: fn, args });
      return Promise.resolve(results[`rpc:${fn}`] ?? { data: {}, error: null });
    },
    from(table: string) {
      const e: any = { table, ops: [] };
      const b: any = new Proxy({}, {
        get: (_t, op: string) => {
          if (op === 'then') return (res: any, rej: any) => (log.push(e), Promise.resolve(results[table] ?? { data: null, error: null }).then(res, rej));
          return (...args: any[]) => (e.ops.push([op, ...args]), b);
        },
      });
      return b;
    },
  };
  return { db, log };
}

test('supabase mergeEditions calls merge_editions with the SQL parameter names', async () => {
  const { db, log } = fakeDb({ 'rpc:merge_editions': { data: { events_moved: 2 }, error: null } });
  const out = await new SupabaseLineupStore(db as any).mergeEditions('k', 'd', 'owner', 'dup');
  assert.deepEqual(log[0], { rpc: 'merge_editions', args: { keep_id: 'k', drop_id: 'd', p_actor: 'owner', p_reason: 'dup' } });
  assert.deepEqual(out, { events_moved: 2 });
  const failing = fakeDb({ 'rpc:merge_editions': { data: null, error: { message: 'boom' } } });
  await assert.rejects(new SupabaseLineupStore(failing.db as any).mergeEditions('k', 'd', 'owner'), /boom/);
});

test('supabase addReviewItem inserts into review_queue and refuses personal fields before any call', async () => {
  const { db, log } = fakeDb();
  const store = new SupabaseLineupStore(db as any);
  const item = await store.addReviewItem({ kind: 'provisional', editionId: 'e1', payload: { name: 'X' } });
  const insert = log[0].ops.find((o: any[]) => o[0] === 'insert')[1];
  assert.equal(log[0].table, 'review_queue');
  assert.deepEqual(insert, { id: item.id, kind: 'provisional', edition_id: 'e1', event_id: null, payload: { name: 'X' }, status: 'open', created_at: item.createdAt });
  await assert.rejects(store.addReviewItem({ kind: 'override', payload: { companions: [] } }), PersonalFieldError);
  assert.equal(log.length, 1);
});
