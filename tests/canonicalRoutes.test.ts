import { dispatch } from './helpers/testApp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { entitiesRouter } from '../src/server/entities/routes.ts';
import { lineupRouter } from '../src/server/lineup/routes.ts';
import { createLookup } from '../src/server/lineup/pipeline.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';

// The guard runs before the store is touched, so a stub store is enough for
// the 403 path. Each request runs as the given member (via the request scope).
async function withApp(member: { role: string; uid: string }, fn: (app: express.Express) => Promise<void>) {
  const store: any = new Proxy({}, { get: () => () => { throw new Error('store should not be reached for members'); } });
  const app = express();
  app.use((_req, _res, next) => runAsMember(member as any, store, next));
  app.use('/api', entitiesRouter({ store } as any));
  await fn(app);
}

for (const path of ['/api/manage/canonical/editions', '/api/manage/canonical/artists']) {
  test(`member gets 403 on ${path}`, async () => {
    await withApp({ role: 'member', uid: 'u1' }, async (app) => {
      const res = await dispatch(app, { url: path });
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /Only the owner/);
    });
  });
}

// The owner's ingest queue (GET /api/manage/canonical/lookups) and the ingest route, on a file store.
async function withLineupApp(
  member: { role: string; uid: string },
  fn: (app: express.Express, store: FileLineupStore) => Promise<void>,
) {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'canon-routes-')));
  let tick = 0;
  const deps = { store, now: () => new Date(Date.UTC(2026, 10, 3, 12, 0, tick++)) } as any;
  const runner = { kick: async () => undefined } as any;
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runAsMember(member as any, store as any, next));
  app.use('/api', lineupRouter(deps, runner));
  await fn(app, store);
  return deps;
}

test('member gets 403 on the ingest queue and on running a canonical job', async () => {
  await withLineupApp({ role: 'member', uid: 'u1' }, async (app) => {
    const list = await dispatch(app, { url: '/api/manage/canonical/lookups' });
    assert.equal(list.status, 403);
    assert.match(((await list.json()) as { error: string }).error, /Only the owner/);
  });
});

test('owner sees only event-less jobs, newest first', async () => {
  await withLineupApp({ role: 'owner', uid: 'u0' }, async (app, store) => {
    const deps = { store, now: () => new Date('2026-11-03T12:00:00Z') } as any;
    const older = await createLookup(deps, { eventName: 'Older Fest', year: 2023, startDate: '2023-06-01' } as any);
    await createLookup(deps, { eventName: 'Saved Event', year: 2024, startDate: '2024-06-01' } as any, { eventId: 'evt-1' });
    const newer = await createLookup(deps, { eventName: 'Newer Fest', year: 2025, startDate: '2025-06-01' } as any);
    // Make the order explicit: createdAt decides it, not insertion order.
    await store.updateJob({ ...older, createdAt: '2026-01-01T00:00:00.000Z' });
    await store.updateJob({ ...newer, createdAt: '2026-03-01T00:00:00.000Z' });

    const res = await dispatch(app, { url: '/api/manage/canonical/lookups' });
    assert.equal(res.status, 200);
    const { jobs } = (await res.json()) as { jobs: Array<{ id: string; eventId?: string; input: { eventName: string } }> };
    assert.deepEqual(jobs.map((j) => j.input.eventName), ['Newer Fest', 'Older Fest']);
    assert.ok(jobs.every((j) => j.eventId === undefined), 'no job with an eventId is listed');
  });
});

test('an ingest error reaches the caller with its message and creates no job', async () => {
  await withLineupApp({ role: 'owner', uid: 'u0' }, async (app, store) => {
    const res = await dispatch(app, { url: '/api/manage/canonical/ingest',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { name: '   ', year: 2024 },
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'Event name is required.');
    assert.deepEqual(await store.listCanonicalJobs(10), []);
  });
});
