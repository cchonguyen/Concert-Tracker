import { dispatch } from './helpers/testApp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { entitiesRouter } from '../src/server/entities/routes.ts';
import { withEntityLinks } from '../src/server/entities/linkingStore.ts';
import { lineupRouter } from '../src/server/lineup/routes.ts';
import { createLookup } from '../src/server/lineup/pipeline.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';
import type { Edition } from '../src/server/lineup/types.ts';

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
  const linkedStore = withEntityLinks(store);
  let tick = 0;
  const deps = { store: linkedStore, now: () => new Date(Date.UTC(2026, 10, 3, 12, 0, tick++)) } as any;
  const runner = { kick: async () => undefined } as any;
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runAsMember(member as any, linkedStore as any, next));
  app.use('/api', lineupRouter(deps, runner));
  app.use('/api', entitiesRouter(deps));
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

test('owner edition list reports the exact 200/201 boundary and can find older matches', async () => {
  await withLineupApp({ role: 'owner', uid: 'u0' }, async (app, store) => {
    for (let i = 0; i < 201; i++) {
      const edition: Edition = {
        id: `edition-${i}`,
        key: `festival-${2200 - i}`,
        seriesSlug: 'festival',
        year: 2200 - i,
        name: `Festival ${i}`,
        status: 'confirmed',
        performances: [],
        updatedAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      };
      await store.upsertEdition(edition);
    }

    const page = await dispatch(app, { url: '/api/manage/canonical/editions?query=festival&status=confirmed' });
    assert.equal(page.status, 200);
    const body = (await page.json()) as { editions: Array<{ id: string; year: number }>; total: number; hasMore: boolean };
    assert.equal(body.total, 201);
    assert.equal(body.editions.length, 200);
    assert.equal(body.hasMore, true);
    assert.equal(body.editions[0].year, 2200);
    assert.equal(body.editions.at(-1)?.year, 2001);

    const older = await dispatch(app, { url: '/api/manage/canonical/editions?query=festival+200&status=confirmed' });
    assert.equal(older.status, 200);
    const olderBody = (await older.json()) as { editions: Array<{ id: string; year: number }>; total: number; hasMore: boolean };
    assert.equal(olderBody.total, 1);
    assert.equal(olderBody.editions.length, 1);
    assert.equal(olderBody.editions[0].id, 'edition-200');
    assert.equal(olderBody.editions[0].year, 2000);
    assert.equal(olderBody.hasMore, false);
  });
});

// Slice 8.7: owner-only preview and apply for catalog artist changes. Both run the real planner over a
// FileStore seeded with two artists sharing one edition, so a merge has a collision to count.
const SEED_AT = '2026-11-03T00:00:00.000Z';
const PREVIEW = '/api/manage/canonical/artists/old%20artist/preview';
const APPLY = '/api/manage/canonical/artists/old%20artist/apply';
const JSON_HEADERS = { 'content-type': 'application/json' };
const STALE = 'Preview is out of date; review it again';

async function seededLineup(): Promise<{ store: FileLineupStore; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'slice87-'));
  const performance = (artistKey: string, name: string, days: string[]) => ({ artistKey, name, days, stages: ['Main'], status: 'billed', confidence: 1, sources: [] });
  const state = {
    artists: {
      'old artist': { key: 'old artist', name: 'Old Artist' },
      'target artist': { key: 'target artist', name: 'Target Artist' },
    },
    editions: {
      ed1: {
        id: 'ed1',
        key: 'fest/2025',
        seriesSlug: 'fest',
        year: 2025,
        name: 'Fest 2025',
        status: 'confirmed',
        updatedAt: SEED_AT,
        performances: [performance('old artist', 'Old Artist', ['Fri']), performance('target artist', 'Target Artist', ['Sat'])],
      },
    },
    aliases: {},
  };
  await writeFile(path.join(dir, 'lineup-store.json'), JSON.stringify(state));
  return { store: new FileLineupStore(dir), dir };
}

async function withSeededApp(member: { role: string; uid: string }, fn: (app: express.Express, store: FileLineupStore, dir: string) => Promise<void>) {
  const { store, dir } = await seededLineup();
  const linkedStore = withEntityLinks(store);
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runAsMember(member as any, linkedStore as any, next));
  app.use('/api', entitiesRouter({ store: linkedStore, now: () => new Date(SEED_AT) } as any));
  await fn(app, store, dir);
}

const stateText = (dir: string) => readFile(path.join(dir, 'lineup-store.json'), 'utf8');
const post = (url: string, body: unknown) => ({ url, method: 'POST', headers: JSON_HEADERS, body });

test('members get 403 on preview and apply, before any planner or store call', async () => {
  // The stub store throws on any call, so a 403 here also proves nothing was read or written.
  await withApp({ role: 'member', uid: 'u1' }, async (app) => {
    for (const url of [PREVIEW, APPLY]) {
      const res = await dispatch(app, post(url, { op: 'rename', name: 'New Artist', previewFingerprint: 'x' }));
      assert.equal(res.status, 403);
      assert.match(((await res.json()) as { error: string }).error, /Only the owner/);
    }
  });
});

test('owner preview returns the operation, impact counts and a fingerprint, and writes nothing', async () => {
  await withSeededApp({ role: 'owner', uid: 'u0' }, async (app, _store, dir) => {
    const before = await stateText(dir);
    const res = await dispatch(app, post(PREVIEW, { op: 'rename', name: 'New Artist' }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { operation: string; impact: Record<string, unknown>; previewFingerprint: string };
    assert.deepEqual(Object.keys(body).sort(), ['impact', 'operation', 'previewFingerprint']);
    assert.equal(body.operation, 'canonical-rename');
    assert.deepEqual(body.impact, { editionsAffected: 1, performancesMoved: 1, ownerRecordsAffected: 0, communityNameKeysAffected: null });
    assert.equal(typeof body.previewFingerprint, 'string');
    assert.ok(body.previewFingerprint.length > 0);
    assert.equal(await stateText(dir), before, 'preview writes nothing');
  });
});

test('each operation previews with its own shape', async () => {
  await withSeededApp({ role: 'owner', uid: 'u0' }, async (app) => {
    const cases: Array<{ body: unknown; operation: string; performancesMoved: number }> = [
      { body: { op: 'rename', name: 'New Artist' }, operation: 'canonical-rename', performancesMoved: 1 },
      { body: { op: 'alias-add', name: 'Old AKA' }, operation: 'canonical-alias-add', performancesMoved: 0 },
      { body: { op: 'merge', into: 'target artist' }, operation: 'canonical-merge', performancesMoved: 1 },
    ];
    for (const c of cases) {
      const res = await dispatch(app, post(PREVIEW, c.body));
      assert.equal(res.status, 200, JSON.stringify(c.body));
      const body = (await res.json()) as { operation: string; impact: { performancesMoved: number; editionsAffected: number } };
      assert.equal(body.operation, c.operation);
      assert.equal(body.impact.performancesMoved, c.performancesMoved);
    }
  });
});

test('alias-remove previews once the alias exists', async () => {
  await withSeededApp({ role: 'owner', uid: 'u0' }, async (app, store) => {
    const add = (await (await dispatch(app, post(PREVIEW, { op: 'alias-add', name: 'Old AKA' }))).json()) as { previewFingerprint: string };
    const applied = await dispatch(app, post(APPLY, { op: 'alias-add', name: 'Old AKA', previewFingerprint: add.previewFingerprint }));
    assert.equal(applied.status, 200);
    assert.notDeepEqual(await store.getAliases(), {}, 'the alias is stored');

    const res = await dispatch(app, post(PREVIEW, { op: 'alias-remove', name: 'Old AKA' }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { operation: string; impact: { performancesMoved: number } };
    assert.equal(body.operation, 'canonical-alias-remove');
    assert.equal(body.impact.performancesMoved, 0);
  });
});

test('invalid bodies get 400 on preview and apply', async () => {
  await withSeededApp({ role: 'owner', uid: 'u0' }, async (app, _store, dir) => {
    const before = await stateText(dir);
    const bad: Array<{ url: string; body: unknown; message: RegExp }> = [
      { url: PREVIEW, body: { op: 'delete', name: 'x' }, message: /Unknown operation/ },
      { url: PREVIEW, body: { op: 'rename' }, message: /Missing name/ },
      { url: PREVIEW, body: { op: 'merge' }, message: /Missing into/ },
      { url: PREVIEW, body: { op: 'merge', name: 'target artist' }, message: /Unexpected field: name/ },
      { url: PREVIEW, body: { op: 'rename', name: 'New', extra: true }, message: /Unexpected field: extra/ },
      { url: PREVIEW, body: { op: 'rename', name: 'New', previewFingerprint: 'x' }, message: /Unexpected field: previewFingerprint/ },
      { url: PREVIEW, body: [], message: /Send one operation/ },
      { url: APPLY, body: { op: 'rename', name: 'New' }, message: /Missing previewFingerprint/ },
      { url: APPLY, body: { op: 'rename', name: 'New', previewFingerprint: '' }, message: /Missing previewFingerprint/ },
    ];
    for (const c of bad) {
      const res = await dispatch(app, post(c.url, c.body));
      assert.equal(res.status, 400, JSON.stringify(c.body));
      assert.match(((await res.json()) as { error: string }).error, c.message);
    }
    assert.equal(await stateText(dir), before, 'invalid bodies write nothing');
  });
});

test('apply with a fresh fingerprint succeeds and returns the entry summary and community count', async () => {
  await withSeededApp({ role: 'owner', uid: 'u0' }, async (app, store, dir) => {
    const preview = (await (await dispatch(app, post(PREVIEW, { op: 'rename', name: 'New Artist' }))).json()) as { previewFingerprint: string };
    const res = await dispatch(app, post(APPLY, { op: 'rename', name: 'New Artist', previewFingerprint: preview.previewFingerprint }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entry: { id: string; operation: string; summary: string; at: string }; communityNameKeysAffected: number | null };
    assert.equal(body.entry.operation, 'canonical-rename');
    assert.ok(!Number.isNaN(Date.parse(body.entry.at)), 'entry carries the plan time');
    assert.ok(body.entry.id.length > 0);
    assert.equal(typeof body.entry.summary, 'string');
    assert.equal(body.communityNameKeysAffected, null);
    assert.equal(await store.getArtist('old artist'), null);
    assert.deepEqual(await store.getArtist('new artist'), { key: 'new artist', name: 'New Artist' });
    assert.match(await stateText(dir), /canonical-rename/);
  });
});

test('apply with a stale fingerprint returns 409 with the exact message and writes nothing', async () => {
  await withSeededApp({ role: 'owner', uid: 'u0' }, async (app, store, dir) => {
    const preview = (await (await dispatch(app, post(PREVIEW, { op: 'rename', name: 'New Artist' }))).json()) as { previewFingerprint: string };
    // Another owner edit changes a performance row the rename relies on.
    await store.upsertEdition({
      id: 'ed2',
      key: 'fest/2024',
      seriesSlug: 'fest',
      year: 2024,
      name: 'Fest 2024',
      status: 'confirmed',
      updatedAt: SEED_AT,
      performances: [{ artistKey: 'old artist', name: 'Old Artist', days: ['Thu'], stages: ['Main'], status: 'billed', confidence: 1, sources: [] }],
    } as Edition);
    const before = await stateText(dir);

    const res = await dispatch(app, post(APPLY, { op: 'rename', name: 'New Artist', previewFingerprint: preview.previewFingerprint }));
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: STALE });
    assert.equal(await stateText(dir), before, 'stale apply writes nothing');
    assert.deepEqual(await store.getArtist('old artist'), { key: 'old artist', name: 'Old Artist' });
  });
});

test('apply of a merge with a fresh fingerprint collapses the source row', async () => {
  await withSeededApp({ role: 'owner', uid: 'u0' }, async (app, store) => {
    const preview = (await (await dispatch(app, post(PREVIEW, { op: 'merge', into: 'target artist' }))).json()) as { previewFingerprint: string };
    const res = await dispatch(app, post(APPLY, { op: 'merge', into: 'target artist', previewFingerprint: preview.previewFingerprint }));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { entry: { operation: string } }).entry.operation, 'canonical-merge');
    assert.equal(await store.getArtist('old artist'), null);
    assert.ok(await store.getArtist('target artist'));
  });
});

// No-op operations are refused by the planner, so preview and apply return its error and write nothing.
test('an operation with no change is refused by the planner on preview and apply', async () => {
  await withSeededApp({ role: 'owner', uid: 'u0' }, async (app, _store, dir) => {
    const before = await stateText(dir);
    const same = await dispatch(app, post(PREVIEW, { op: 'rename', name: 'Old Artist' }));
    assert.equal(same.status, 400);
    assert.match(((await same.json()) as { error: string }).error, /already called/);

    const missing = await dispatch(app, post(PREVIEW, { op: 'alias-remove', name: 'Old AKA' }));
    assert.equal(missing.status, 404);
    assert.match(((await missing.json()) as { error: string }).error, /is not an AKA/);

    const self = await dispatch(app, post(APPLY, { op: 'alias-add', name: 'Old Artist', previewFingerprint: 'anything' }));
    assert.equal(self.status, 400);
    assert.match(((await self.json()) as { error: string }).error, /already its name/);

    assert.equal(await stateText(dir), before, 'no-op operations write nothing');
  });
});

test('apply recomputes the plan on the server and ignores any plan sent by the client', async () => {
  await withSeededApp({ role: 'owner', uid: 'u0' }, async (app, store) => {
    const preview = (await (await dispatch(app, post(PREVIEW, { op: 'rename', name: 'New Artist' }))).json()) as { previewFingerprint: string };
    // A client-built plan is an unknown field, so it is refused before the planner runs.
    const res = await dispatch(app, post(APPLY, { op: 'rename', name: 'New Artist', previewFingerprint: preview.previewFingerprint, plan: { entry: {} } }));
    assert.equal(res.status, 400);
    assert.deepEqual(await store.getArtist('old artist'), { key: 'old artist', name: 'Old Artist' });
  });
});
