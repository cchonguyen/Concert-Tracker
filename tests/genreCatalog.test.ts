import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoggedEvent } from '../src/server/events/types.ts';
import { genreUniverse } from '../src/server/events/genreCatalog.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';

const OWNER = { userId: 'u0', role: 'owner' as const };
const ANN = { userId: 'u1', role: 'member' as const };

const ev = (id: string, seen: Array<[string, string]>): LoggedEvent => ({
  id,
  input: id,
  name: id,
  sources: {},
  details: { status: 'resolved', candidates: [], notes: [] },
  seen: seen.map(([key, name]) => ({ key, name, from: 'you' as const })),
  daysAttended: [],
  companions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const entity = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'artist' as const,
  name,
  nameNormalized: name.toLowerCase(),
  attrs: {},
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...extra,
});

test('genreUniverse lists the catalog, then every seen act, then owner records, once by key', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'genre-universe-')));
  await store.upsertArtist({ key: 'bonobo', name: 'Bonobo', mbid: 'mb-bonobo' });
  await store.forUser(OWNER).putEvent(ev('e1', [['bonobo', 'bonobo (live)'], ['caribou', 'Caribou']]));
  await store.forUser(ANN).putEvent(ev('e2', [['moon garden', 'Moon Garden'], ['caribou', 'Caribou']]));
  await store.forUser(OWNER).putEntities([
    entity('a1', 'Four Tet'),
    entity('a2', 'Caribou'),
    entity('a3', 'Gone', { mergedIntoId: 'a1' }),
  ]);
  const all = await genreUniverse(store.forUser(OWNER));
  assert.deepEqual(all, [
    { key: 'bonobo', name: 'Bonobo', mbid: 'mb-bonobo' },
    { key: 'caribou', name: 'Caribou' },
    { key: 'moon garden', name: 'Moon Garden' },
    { key: 'four tet', name: 'Four Tet' },
  ]);
});

test('genreUniverse skips vault ciphertext and refuses a member scope', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'genre-universe-')));
  await store.putEvent(ev('e1', [['x', 'v1:QUJD:REVG'], ['zedd', 'Zedd']]));
  assert.deepEqual(await genreUniverse(store), [{ key: 'zedd', name: 'Zedd' }]);
  await assert.rejects(genreUniverse(store.forUser(ANN)), /Only the owner/);
});
