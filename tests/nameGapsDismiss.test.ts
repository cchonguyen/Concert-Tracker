import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { withEntityLinks } from '../src/server/entities/linkingStore.ts';
import { entitiesRouter } from '../src/server/entities/routes.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';
import type { Edition } from '../src/server/lineup/types.ts';

// Find gaps: the owner may dismiss an offered act, and it is not offered for that edition again.
const appFor = async (role: 'owner' | 'member') => {
  const dir = await mkdtemp(path.join(tmpdir(), 'name-gaps-'));
  const store = new FileLineupStore(dir);
  const linked = withEntityLinks(store);
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runAsMember({ role, uid: 'u0' } as any, linked as any, next));
  app.use('/api', entitiesRouter({ store: linked, now: () => new Date('2026-11-28T00:00:00.000Z') } as any));
  return { app, dir, store };
};
const json = { 'content-type': 'application/json' };

test('a dismissed gap is not offered again; others stay', async () => {
  const { app, dir, store } = await appFor('owner');
  try {
    await store.upsertArtist({ key: 'john summit', name: 'John Summit' } as any);
    for (const id of ['e1', 'e2']) {
      await store.upsertEdition({ id, key: `k/${id}`, year: 2024, name: `John Summit ${id === 'e1' ? 'at Kia Forum' : 'at Red Rocks'}`, status: 'verified', performances: [], updatedAt: '2026-11-01T00:00:00.000Z' } as Edition);
    }
    const before = await dispatch(app, { url: '/api/manage/canonical/name-matches' });
    assert.equal(before.status, 200);
    assert.deepEqual(before.json().matches.map((m: any) => m.editionId).sort(), ['e1', 'e2']);
    const d = await dispatch(app, { url: '/api/manage/canonical/name-matches/dismiss', method: 'POST', headers: json, body: { editionId: 'e1', artistKey: 'john summit' } });
    assert.equal(d.status, 200);
    const after = await dispatch(app, { url: '/api/manage/canonical/name-matches' });
    assert.deepEqual(after.json().matches.map((m: any) => m.editionId), ['e2']);
    // Nothing on the shared edition changed.
    assert.deepEqual((await store.getEdition('e1'))?.performances, []);
    assert.equal((await dispatch(app, { url: '/api/manage/canonical/name-matches/dismiss', method: 'POST', headers: json, body: {} })).status, 400);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a member cannot dismiss a gap', async () => {
  const { app, dir } = await appFor('member');
  try {
    const r = await dispatch(app, { url: '/api/manage/canonical/name-matches/dismiss', method: 'POST', headers: json, body: { editionId: 'e1', artistKey: 'x' } });
    assert.equal(r.status, 403);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
