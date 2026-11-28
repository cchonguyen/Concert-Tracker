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
import { SERIES_CLEANUP_PLAN } from '../src/server/entities/seriesCleanupPlan.ts';

// The owner routes preview and run the current one-time cleanup list (seriesCleanupPlan.ts,
// docs/specs/series-cleanup.md). The first list ran on 2026-11-26; the loose-ends list was written on 2026-11-27.
const appFor = async (role: 'owner' | 'member') => {
  const dir = await mkdtemp(path.join(tmpdir(), 'series-cleanup-routes-'));
  const linked = withEntityLinks(new FileLineupStore(dir));
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runAsMember({ role, uid: 'u0' } as any, linked as any, next));
  app.use('/api', entitiesRouter({ store: linked, now: () => new Date('2026-11-27T00:00:00.000Z') } as any));
  return { app, dir };
};

test('the cleanup list is empty once it has run, so the Global Archive panel hides', () => {
  assert.deepEqual(SERIES_CLEANUP_PLAN, []);
});

test('the owner previews the cleanup list in batches without changing anything', async () => {
  const { app, dir } = await appFor('owner');
  try {
    const get = await dispatch(app, { url: '/api/manage/canonical/series-cleanup?from=0&count=50' });
    assert.equal(get.status, 200);
    assert.equal(get.json().total, SERIES_CLEANUP_PLAN.length);
    assert.equal(get.json().results.length, Math.min(20, SERIES_CLEANUP_PLAN.length));
    // An empty store has none of these series, so nothing is ready to change.
    assert.ok(get.json().results.every((r: { outcome: string }) => r.outcome !== 'done'));
    const post = await dispatch(app, { url: '/api/manage/canonical/series-cleanup', method: 'POST', headers: { 'content-type': 'application/json' }, body: { from: 0, count: 10 } });
    assert.equal(post.status, 200);
    assert.equal(post.json().total, SERIES_CLEANUP_PLAN.length);
    assert.equal(post.json().results.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a member cannot preview or run the cleanup list', async () => {
  const { app, dir } = await appFor('member');
  try {
    const get = await dispatch(app, { url: '/api/manage/canonical/series-cleanup?from=0&count=20' });
    assert.equal(get.status, 403);
    const post = await dispatch(app, { url: '/api/manage/canonical/series-cleanup', method: 'POST', headers: { 'content-type': 'application/json' }, body: { from: 0, count: 3 } });
    assert.equal(post.status, 403);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
