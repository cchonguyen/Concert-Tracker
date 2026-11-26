import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { withEntityLinks } from '../src/server/entities/linkingStore.ts';
import { entitiesRouter } from '../src/server/entities/routes.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';
import { withBuiltSeriesName } from '../src/server/entities/canonicalManage.ts';

const json = { 'content-type': 'application/json' };

async function withApp(fn: (app: express.Express, store: FileLineupStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'series-qualifier-'));
  try {
    const store = new FileLineupStore(dir);
    const linked = withEntityLinks(store);
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => runAsMember({ role: 'owner', uid: 'u0' } as any, linked as any, next));
    app.use('/api', entitiesRouter({ store: linked, now: () => new Date('2026-11-26T00:00:00.000Z') } as any));
    await fn(app, store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a series with a brand and a qualifier stores the built name; without a qualifier the name stays', () => {
  assert.equal(withBuiltSeriesName({ slug: 'a', name: 'x', brand: 'Dreamstate', qualifier: ' SoCal ' }).name, 'Dreamstate SoCal');
  assert.equal(withBuiltSeriesName({ slug: 'b', name: 'x', kind: 'tour', brand: 'Andrew Bayer', qualifier: 'Duality Tour' }).name, 'Andrew Bayer: Duality Tour');
  const plain = withBuiltSeriesName({ slug: 'c', name: 'Dreamstate SoCal', brand: 'Dreamstate', qualifier: ' ' });
  assert.equal(plain.name, 'Dreamstate SoCal');
  assert.equal('qualifier' in plain, false);
  assert.equal(withBuiltSeriesName({ slug: 'd', name: 'Tension Tour', kind: 'tour', qualifier: 'Tension Tour' }).name, 'Tension Tour');
});

test('the series routes take a qualifier, keep the built name, and undo puts the old record back', async () => {
  await withApp(async (app, store) => {
    const made = await dispatch(app, {
      url: '/api/manage/canonical/series',
      method: 'POST',
      headers: json,
      body: { name: 'Lost In Dreams Las Vegas', slug: 'lid-lv', brand: 'Lost In Dreams', qualifier: 'Las Vegas' },
    });
    assert.equal(made.status, 201);
    assert.equal((await store.getSeries('lid-lv'))?.name, 'Lost In Dreams Las Vegas');

    await store.upsertSeries({ slug: 'lost-in-dreams', name: 'Lost In Dreams SoCal', brand: 'Lost In Dreams' });
    const patched = await dispatch(app, {
      url: '/api/manage/canonical/series/lost-in-dreams',
      method: 'PATCH',
      headers: json,
      body: { qualifier: 'Los Angeles' },
    });
    assert.equal(patched.status, 200);
    const after = await store.getSeries('lost-in-dreams');
    assert.equal(after?.qualifier, 'Los Angeles');
    assert.equal(after?.name, 'Lost In Dreams Los Angeles');

    const cleared = await dispatch(app, {
      url: '/api/manage/canonical/series/lost-in-dreams',
      method: 'PATCH',
      headers: json,
      body: { qualifier: '' },
    });
    assert.equal(cleared.status, 200);
    const plain = await store.getSeries('lost-in-dreams');
    assert.equal(plain?.qualifier, undefined);
    assert.equal(plain?.name, 'Lost In Dreams Los Angeles');

    const history = await store.listEntityHistory(10);
    const first = history.find((h) => h.series?.after.qualifier === 'Los Angeles');
    assert.equal(first?.series?.before.name, 'Lost In Dreams SoCal');
  });
});
