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
import { parseCsv } from '../src/services/listImport.ts';
import { parseArtistCleanupCsv } from '../src/server/entities/artistCleanupCsv.ts';

const json = { 'content-type': 'application/json' };

async function withApp(role: 'owner' | 'member', fn: (app: express.Express, store: FileLineupStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'artist-cleanup-route-'));
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

test('artist-cleanup preview/apply routes allow owner and reject members with 403', async () => {
  const { rows } = parseArtistCleanupCsv(
    parseCsv('Artist,Entity_Status,Invalid_Reason\r\n(Surprise),invalid_non_artist,placeholder'),
  );

  await withApp('owner', async (app, store) => {
    await store.upsertArtist({ key: 'surprise', name: '(Surprise)' });
    const prev = await dispatch(app, {
      url: '/api/manage/canonical/artist-cleanup/preview',
      method: 'POST',
      headers: json,
      body: { rows },
    });
    assert.equal(prev.status, 200);
    const prevBody = (await prev.json()) as any;
    assert.equal(prevBody.dryRun, true);
    assert.equal(prevBody.counts.invalid_non_artist, 1);

    const applied = await dispatch(app, {
      url: '/api/manage/canonical/artist-cleanup/apply',
      method: 'POST',
      headers: json,
      body: { rows },
    });
    assert.equal(applied.status, 200);
    const appliedBody = (await applied.json()) as any;
    assert.equal(appliedBody.dryRun, false);
    assert.equal(await store.getArtist('surprise'), null);
  });

  await withApp('member', async (app) => {
    const prev = await dispatch(app, {
      url: '/api/manage/canonical/artist-cleanup/preview',
      method: 'POST',
      headers: json,
      body: { rows },
    });
    assert.equal(prev.status, 403);
    const applied = await dispatch(app, {
      url: '/api/manage/canonical/artist-cleanup/apply',
      method: 'POST',
      headers: json,
      body: { rows },
    });
    assert.equal(applied.status, 403);
  });
});
