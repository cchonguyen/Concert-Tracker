import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { genresRouter } from '../src/server/events/genreRoutes.ts';
import { ArtistOrbitError, writeArtistOrbits, type ArtistOrbit } from '../src/server/events/artistOrbits.ts';
import {
  applyArtistOrbitsCsv,
  parseArtistOrbitsCsv,
  previewArtistOrbitsCsv,
  splitNames,
} from '../src/server/events/artistOrbitsCsv.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';
import { parseCsv } from '../src/services/listImport.ts';
import type { LoggedEvent, SeenAct } from '../src/server/events/types.ts';

const now = new Date('2026-11-27T00:00:00Z');
const HEADER = 'orbit_id,label,parent_genre,anchors,core,crossover';
const csvOf = (...lines: string[]) => [HEADER, ...lines].join('\n');

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

const SEEN: SeenAct[] = ['Bonobo', 'Caribou', 'Kelela', 'Nightmares', 'Jungle'].map((name) => ({
  key: name.toLowerCase(),
  name,
  from: 'you',
}));

const SEED_O1: ArtistOrbit = {
  id: 'o1',
  anchorKeys: ['bonobo', 'caribou'],
  origin: 'curated',
  members: [
    { artistKey: 'bonobo', centrality: 1 },
    { artistKey: 'caribou', centrality: 1 },
  ],
};
const SEED_O2: ArtistOrbit = {
  id: 'o2',
  anchorKeys: ['kelela', 'nightmares'],
  origin: 'curated',
  members: [
    { artistKey: 'kelela', centrality: 1 },
    { artistKey: 'nightmares', centrality: 1 },
  ],
};

async function withStore(fn: (store: FileLineupStore, dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'artist-orbits-csv-'));
  try {
    const store = new FileLineupStore(dir);
    await store.writeGenreVocabulary(
      [
        {
          key: 'house',
          image: { key: 'house', name: 'House', aliases: [{ key: 'housemusic', alias: 'House music' }], umbrellas: [] },
        },
      ],
      { operation: 'create', actor: 'owner', reason: 'Test', summary: 'Add house' },
    );
    await store.putEvent(ev(SEEN));
    await fn(store, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withApps(store: FileLineupStore, fn: (owner: express.Express, member: express.Express) => Promise<void>) {
  const owner = express();
  owner.use(express.json({ limit: '1mb' }));
  owner.use('/api', genresRouter({ store, fetcher: {} as any, now: () => now } as any));
  const member = express();
  member.use(express.json({ limit: '1mb' }));
  member.use((_req, _res, next) => runAsMember({ email: 'm@example.com', userId: 'u2', role: 'member' } as any, store, next));
  member.use('/api', genresRouter({ store, fetcher: {} as any, now: () => now } as any));
  await fn(owner, member);
}

test('splitNames trims, collapses spaces and drops blanks', () => {
  assert.deepEqual(splitNames(' Bonobo ;  Caribou  ;; '), ['Bonobo', 'Caribou']);
  assert.deepEqual(splitNames(''), []);
});

test('parse reads the columns by name and maps each list to its centrality', async () => {
  await withStore(async (store) => {
    const parsed = parseArtistOrbitsCsv(parseCsv(csvOf('o1,Warm,House music,Bonobo; Caribou,Kelela,Nightmares')));
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].line, 2);
    assert.equal(parsed.rows[0].anchors, 'Bonobo; Caribou');

    const preview = await previewArtistOrbitsCsv(store, csvOf('o1,Warm,House music,Bonobo; Caribou,Kelela,Nightmares'));
    assert.deepEqual(preview, { added: 1, removed: 0, changed: 0, unchanged: 0, errors: [] });
    const change = await applyArtistOrbitsCsv(store, csvOf('o1,Warm,House music,Bonobo; Caribou,Kelela,Nightmares'));
    assert.ok(change.change);
    const [stored] = await store.listArtistOrbits();
    assert.equal(stored.workingLabel, 'Warm');
    assert.equal(stored.parentGenreKey, 'house');
    assert.deepEqual(stored.anchorKeys, ['bonobo', 'caribou']);
    const centrality = Object.fromEntries(stored.members.map((m) => [m.artistKey, m.centrality]));
    assert.deepEqual(centrality, { bonobo: 1, caribou: 1, kelela: 0.5, nightmares: 0.25 });
  });
});

test('a file with no header columns is refused, naming each missing column', async () => {
  await withStore(async (store) => {
    const preview = await previewArtistOrbitsCsv(store, 'orbit_id,label\no1,Warm');
    assert.equal(preview.errors.length, 4);
    assert.match(preview.errors[0].message, /missing the "parent_genre" column/);
    await assert.rejects(applyArtistOrbitsCsv(store, 'orbit_id,label\no1,Warm'), (err: unknown) => err instanceof ArtistOrbitError && err.status === 400);
  });
});

test('each refusal names its row', async () => {
  await withStore(async (store) => {
    const cases: Array<[string, RegExp]> = [
      [csvOf('o1,,,Bonobo; Nobody,,'), /Nobody is not an act you can give genres/],
      [csvOf('o1,,,Bonobo,,'), /needs 2 to 4 anchors/],
      [csvOf('o1,,,Bonobo; Caribou; Kelela; Nightmares; Jungle,,'), /needs 2 to 4 anchors/],
      [csvOf('o1,,Dubstep,Bonobo; Caribou,,'), /Dubstep is not a genre in the vocabulary/],
      [csvOf('o1,,,Bonobo; Caribou,,', 'o1,,,Kelela; Nightmares,,'), /orbit_id o1 is listed more than once/],
      [csvOf('o1,,,Bonobo; Caribou,Bonobo,'), /Bonobo is listed twice in orbit o1/],
    ];
    for (const [csv, message] of cases) {
      const preview = await previewArtistOrbitsCsv(store, csv);
      assert.ok(preview.errors.length > 0, csv);
      assert.match(preview.errors[0].message, message);
      assert.ok(preview.errors[0].row >= 1);
      await assert.rejects(applyArtistOrbitsCsv(store, csv), (err: unknown) => err instanceof ArtistOrbitError && err.status === 400);
    }
    assert.equal((await store.listArtistOrbits()).length, 0);
  });
});

test('the file replaces the whole set: orbits not in it are removed and counted', async () => {
  await withStore(async (store) => {
    await writeArtistOrbits(store, [SEED_O1, SEED_O2], [], 'owner', 'Seed');
    const preview = await previewArtistOrbitsCsv(store, csvOf('o1,,,Bonobo; Caribou,,', 'o3,,,Jungle; Kelela,,'));
    assert.deepEqual(preview, { added: 1, removed: 1, changed: 0, unchanged: 1, errors: [] });
    const relabelled = await previewArtistOrbitsCsv(store, csvOf('o1,Warm,,Bonobo; Caribou,,'));
    assert.deepEqual(relabelled, { added: 0, removed: 1, changed: 1, unchanged: 0, errors: [] });
  });
});

test('apply writes the file as one owner change, undoable', async () => {
  await withStore(async (store) => {
    await writeArtistOrbits(store, [SEED_O1, SEED_O2], [], 'owner', 'Seed');
    const result = await applyArtistOrbitsCsv(store, csvOf('o1,Warm,,Bonobo; Caribou,,'));
    assert.equal(result.preview.removed, 1);
    assert.ok(result.change);
    assert.equal(result.change.actor, 'owner');
    assert.equal(result.change.reason, 'Orbits spreadsheet');
    assert.deepEqual(
      (await store.listArtistOrbits()).map((o) => [o.id, o.workingLabel ?? null]),
      [['o1', 'Warm']],
    );

    await store.undoOrbitChange(result.change.id, 'owner');
    assert.deepEqual(
      (await store.listArtistOrbits()).map((o) => o.id),
      ['o1', 'o2'],
    );
    assert.equal((await store.listArtistOrbits()).find((o) => o.id === 'o1')?.workingLabel, undefined);
  });
});

test('apply with nothing to change writes nothing', async () => {
  await withStore(async (store) => {
    await writeArtistOrbits(store, [SEED_O1], [], 'owner', 'Seed');
    const result = await applyArtistOrbitsCsv(store, csvOf('o1,,,Bonobo; Caribou,,'));
    assert.equal(result.change, null);
    assert.equal((await store.listOrbitChanges({ limit: 10 })).length, 1);
  });
});

test('members are refused on download, preview and apply, and the store does not change', async () => {
  await withStore(async (store) => {
    await writeArtistOrbits(store, [SEED_O1], [], 'owner', 'Seed');
    await withApps(store, async (_owner, member) => {
      const csv = csvOf('o1,Warm,,Bonobo; Caribou,,');
      assert.equal((await dispatch(member, { url: '/api/artist-orbits/csv' })).status, 403);
      assert.equal((await dispatch(member, { method: 'POST', url: '/api/artist-orbits/csv/preview', body: { csv } })).status, 403);
      assert.equal((await dispatch(member, { method: 'POST', url: '/api/artist-orbits/csv/apply', body: { csv } })).status, 403);
    });
    const [stored] = await store.listArtistOrbits();
    assert.equal(stored.workingLabel, undefined);
    assert.equal((await store.listOrbitChanges({ limit: 10 })).length, 1);
  });
});

test('download round-trips: the downloaded file previews as unchanged', async () => {
  await withStore(async (store) => {
    await writeArtistOrbits(
      store,
      [
        { ...SEED_O1, workingLabel: 'Warm', parentGenreKey: 'house', members: [...SEED_O1.members, { artistKey: 'kelela', centrality: 0.5 }, { artistKey: 'nightmares', centrality: 0.25 }] },
        SEED_O2,
      ],
      [],
      'owner',
      'Seed',
    );
    await withApps(store, async (owner) => {
      const res = await dispatch(owner, { url: '/api/artist-orbits/csv' });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-disposition') ?? '', /artist-orbits-2026-11-27\.csv/);
      const body = res.body;
      assert.match(body, /o1,Warm,House,Bonobo; Caribou,Kelela,Nightmares/);
      const preview = await previewArtistOrbitsCsv(store, body);
      assert.deepEqual(preview, { added: 0, removed: 0, changed: 0, unchanged: 2, errors: [] });
    });
  });
});
