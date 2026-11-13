import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { canonReviewRouter } from '../src/server/canon/reviewRoutes.ts';
import { writeEdition } from '../src/server/canon/editions.ts';
import { editEditionFacts } from '../src/server/lineup/canonicalIngest.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import type { Edition } from '../src/server/lineup/types.ts';

const ed = (id: string, over: Partial<Edition> = {}): Edition => ({
  id, key: `s/${id}`, seriesSlug: 's', year: 2026, name: `Fest ${id}`, venue: 'Old Park', status: 'provisional',
  updatedAt: '2026-01-01T00:00:00.000Z', performances: [], ...over,
});

async function setup(role: string | null = 'owner') {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'review-')));
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => (role ? runAsMember({ role, uid: 'u1' } as any, store as any, next) : next()));
  app.use('/api', canonReviewRouter(store));
  const post = (url: string, body: unknown = {}) =>
    dispatch(app, { url: `/api${url}`, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } as any);
  const get = (url: string) => dispatch(app, { url: `/api${url}` });
  return { store, post, get };
}

test('members and signed-out callers are refused on every route', async () => {
  for (const role of ['member', null]) {
    const { post, get } = await setup(role);
    assert.equal((await get('/canon/review')).status, 403);
    for (const u of ['/canon/review/x/promote', '/canon/review/x/verify', '/canon/review/x/merge', '/canon/review/x/dismiss', '/canon/changes/x/undo']) {
      const r = await post(u);
      assert.equal(r.status, 403);
      assert.match(((await r.json()) as any).error, /Only the owner/);
    }
  }
});

test('list: newest first, filters, edition joined, no personal fields', async () => {
  const { store, get } = await setup();
  await store.upsertEdition(ed('e1'));
  const a = await store.addReviewItem({ kind: 'override', editionId: 'e1', eventId: 'ev1', payload: { field: 'venue', old: 'Old Park', new: 'New Park' } });
  await new Promise((r) => setTimeout(r, 5));
  const b = await store.addReviewItem({ kind: 'provisional', editionId: 'e1', payload: {} });
  const all = (await (await get('/canon/review')).json()) as any;
  assert.deepEqual(all.items.map((i: any) => i.id), [b.id, a.id]);
  assert.equal(all.items[0].edition.name, 'Fest e1');
  const only = (await (await get('/canon/review?kind=override')).json()) as any;
  assert.equal(only.items.length, 1);
  assert.equal((await get('/canon/review?kind=bogus')).status, 400);
  assert.doesNotMatch(JSON.stringify(all), /companions|notes|rating|price|attendance/);
});

test('promote applies the override through writeEdition and resolves; stale needs force', async () => {
  const { store, post } = await setup();
  await store.upsertEdition(ed('e1'));
  const it = await store.addReviewItem({ kind: 'override', editionId: 'e1', eventId: 'ev1', payload: { field: 'venue', old: 'Old Park', new: 'New Park' } });
  const r = await post(`/canon/review/${it.id}/promote`);
  assert.equal(r.status, 200);
  assert.equal((await store.getEdition('e1'))?.venue, 'New Park');
  const changes = await store.listEditionChanges('e1');
  assert.equal(changes[0].actor, 'owner');
  assert.equal(changes[0].reason, 'promoted from override');
  assert.equal((await store.listReviewItems({ status: 'promoted' })).length, 1);
  assert.equal((await post(`/canon/review/${it.id}/promote`)).status, 409);

  const stale = await store.addReviewItem({ kind: 'override', editionId: 'e1', eventId: 'ev2', payload: { field: 'venue', old: 'Old Park', new: 'Third Park' } });
  assert.equal((await post(`/canon/review/${stale.id}/promote`)).status, 409);
  assert.equal((await store.getEdition('e1'))?.venue, 'New Park');
  assert.equal((await post(`/canon/review/${stale.id}/promote`, { force: true })).status, 200);
  assert.equal((await store.getEdition('e1'))?.venue, 'Third Park');
});

test('verify sets the edition to verified; wrong kind and unknown id are 4xx', async () => {
  const { store, post } = await setup();
  await store.upsertEdition(ed('e1'));
  const prov = await store.addReviewItem({ kind: 'provisional', editionId: 'e1', payload: {} });
  const ov = await store.addReviewItem({ kind: 'override', editionId: 'e1', payload: { field: 'city', old: null, new: 'X' } });
  assert.equal((await post(`/canon/review/${ov.id}/verify`)).status, 400);
  assert.equal((await post('/canon/review/nope/verify')).status, 404);
  assert.equal((await post('/canon/review/bad id!/verify')).status, 400);
  assert.equal((await post(`/canon/review/${prov.id}/verify`)).status, 200);
  assert.equal((await store.getEdition('e1'))?.status, 'verified');
  assert.equal((await store.listEditionChanges('e1'))[0].reason, 'verified by owner');
});

test('merge keeps the verified edition by default, honours keep, rejects bad ids', async () => {
  const { store, post } = await setup();
  await store.upsertEdition(ed('a', { status: 'provisional' }));
  await store.upsertEdition(ed('b', { status: 'verified' }));
  const it = await store.addReviewItem({ kind: 'merge_suggestion', editionId: 'a', payload: { editionIds: ['a', 'b'] } });
  assert.equal((await post(`/canon/review/${it.id}/merge`, { keep: 'zzz' })).status, 400);
  const r = await post(`/canon/review/${it.id}/merge`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as any;
  assert.equal(body.keep, 'b');
  assert.equal(body.drop, 'a');
  assert.equal(await store.getEdition('a'), null);
  assert.equal((await store.listReviewItems({ status: 'merged' })).length, 1);

  await store.upsertEdition(ed('c'));
  await store.upsertEdition(ed('d'));
  const it2 = await store.addReviewItem({ kind: 'merge_suggestion', editionId: 'c', payload: { editionIds: ['c', 'd'] } });
  const r2 = (await (await post(`/canon/review/${it2.id}/merge`, { keep: 'd' })).json()) as any;
  assert.equal(r2.keep, 'd');
  assert.equal(r2.drop, 'c');
});

test('dismiss closes any open item once', async () => {
  const { store, post } = await setup();
  const it = await store.addReviewItem({ kind: 'failed_lookup', payload: { reason: 'x' } });
  assert.equal((await post(`/canon/review/${it.id}/dismiss`)).status, 200);
  assert.equal((await store.listReviewItems({ status: 'dismissed' })).length, 1);
  assert.equal((await post(`/canon/review/${it.id}/dismiss`)).status, 409);
  assert.equal((await post('/canon/review/nope/dismiss')).status, 404);
});

test('undo wraps undoEditionChange: ok, already undone, stale, bad input', async () => {
  const { store, post } = await setup();
  await store.upsertEdition(ed('e1'));
  const first = await writeEdition(store, { edition: ed('e1', { venue: 'Second' }), actor: 'owner', reason: 't' });
  const second = await writeEdition(store, { edition: ed('e1', { venue: 'Third' }), actor: 'owner', reason: 't' });
  assert.equal((await post(`/canon/changes/${first.change!.id}/undo`)).status, 400);
  assert.equal((await post(`/canon/changes/${first.change!.id}/undo`, { editionId: 'e1' })).status, 409); // stale
  assert.equal((await post(`/canon/changes/${second.change!.id}/undo`, { editionId: 'e1' })).status, 200);
  assert.equal((await store.getEdition('e1'))?.venue, 'Second');
  assert.equal((await post(`/canon/changes/${second.change!.id}/undo`, { editionId: 'e1' })).status, 409);
  assert.equal((await post('/canon/changes/nope/undo', { editionId: 'e1' })).status, 404);
});

test('owner edit of an edition title or venue adds a formatting row with no personal fields', async () => {
  const { store } = await setup();
  await store.upsertEdition(ed('e1', { city: 'Austin' }));
  await editEditionFacts(store, 'e1', { name: 'Fest E1 Fixed', venue: 'New Park', city: 'Austin' } as any);
  const rows = await store.listReviewItems({ kind: 'formatting' });
  assert.deepEqual(rows.map((r) => r.payload).sort((x: any, y: any) => x.field.localeCompare(y.field)), [
    { field: 'name', old: 'Fest e1', new: 'Fest E1 Fixed', editionId: 'e1' },
    { field: 'venue', old: 'Old Park', new: 'New Park', editionId: 'e1' },
  ]);
});
