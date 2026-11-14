import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { entitiesRouter } from '../src/server/entities/routes.ts';
import { canonReviewRouter } from '../src/server/canon/reviewRoutes.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import type { Edition } from '../src/server/lineup/types.ts';

// Owner verify of a provisional shared edition (slice 12.4). Owner only; goes through writeEdition so undo works.

const ed = (id: string, over: Partial<Edition> = {}): Edition => ({
  id, key: `s/${id}`, seriesSlug: 's', year: 2026, name: `Fest ${id}`, venue: 'Old Park', status: 'provisional',
  updatedAt: '2026-01-01T00:00:00.000Z', performances: [], ...over,
});

async function setup(role: string = 'owner') {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'edition-verify-')));
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runAsMember({ role, uid: 'u1' } as any, store as any, next));
  app.use('/api', entitiesRouter({ store } as any));
  app.use('/api', canonReviewRouter(store));
  const post = (url: string, body: unknown = {}) =>
    dispatch(app, { method: 'POST', url: `/api${url}`, headers: { 'content-type': 'application/json' }, body });
  return { store, post };
}

test('owner verifies a provisional edition; the change is recorded and undo restores provisional', async () => {
  const { store, post } = await setup();
  await store.upsertEdition(ed('e1'));
  const res = await post('/manage/canonical/editions/e1/verify');
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.ok, true);
  assert.deepEqual(body.edition, { id: 'e1', name: 'Fest e1', status: 'verified' });
  assert.equal(typeof body.changeId, 'string');
  assert.doesNotMatch(JSON.stringify(body), /userId|uid|actorId/);
  assert.equal((await store.getEdition('e1'))?.status, 'verified');
  const changes = await store.listEditionChanges('e1');
  assert.equal(changes[0].actor, 'owner');
  assert.equal(changes[0].reason, 'verified by owner');
  assert.equal(changes[0].id, body.changeId);

  const undo = await post(`/canon/changes/${body.changeId}/undo`, { editionId: 'e1' });
  assert.equal(undo.status, 200);
  assert.equal((await store.getEdition('e1'))?.status, 'provisional');
});

test('a draft or an already verified edition is refused with 409 and not changed', async () => {
  const { store, post } = await setup();
  await store.upsertEdition(ed('d1', { status: 'draft' }));
  await store.upsertEdition(ed('v1', { status: 'verified' }));
  const draft = await post('/manage/canonical/editions/d1/verify');
  assert.equal(draft.status, 409);
  assert.deepEqual(await draft.json(), { error: 'Only a provisional edition can be verified here.' });
  const verified = await post('/manage/canonical/editions/v1/verify');
  assert.equal(verified.status, 409);
  assert.deepEqual(await verified.json(), { error: 'Only a provisional edition can be verified here.' });
  assert.equal((await store.getEdition('d1'))?.status, 'draft');
  assert.equal((await store.getEdition('v1'))?.status, 'verified');
  assert.equal((await store.listEditionChanges('v1')).length, 0);
});

test('an unknown edition id is 404', async () => {
  const { post } = await setup();
  const res = await post('/manage/canonical/editions/nope/verify');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Edition not found.' });
});

test('a non-owner gets 403 and nothing changes', async () => {
  const { store, post } = await setup('member');
  await store.upsertEdition(ed('e1'));
  const res = await post('/manage/canonical/editions/e1/verify');
  assert.equal(res.status, 403);
  assert.match(((await res.json()) as any).error, /Only the owner/);
  assert.equal((await store.getEdition('e1'))?.status, 'provisional');
  assert.equal((await store.listEditionChanges('e1')).length, 0);
});
