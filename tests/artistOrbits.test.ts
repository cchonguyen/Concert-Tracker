import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { genresRouter } from '../src/server/events/genreRoutes.ts';
import { ArtistOrbitError, orbitsForMember, writeArtistOrbits, type ArtistOrbit } from '../src/server/events/artistOrbits.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';
import type { LoggedEvent } from '../src/server/events/types.ts';

async function withStore(fn: (store: FileLineupStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'artist-orbits-'));
  try {
    const store = new FileLineupStore(dir);
    await store.writeGenreVocabulary(
      [{ key: 'rock', image: { key: 'rock', name: 'Rock', aliases: [], umbrellas: [] } }],
      { operation: 'create', actor: 'owner', reason: 'Test', summary: 'Add rock' },
    );
    await fn(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ev = (seenKeys: string[]): LoggedEvent => ({
  id: 'e1',
  input: 'e1',
  name: 'e1',
  sources: {},
  details: { status: 'resolved', candidates: [], notes: [] },
  seen: seenKeys.map((key) => ({ key, name: key, from: 'you' })),
  daysAttended: [],
  companions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as LoggedEvent);

const orbit = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  anchorKeys: ['bonobo', 'thievery'],
  members: [] as Array<{ artistKey: string; centrality: number }>,
  ...over,
});

const MINE: ArtistOrbit = {
  id: 'mine',
  anchorKeys: ['bonobo', 'thievery'],
  workingLabel: 'Downtempo',
  parentGenreKey: 'rock',
  origin: 'curated',
  members: [
    { artistKey: 'bonobo', centrality: 1 },
    { artistKey: 'thievery', centrality: 1 },
    { artistKey: 'zero-7', centrality: 0.5 },
  ],
};

async function refusedWith(p: Promise<unknown>, status: number, pattern?: RegExp) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof ArtistOrbitError, `expected ArtistOrbitError, got ${String(err)}`);
    assert.equal(err.status, status);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

test('write and list: the orbit comes back with its anchors and members in order', async () => {
  await withStore(async (store) => {
    const change = await writeArtistOrbits(
      store,
      [{ ...MINE, members: [{ artistKey: 'zero-7', centrality: 0.5 }] }],
      [],
      'owner',
      'Start',
    );
    assert.deepEqual(await store.listArtistOrbits(), [MINE]);
    assert.equal(change.actor, 'owner');
    assert.equal(change.reason, 'Start');
    assert.deepEqual(change.old, []);
    assert.deepEqual(change.new, [MINE]);
  });
});

test('anchors are added as members at 1.0 when not listed', async () => {
  await withStore(async (store) => {
    await writeArtistOrbits(store, [orbit('o2', { anchorKeys: ['a', 'b', 'c'], members: [{ artistKey: 'd', centrality: 0.25 }] })], [], 'owner', 'Anchors');
    const [o] = await store.listArtistOrbits();
    assert.deepEqual(o, {
      id: 'o2',
      anchorKeys: ['a', 'b', 'c'],
      origin: 'curated',
      members: [
        { artistKey: 'a', centrality: 1 },
        { artistKey: 'b', centrality: 1 },
        { artistKey: 'c', centrality: 1 },
        { artistKey: 'd', centrality: 0.25 },
      ],
    });
  });
});

test('refusals: anchors, centrality, genre, actor, reason and ids; nothing is written', async () => {
  await withStore(async (store) => {
    await refusedWith(writeArtistOrbits(store, [orbit('o', { anchorKeys: ['a'] })], [], 'owner', 'r'), 400, /2 to 4 anchors/);
    await refusedWith(writeArtistOrbits(store, [orbit('o', { anchorKeys: ['a', 'b', 'c', 'd', 'e'] })], [], 'owner', 'r'), 400, /2 to 4 anchors/);
    await refusedWith(
      writeArtistOrbits(store, [orbit('o', { anchorKeys: ['a', 'b'], members: [{ artistKey: 'a', centrality: 0.5 }] })], [], 'owner', 'r'),
      400,
      /Anchor a .* centrality 1/,
    );
    await refusedWith(
      writeArtistOrbits(store, [orbit('o', { members: [{ artistKey: 'x', centrality: 0.3 }] })], [], 'owner', 'r'),
      400,
      /centrality of 1, 0.5 or 0.25/,
    );
    await refusedWith(writeArtistOrbits(store, [orbit('o', { parentGenreKey: 'jazz' })], [], 'owner', 'r'), 400, /jazz is not a genre/);
    await refusedWith(writeArtistOrbits(store, [orbit('o')], [], 'member', 'r'), 400, /owner or a system job/);
    await refusedWith(writeArtistOrbits(store, [orbit('o')], [], 'owner', '  '), 400, /reason/);
    await refusedWith(writeArtistOrbits(store, [orbit('  ')], [], 'owner', 'r'), 400, /id is required/);
    await refusedWith(writeArtistOrbits(store, [orbit('o'), orbit('o')], [], 'owner', 'r'), 400, /listed twice/);
    assert.deepEqual(await store.listArtistOrbits(), []);
    assert.deepEqual(await store.listOrbitChanges({ limit: 10 }), []);
  });
});

test('undo restores the images before the change, and the log records it', async () => {
  await withStore(async (store) => {
    const c1 = await writeArtistOrbits(store, [MINE], [], 'owner', 'First');
    const c2 = await writeArtistOrbits(store, [{ ...MINE, workingLabel: 'Later' }], ['mine'], 'owner', 'Second');
    assert.equal((await store.listArtistOrbits())[0].workingLabel, 'Later');

    const undo = await store.undoOrbitChange(c2.id, 'owner');
    assert.equal((await store.listArtistOrbits())[0].workingLabel, 'Downtempo');
    assert.equal(undo.reason, 'Undo');

    const logged = (await store.listOrbitChanges({ limit: 10 })).find((c) => c.id === c2.id)!;
    assert.ok(logged.undoneAt);
    assert.equal(logged.undoneBy, 'owner');

    await store.undoOrbitChange(c1.id, 'owner');
    assert.deepEqual(await store.listArtistOrbits(), []);
  });
});

test('stale undo is refused when an orbit changed after the change', async () => {
  await withStore(async (store) => {
    const c1 = await writeArtistOrbits(store, [MINE], [], 'owner', 'First');
    await writeArtistOrbits(store, [{ ...MINE, workingLabel: 'Later' }], ['mine'], 'owner', 'Second');
    await refusedWith(store.undoOrbitChange(c1.id, 'owner'), 409, /Changed since/);
    assert.equal((await store.listArtistOrbits())[0].workingLabel, 'Later');
  });
});

test('double undo is refused', async () => {
  await withStore(async (store) => {
    const c1 = await writeArtistOrbits(store, [MINE], [], 'owner', 'First');
    await store.undoOrbitChange(c1.id, 'owner');
    await refusedWith(store.undoOrbitChange(c1.id, 'owner'), 409, /already undone/);
    await refusedWith(store.undoOrbitChange('no-such-id', 'owner'), 404);
  });
});

test('orbitsForMember keeps the orbits holding one of the keys, with the full roster', () => {
  const other = { id: 'other', anchorKeys: ['x', 'y'], origin: 'curated' as const, members: [{ artistKey: 'x', centrality: 1 as const }, { artistKey: 'y', centrality: 1 as const }] };
  assert.deepEqual(orbitsForMember([MINE, other], new Set(['zero-7'])), [MINE]);
  assert.deepEqual(orbitsForMember([MINE, other], new Set(['nobody'])), []);
});

test('GET /api/artist-orbits: the owner gets every orbit and the changes; a member gets only theirs, no changes', async () => {
  await withStore(async (store) => {
    await store.putEvent(ev(['bonobo']));
    await writeArtistOrbits(store, [MINE], [], 'owner', 'Mine');
    await writeArtistOrbits(store, [{ id: 'other', anchorKeys: ['x', 'y'], members: [] }], [], 'owner', 'Other');

    const owner = express();
    owner.use(express.json());
    owner.use('/api', genresRouter({ store, fetcher: {} as any, now: () => new Date() } as any));
    const ownerBody = (await (await dispatch(owner, { url: '/api/artist-orbits' })).json()) as { orbits: unknown[]; changes: unknown[] };
    assert.equal(ownerBody.orbits.length, 2);
    assert.equal(ownerBody.changes.length, 2);

    const member = express();
    member.use(express.json());
    member.use((_req, _res, next) => runAsMember({ email: 'm@example.com', userId: 'u2', role: 'member' } as any, store, next));
    member.use('/api', genresRouter({ store, fetcher: {} as any, now: () => new Date() } as any));
    const memberBody = (await (await dispatch(member, { url: '/api/artist-orbits' })).json()) as Record<string, unknown>;
    assert.deepEqual(memberBody, { orbits: [MINE] });
  });
});

test('member undo is refused with 403 and changes nothing', async () => {
  await withStore(async (store) => {
    const c1 = await writeArtistOrbits(store, [MINE], [], 'owner', 'Mine');
    const member = express();
    member.use(express.json());
    member.use((_req, _res, next) => runAsMember({ email: 'm@example.com', userId: 'u2', role: 'member' } as any, store, next));
    member.use('/api', genresRouter({ store, fetcher: {} as any, now: () => new Date() } as any));
    const res = await dispatch(member, { method: 'POST', url: `/api/artist-orbits/undo/${c1.id}` });
    assert.equal(res.status, 403);
    assert.equal((await store.listArtistOrbits()).length, 1);
    assert.equal((await store.listOrbitChanges({ limit: 10 }))[0].undoneAt, undefined);
  });
});

test('GET /api/artist-orbits answers no orbits when migration 0064 is not applied', async () => {
  await withStore(async (store) => {
    const missing = Object.assign(Object.create(store), {
      listArtistOrbits: async () => {
        throw Object.assign(new Error('Could not find the function public.artist_orbits_images'), { code: 'PGRST202' });
      },
    });
    const app = express();
    app.use(express.json());
    app.use('/api', genresRouter({ store: missing, fetcher: {} as any, now: () => new Date() } as any));
    const res = await dispatch(app, { url: '/api/artist-orbits' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { orbits: [] });
  });
});
