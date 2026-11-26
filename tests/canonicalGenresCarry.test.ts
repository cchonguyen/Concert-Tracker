import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { mergeArtists, renameArtist } from '../src/server/entities/canonicalManage.ts';
import { undoGenreChange } from '../src/server/events/genres.ts';
import type { ArtistGenres } from '../src/server/events/genreTypes.ts';
import type { ArtistIdentity } from '../src/server/lineup/types.ts';

async function openStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ct-genres-carry-'));
  return new FileLineupStore(dir);
}

const artistRow = (key: string, name: string): ArtistIdentity => ({
  key,
  name,
});

const genreRow = (key: string, name: string, source: ArtistGenres['source'], style: string): ArtistGenres => ({
  key,
  name,
  source,
  genres: [{ parent: 'electronic', style, weight: 1 }],
  checkedAt: '2026-11-26T00:00:00Z',
});

test('renameArtist carries shared genres to the new key and logs system:catalog-rename', async () => {
  const store = await openStore();
  await store.upsertArtist(artistRow('dj alpha', 'DJ Alpha'));
  await store.writeArtistGenres(
    [
      { key: 'dj alpha', source: 'owner', row: genreRow('dj alpha', 'DJ Alpha', 'owner', 'house') },
      { key: 'dj alpha', source: 'music-story', row: genreRow('dj alpha', 'DJ Alpha', 'music-story', 'deep house') },
    ],
    { actor: 'owner', reason: 'Seed' },
  );

  await renameArtist(store, 'dj alpha', 'DJ Alpha (UK)', '2026-11-26T01:00:00Z');

  const rows = await store.listArtistGenres();
  assert.equal(rows.some((r) => r.key === 'dj alpha'), false);
  const moved = rows.filter((r) => r.key === 'dj alpha uk').sort((a, b) => a.source.localeCompare(b.source));
  assert.equal(moved.length, 2);
  assert.equal(moved[0].name, 'DJ Alpha (UK)');
  assert.equal(moved[0].source, 'music-story');
  assert.equal(moved[1].source, 'owner');

  const changes = await store.listGenreChanges({ key: 'dj alpha uk' });
  assert.equal(changes.length, 2);
  assert.ok(changes.every((c) => c.actor === 'system:catalog-rename' && c.reason === 'Artist renamed'));
});

test('mergeArtists keeps target rows and moves source rows only where target has none', async () => {
  const store = await openStore();
  await store.ensureArtists([artistRow('four tet', 'Four Tet'), artistRow('4tet', '4tet')]);
  await store.writeArtistGenres(
    [
      { key: '4tet', source: 'owner', row: genreRow('4tet', '4tet', 'owner', 'uk garage') },
      { key: '4tet', source: 'musicbrainz', row: genreRow('4tet', '4tet', 'musicbrainz', 'idm') },
      { key: 'four tet', source: 'owner', row: genreRow('four tet', 'Four Tet', 'owner', 'electronic') },
    ],
    { actor: 'owner', reason: 'Seed' },
  );

  await mergeArtists(store, '4tet', 'four tet', '2026-11-26T02:00:00Z');

  const rows = await store.listArtistGenres();
  assert.equal(rows.some((r) => r.key === '4tet'), false);
  const targetOwner = rows.find((r) => r.key === 'four tet' && r.source === 'owner');
  const targetMb = rows.find((r) => r.key === 'four tet' && r.source === 'musicbrainz');
  assert.equal(targetOwner?.genres[0].style, 'electronic');
  assert.equal(targetMb?.genres[0].style, 'idm');
  assert.equal(targetMb?.name, 'Four Tet');

  const mergeChanges = (await store.listGenreChanges({})).filter((c) => c.actor === 'system:catalog-merge');
  assert.equal(mergeChanges.length, 3); // delete 4tet owner, delete 4tet musicbrainz, insert four tet musicbrainz
  assert.ok(mergeChanges.every((c) => c.reason === 'Artist merged'));

  // Carried change on the target is undoable via undoGenreChange.
  const { restored } = await undoGenreChange(store, 'four tet', new Date('2026-11-26T03:00:00Z'));
  assert.equal(restored, null);
  const afterUndo = await store.listArtistGenres();
  assert.equal(afterUndo.some((r) => r.key === 'four tet' && r.source === 'musicbrainz'), false);
  assert.equal(afterUndo.find((r) => r.key === 'four tet' && r.source === 'owner')?.genres[0].style, 'electronic');
});

test('renameArtist with no genre rows writes no genre change', async () => {
  const store = await openStore();
  await store.upsertArtist(artistRow('no genres', 'No Genres'));

  await renameArtist(store, 'no genres', 'No Genres Renamed', '2026-11-26T04:00:00Z');

  const changes = await store.listGenreChanges({});
  assert.equal(changes.length, 0);
});
