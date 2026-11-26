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
import { cleanSeriesName } from '../src/server/lineup/seriesResolve.ts';

const json = { 'content-type': 'application/json' };

async function withApp(role: 'owner' | 'member', fn: (app: express.Express, store: FileLineupStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'series-cleanup-route-'));
  try {
    const store = new FileLineupStore(dir);
    const linked = withEntityLinks(store);
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => runAsMember({ role, uid: role === 'owner' ? 'u0' : 'u1' } as any, linked as any, next));
    app.use('/api', entitiesRouter({ store: linked, now: () => new Date('2026-11-26T00:00:00.000Z') } as any));
    await fn(app, store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the approved list is well formed: each new series made once, before any edition moves into it', () => {
  const made = new Set<string>();
  for (const s of SERIES_CLEANUP_PLAN) {
    if (s.op === 'series' && s.create) {
      assert.equal(made.has(s.slug), false, `${s.slug} made twice`);
      made.add(s.slug);
    }
  }
  const later = new Set<string>();
  for (const s of [...SERIES_CLEANUP_PLAN].reverse()) {
    if (s.op === 'series' && s.create) later.add(s.slug);
    if (s.op === 'edition' && s.seriesSlug) assert.equal(later.has(s.seriesSlug), false, `${s.id} moves before ${s.seriesSlug} exists`);
  }
  assert.equal(SERIES_CLEANUP_PLAN.at(-1)?.op, 'linkEvents');
});

test('no series name or qualifier in the list carries a year, weekend or ticket extra', () => {
  for (const s of SERIES_CLEANUP_PLAN) {
    if (s.op !== 'series') continue;
    for (const words of [s.name, s.qualifier]) {
      if (words) assert.equal(cleanSeriesName(words), words, `${s.slug}: "${words}"`);
    }
  }
});

test('the owner previews in batches and nothing changes; a run batch is capped; members are refused', async () => {
  await withApp('owner', async (app, store) => {
    await store.upsertSeries({ slug: 'electric-zoo', name: 'Electric Zoo', kind: 'festival' });
    const res = await dispatch(app, { url: '/api/manage/canonical/series-cleanup?from=0&count=50' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { total: number; results: Array<{ step: number; target: string; outcome: string }> };
    assert.equal(body.total, SERIES_CLEANUP_PLAN.length);
    assert.equal(body.results.length, 20);
    assert.equal(body.results[0].step, 1);
    assert.equal((await store.getSeries('electric-zoo'))?.brand, undefined);

    const zoo = SERIES_CLEANUP_PLAN.findIndex((s) => s.op === 'series' && s.slug === 'electric-zoo');
    const ran = await dispatch(app, { url: '/api/manage/canonical/series-cleanup', method: 'POST', headers: json, body: { from: zoo, count: 10 } });
    const run = (await ran.json()) as { results: Array<{ outcome: string }> };
    assert.equal(run.results.length, 3);
    assert.equal(run.results[0].outcome, 'done');
    assert.equal((await store.getSeries('electric-zoo'))?.brand, 'Electric Zoo');
  });
  await withApp('member', async (app) => {
    assert.equal((await dispatch(app, { url: '/api/manage/canonical/series-cleanup' })).status, 403);
  });
});
