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

// The one-time series cleanup ran on 2026-11-26 (docs/specs/series-cleanup.md); its owner routes are gone,
// so nothing can preview or run that list again.
test('the one-time series cleanup routes are removed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'series-cleanup-removed-'));
  try {
    const linked = withEntityLinks(new FileLineupStore(dir));
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => runAsMember({ role: 'owner', uid: 'u0' } as any, linked as any, next));
    app.use('/api', entitiesRouter({ store: linked, now: () => new Date('2026-11-26T00:00:00.000Z') } as any));
    const get = await dispatch(app, { url: '/api/manage/canonical/series-cleanup?from=0&count=20' });
    assert.equal(get.status, 404);
    const post = await dispatch(app, { url: '/api/manage/canonical/series-cleanup', method: 'POST', headers: { 'content-type': 'application/json' }, body: { from: 0, count: 3 } });
    assert.equal(post.status, 404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
