import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { genresRouter } from '../src/server/events/genreRoutes.ts';
import { GENRE_MAP_SETTING } from '../src/server/events/genres.ts';
import { ownerOnly, runAsMember } from '../src/server/auth/requestScope.ts';
import type { LoggedEvent, SeenAct } from '../src/server/events/types.ts';

const json = { 'content-type': 'application/json' };
const now = new Date('2026-11-26T00:00:00Z');

const ev = (seen: SeenAct[]): LoggedEvent => ({
  id: 'e1',
  input: 'e1',
  name: 'e1',
  sources: {},
  details: { status: 'resolved', candidates: [], notes: [] },
  seen,
  daysAttended: [],
  companions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

async function withApp(fn: (app: express.Express, store: FileLineupStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'genre-vocab-route-'));
  try {
    const store = new FileLineupStore(dir);
    await store.putEvent(ev([{ key: 'bonobo', name: 'Bonobo', from: 'you' }]));
    await store.putSetting(GENRE_MAP_SETTING, [
      { tag: 'house', style: 'house', parent: 'electronic' },
      { tag: 'techno', style: 'techno', parent: 'electronic' },
      { tag: 'hip hop', style: 'Hip Hop', parent: 'hip hop' },
      { tag: 'hip-hop', style: 'hip-hop', parent: 'hip hop' },
    ]);
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', genresRouter({ store, fetcher: {} as any, now: () => now } as any));
    await fn(app, store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const asRole = <T>(role: 'owner' | 'member', store: FileLineupStore, fn: () => Promise<T>) =>
  new Promise<T>((resolve, reject) =>
    runAsMember({ role, userId: `u-${role}`, email: `${role}@example.test` } as any, store as any, () => fn().then(resolve, reject)),
  );

const post = (app: express.Express, url: string, body: unknown = {}) => dispatch(app, { url, method: 'POST', headers: json, body });

const WRITES: Array<[string, Record<string, unknown>]> = [
  ['create', { name: 'melodic bass' }],
  ['rename', { genre: 'house', name: 'House' }],
  ['alias-add', { genre: 'house', alias: 'haus' }],
  ['alias-remove', { genre: 'house', alias: 'haus' }],
  ['parent', { genre: 'house', parent: 'electronic' }],
  ['umbrella-add', { genre: 'house', umbrella: 'techno' }],
  ['umbrella-remove', { genre: 'house', umbrella: 'techno' }],
  ['spelling', { key: 'hiphop', spelling: 'Hip Hop' }],
  ['merge-preview', { drop: 'techno', keep: 'house' }],
  ['merge', { drop: 'techno', keep: 'house' }],
  ['undo/some-id', {}],
];

test('every vocabulary write is owner-only in requestScope; the GET is not', () => {
  for (const [op] of WRITES) assert.equal(ownerOnly('POST', `/api/artist-genres/vocabulary/${op}`), true, op);
  assert.equal(ownerOnly('GET', '/api/artist-genres'), false);
});

test('a member gets 403 on every vocabulary write, and nothing is written', async () => {
  await withApp(async (app, store) => {
    for (const [op, body] of WRITES) {
      const res = await asRole('member', store, () => post(app, `/api/artist-genres/vocabulary/${op}`, body));
      assert.equal(res.status, 403, op);
    }
    assert.deepEqual((await store.getGenreVocabulary()).genres, []);
    assert.deepEqual(await store.listGenreVocabChanges({}), []);
  });
});

test("a member's GET has the vocabulary and the map, but no change log and no collisions", async () => {
  await withApp(async (app, store) => {
    await asRole('owner', store, () => post(app, '/api/artist-genres/vocabulary/create', { name: 'melodic bass' }));
    const res = await asRole('member', store, () => dispatch(app, { url: '/api/artist-genres' }));
    assert.equal(res.status, 200);
    const body = res.json<Record<string, unknown>>();
    assert.deepEqual((body.vocabulary as { genres: Array<{ name: string }> }).genres.map((g) => g.name), ['melodic bass']);
    assert.equal((body.map as unknown[]).length, 4);
    assert.equal('vocabularyChanges' in body, false);
    assert.equal('collisions' in body, false);
  });
});

test("the owner's GET has the change log and the collisions", async () => {
  await withApp(async (app, store) => {
    await asRole('owner', store, () => post(app, '/api/artist-genres/vocabulary/create', { name: 'melodic bass' }));
    const body = (await asRole('owner', store, () => dispatch(app, { url: '/api/artist-genres' }))).json<{
      vocabularyChanges: Array<{ summary: string }>;
      collisions: Array<{ key: string }>;
      map: unknown[];
    }>();
    assert.deepEqual(body.vocabularyChanges.map((c) => c.summary), ['melodic bass created']);
    assert.deepEqual(body.collisions.map((c) => c.key), ['hiphop']);
    assert.equal(body.map.length, 4);
  });
});

test("the owner's operations work end to end, and undo takes the newest back", async () => {
  await withApp(async (app, store) => {
    const owner = (url: string, body: unknown = {}) => asRole('owner', store, () => post(app, url, body));
    const ok = async (url: string, body: unknown = {}) => {
      const res = await owner(url, body);
      assert.equal(res.status, 200, `${url}: ${res.text()}`);
      return res.json<any>();
    };
    const genre = async (key: string) => (await store.getGenreVocabulary()).genres.find((g) => g.key === key);

    await ok('/api/artist-genres/vocabulary/create', { name: 'melodic bass', parent: 'electronic' });
    assert.equal((await genre('melodicbass'))?.parent, 'electronic');

    await ok('/api/artist-genres/vocabulary/rename', { genre: 'house', name: 'House Music' });
    assert.deepEqual((await genre('housemusic'))?.aliases.map((a) => a.alias), ['house']);

    await ok('/api/artist-genres/vocabulary/alias-add', { genre: 'House Music', alias: 'haus' });
    assert.ok((await genre('housemusic'))?.aliases.some((a) => a.key === 'haus'));
    await ok('/api/artist-genres/vocabulary/alias-remove', { genre: 'House Music', alias: 'haus' });
    assert.ok(!(await genre('housemusic'))?.aliases.some((a) => a.key === 'haus'));

    await ok('/api/artist-genres/vocabulary/parent', { genre: 'techno', parent: 'electronic' });
    assert.equal((await genre('techno'))?.parent, 'electronic');

    await ok('/api/artist-genres/vocabulary/umbrella-add', { genre: 'techno', umbrella: 'melodic bass' });
    assert.deepEqual((await genre('techno'))?.umbrellas, ['melodicbass']);
    await ok('/api/artist-genres/vocabulary/umbrella-remove', { genre: 'techno', umbrella: 'melodic bass' });
    assert.deepEqual((await genre('techno'))?.umbrellas, []);

    await ok('/api/artist-genres/vocabulary/spelling', { key: 'hiphop', spelling: 'hip-hop' });
    assert.equal((await genre('hiphop'))?.name, 'hip-hop');

    const preview = await ok('/api/artist-genres/vocabulary/merge-preview', { drop: 'techno', keep: 'House Music' });
    assert.equal(preview.plan.keep.key, 'housemusic');
    assert.ok(await genre('techno'), 'the preview writes nothing');

    const merged = await ok('/api/artist-genres/vocabulary/merge', { drop: 'techno', keep: 'House Music' });
    assert.equal(merged.change.operation, 'merge');
    assert.equal(await genre('techno'), undefined);
    assert.ok((await genre('housemusic'))?.aliases.some((a) => a.key === 'techno'));

    const undone = await ok(`/api/artist-genres/vocabulary/undo/${encodeURIComponent(merged.change.id)}`);
    assert.equal(undone.change.operation, 'undo');
    assert.ok(await genre('techno'));

    const again = await owner(`/api/artist-genres/vocabulary/undo/${encodeURIComponent(merged.change.id)}`);
    assert.equal(again.status, 409);
  });
});

test('a ManageError status becomes the HTTP status; an unknown operation is a 404', async () => {
  await withApp(async (app, store) => {
    const owner = (url: string, body: unknown = {}) => asRole('owner', store, () => post(app, url, body));
    assert.equal((await owner('/api/artist-genres/vocabulary/create', { name: '!!' })).status, 400);
    const taken = await owner('/api/artist-genres/vocabulary/create', { name: 'House' });
    assert.equal(taken.status, 409);
    assert.equal(taken.json<{ error: string }>().error, 'That is already a genre: house.');
    assert.equal((await owner('/api/artist-genres/vocabulary/rename', { genre: 'nope', name: 'x' })).status, 404);
    assert.equal((await owner('/api/artist-genres/vocabulary/undo/missing')).status, 404);
    assert.equal((await owner('/api/artist-genres/vocabulary/explode')).status, 404);
    assert.equal((await owner('/api/artist-genres/vocabulary/undo')).status, 404);
  });
});
