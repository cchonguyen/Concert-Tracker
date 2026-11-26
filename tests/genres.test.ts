import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LoggedEvent, SeenAct } from '../src/server/events/types.ts';
import {
  GENRE_MAP_SETTING,
  importMusicStory,
  mapTags,
  matchMusicStory,
  musicBrainzGenres,
  readMusicStory,
  knownGenres,
  setOwnGenres,
} from '../src/server/events/genres.ts';
import { genreMix, genresByArtist, missingGenreKeys, topStyles } from '../src/services/genres.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import type { GenreSource } from '../src/server/events/genreTypes.ts';
import { fakeFetcher } from './fakes.ts';

const ev = (id: string, seen: SeenAct[]): LoggedEvent => ({
  id,
  input: id,
  name: id,
  sources: {},
  details: { status: 'resolved', candidates: [], notes: [] },
  seen,
  daysAttended: [],
  companions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});
const act = (name: string, key = name.toLowerCase()): SeenAct => ({ key, name, from: 'you' });

const map = [
  { tag: 'house', style: 'house', parent: 'electronic' },
  { tag: 'deep house', style: 'deep house', parent: 'electronic' },
  { tag: 'indie rock', style: 'indie rock', parent: 'rock' },
  { tag: 'techno', style: 'techno', parent: 'electronic' },
];
const file = {
  format: 'music-story/artist-genres',
  version: 1,
  generated_at: '2026-10-27T00:00:00+00:00',
  genre_map: map,
  artists: [
    { name: 'Ólafur Arnalds', artist_norm: 'olafur arnalds', mbid: null, genres: [{ parent: 'classical', style: 'neoclassical', weight: 1 }], inputs: ['lastfm'] },
    { name: 'Odesza', mbid: 'mb-odesza', genres: [{ parent: 'electronic', style: 'house', weight: 0.6 }, { parent: 'electronic', style: 'techno', weight: 0.4 }], inputs: ['lastfm', 'musicbrainz'] },
    { name: 'Never Seen', genres: [{ parent: 'rock', style: 'indie rock', weight: 1 }] },
    { name: 'No Genres', genres: [] },
  ],
};

test('readMusicStory checks the format and skips artists without genres', () => {
  assert.throws(() => readMusicStory({ format: 'other' }), /not a music-story/);
  assert.throws(() => readMusicStory({ ...file, version: 2 }), /version 2/);
  assert.throws(() => readMusicStory({ ...file, genre_map: [] }), /no genre map/);
  const { artists, map: m } = readMusicStory(file);
  assert.equal(m.length, 4);
  assert.deepEqual(artists.map((a) => a.name), ['Ólafur Arnalds', 'Odesza', 'Never Seen']);
  assert.equal(artists[0].mbid, undefined);
});

test('mapTags ignores unmapped tags, drops small shares and renormalises', () => {
  const g = mapTags(
    [
      { name: 'House', count: 6 },
      { name: 'deep house', count: 3 },
      { name: 'techno', count: 1 }, // 10%: dropped
      { name: 'seen live', count: 50 }, // not in the map
    ],
    map,
  );
  assert.deepEqual(g, [
    { parent: 'electronic', style: 'house', weight: 0.6667 },
    { parent: 'electronic', style: 'deep house', weight: 0.3333 },
  ]);
  assert.deepEqual(mapTags([{ name: 'polka', count: 5 }], map), []);
});

test('matchMusicStory matches by MusicBrainz ID, then by name with your renames', () => {
  const { artists } = readMusicStory(file);
  const rows = matchMusicStory(
    artists,
    [
      { key: 'odesza live', name: 'ODESZA (live)', mbid: 'mb-odesza' },
      { key: 'olafur arnalds', name: 'Olafur Arnalds' },
      { key: 'bonobo', name: 'Bonobo' },
    ],
    {},
    '2026-10-27T00:00:00Z',
  );
  assert.deepEqual(rows.map((r) => [r.key, r.genres[0].style]), [
    ['odesza live', 'house'],
    ['olafur arnalds', 'neoclassical'],
  ]);
  // A rename you made in a lineup review links the file's spelling to yours.
  const aliased = matchMusicStory(artists, [{ key: 'olafur', name: 'Olafur' }], { 'olafur arnalds': 'Olafur' }, 'now');
  assert.deepEqual(aliased.map((r) => r.key), ['olafur']);
});

test('importMusicStory keeps the map and only acts you saw', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'genres-')));
  await store.putEvent(ev('e1', [act('Odesza'), act('Bonobo')]));
  const out = await importMusicStory(store, file, new Date('2026-10-27T00:00:00Z'));
  assert.deepEqual(out, { matched: 1, seen: 2, inFile: 3, mapTags: 4 });
  assert.equal((await store.getSetting<unknown[]>(GENRE_MAP_SETTING))?.length, 4);
  assert.deepEqual((await store.listArtistGenres()).map((r) => r.key), ['odesza']);
});

test('musicBrainzGenres needs the map, uses one exact match, stores misses', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'genres-')));
  await store.putEvent(ev('e1', [act('Bonobo'), act('Common Name'), act('Nobody')]));
  const { fetcher, calls } = fakeFetcher({
    'https://musicbrainz.org/ws/2/artist/?query=artist%3A%22Bonobo%22': {
      body: { artists: [{ id: 'mb-bonobo', name: 'Bonobo', score: 100 }] },
    },
    'https://musicbrainz.org/ws/2/artist/?query=artist%3A%22Common%20Name%22': {
      body: { artists: [{ id: 'a', name: 'Common Name', score: 100 }, { id: 'b', name: 'Common Name', score: 99 }] },
    },
    'https://musicbrainz.org/ws/2/artist/?query=artist%3A%22Nobody%22': { body: { artists: [] } },
    'https://musicbrainz.org/ws/2/artist/mb-bonobo?inc=genres': {
      body: { genres: [{ name: 'downtempo', count: 9 }, { name: 'deep house', count: 3 }, { name: 'house', count: 1 }] },
    },
  });
  const now = new Date('2026-10-27T00:00:00Z');
  await assert.rejects(musicBrainzGenres(store, fetcher, ['bonobo'], now), /music-story file first/);
  await store.putSetting(GENRE_MAP_SETTING, map);
  await assert.rejects(musicBrainzGenres(store, fetcher, ['a', 'b', 'c', 'd', 'e', 'f'], now), /At most 5/);
  const rows = await musicBrainzGenres(store, fetcher, ['bonobo', 'common name', 'nobody', 'not seen'], now);
  assert.deepEqual(
    rows.map((r) => [r.key, r.mbid, r.genres.map((g) => `${g.style} ${g.weight}`), r.sourceUrl]),
    [
      // downtempo is not in the map; house is 25% of the mapped tags.
      ['bonobo', 'mb-bonobo', ['deep house 0.75', 'house 0.25'], 'https://musicbrainz.org/artist/mb-bonobo'],
      ['common name', undefined, [], undefined], // two exact matches: ambiguous
      ['nobody', undefined, [], undefined],
    ],
  );
  assert.equal(calls.filter((u) => u.includes('inc=genres')).length, 1);
  assert.equal((await store.listArtistGenres()).length, 3);
});

test('the stored MusicBrainz ID is used without a search', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'genres-')));
  await store.putEvent(ev('e1', [act('Bonobo')]));
  await store.upsertArtist({ key: 'bonobo', name: 'Bonobo', mbid: 'mb-bonobo' });
  await store.putSetting(GENRE_MAP_SETTING, map);
  const { fetcher, calls } = fakeFetcher({
    'https://musicbrainz.org/ws/2/artist/mb-bonobo?inc=genres': { body: { genres: [{ name: 'techno', count: 2 }] } },
  });
  const [row] = await musicBrainzGenres(store, fetcher, ['bonobo'], new Date());
  assert.deepEqual(row.genres, [{ parent: 'electronic', style: 'techno', weight: 1 }]);
  assert.equal(calls.length, 1);
});

const row = (key: string, source: GenreSource, styles: Array<[string, string, number]>) => ({
  key,
  name: key,
  source,
  genres: styles.map(([parent, style, weight]) => ({ parent, style, weight })),
  checkedAt: 'now',
});

test('genresByArtist prefers music-story, then any source with genres', () => {
  const by = genresByArtist([
    row('a', 'musicbrainz', [['rock', 'indie rock', 1]]),
    row('a', 'music-story', [['electronic', 'house', 1]]),
    row('b', 'music-story', []),
    row('b', 'musicbrainz', [['electronic', 'techno', 1]]),
    row('c', 'musicbrainz', []),
  ]);
  assert.deepEqual(topStyles(by.get('a')), ['house']);
  assert.deepEqual(topStyles(by.get('b')), ['techno']);
  assert.deepEqual(topStyles(by.get('c')), []);
  assert.deepEqual(topStyles(by.get('zzz')), []);
});

test('missingGenreKeys lists seen acts not covered or checked', () => {
  const events = [ev('e1', [act('A'), act('B'), act('C')]), ev('e2', [act('A'), act('D')])];
  const rows = [row('a', 'music-story', [['rock', 'rock', 1]]), row('b', 'music-story', []), row('c', 'musicbrainz', [])];
  assert.deepEqual(missingGenreKeys(events, rows), ['b', 'd']);
});

test('genreMix splits each seen set by weight and counts unknown sets apart', () => {
  const events = [ev('e1', [act('A'), act('B'), act('C')]), ev('e2', [act('A')])];
  const by = genresByArtist([
    row('a', 'music-story', [['electronic', 'house', 0.5], ['electronic', 'techno', 0.5]]),
    row('b', 'music-story', [['rock', 'indie rock', 1]]),
  ]);
  const mix = genreMix(events, by);
  assert.equal(mix.sets, 4);
  assert.equal(mix.known, 3);
  assert.deepEqual(mix.parents.map((p) => [p.name, p.sets]), [['electronic', 2], ['rock', 1]]);
  assert.deepEqual(mix.styles.map((p) => [p.name, p.sets]), [['house', 1], ['indie rock', 1], ['techno', 1]]);
  assert.equal(mix.parents[0].share, 2 / 3);
});

test('your own genres win, an empty list of yours means none, and missing skips them', () => {
  const by = genresByArtist([
    row('a', 'music-story', [['electronic', 'house', 1]]),
    row('a', 'you', [['electronic', 'techno', 1]]),
    row('b', 'musicbrainz', [['rock', 'indie rock', 1]]),
    row('b', 'you', []),
  ]);
  assert.deepEqual(topStyles(by.get('a')), ['techno']);
  assert.deepEqual(topStyles(by.get('b')), []);
  assert.deepEqual(missingGenreKeys([ev('e', [act('C')])], [row('c', 'you', [])]), []);
});

test('knownGenres lists map styles and stored ones once, by name', () => {
  const k = knownGenres(map, [row('a', 'you', [['footwork', 'footwork', 1], ['electronic', 'House', 1]])]);
  assert.deepEqual(k.map((g) => g.style), ['deep house', 'footwork', 'house', 'indie rock', 'techno']);
});

test('setOwnGenres keeps known spellings and parents, adds new genres, and resets', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'genres-')));
  await store.putEvent(ev('e1', [act('Bonobo')]));
  await store.putSetting(GENRE_MAP_SETTING, map);
  const now = new Date('2026-10-27T00:00:00Z');
  await assert.rejects(setOwnGenres(store, 'nobody', ['house'], now), /Only acts you saw/);
  await assert.rejects(setOwnGenres(store, 'bonobo', 'house', now), /styles/);
  await assert.rejects(setOwnGenres(store, 'bonobo', ['x'.repeat(61)], now), /at most 60/);
  const r = await setOwnGenres(store, 'bonobo', ['HOUSE', ' Downtempo  vibes ', 'house', ''], now);
  assert.deepEqual(r?.genres, [
    { style: 'house', parent: 'electronic', weight: 0.5 },
    { style: 'Downtempo vibes', parent: 'Downtempo vibes', weight: 0.5 },
  ]);
  // A genre you made up is offered from then on.
  const rows = await store.listArtistGenres();
  assert.ok(knownGenres(map, rows).some((g) => g.style === 'Downtempo vibes'));
  assert.deepEqual((await setOwnGenres(store, 'bonobo', [], now))?.genres, []);
  assert.equal(await setOwnGenres(store, 'bonobo', undefined, now, true), null);
  assert.deepEqual(await store.listArtistGenres(), []);
});

test('setOwnGenres allows setting genres for an artist entity from Manage', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'genres-')));
  await store.putEntities([
    {
      id: 'artist-caribou',
      kind: 'artist',
      name: 'Caribou',
      nameNormalized: 'caribou',
      attrs: {},
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ]);
  await store.putSetting(GENRE_MAP_SETTING, map);
  const now = new Date('2026-10-27T00:00:00Z');
  const r = await setOwnGenres(store, 'caribou', ['house'], now);
  assert.equal(r?.name, 'Caribou');
  assert.deepEqual(r?.genres, [{ style: 'house', parent: 'electronic', weight: 1 }]);

  // musicBrainzGenres also works for artist entity
  const { fetcher } = fakeFetcher({
    'https://musicbrainz.org/ws/2/artist/?query=artist%3A%22Caribou%22&fmt=json&limit=5': {
      body: { artists: [{ id: 'mb-caribou', name: 'Caribou', score: 100 }] },
    },
    'https://musicbrainz.org/ws/2/artist/mb-caribou?inc=genres&fmt=json': { body: { genres: [{ name: 'techno', count: 1 }] } },
  });
  const mbRows = await musicBrainzGenres(store, fetcher, ['caribou'], now);
  assert.equal(mbRows.length, 1);
  assert.equal(mbRows[0].name, 'Caribou');
  assert.deepEqual(mbRows[0].genres, [{ parent: 'electronic', style: 'techno', weight: 1 }]);
});

test('owner genres win over legacy you and every other source; missing treats owner as done', () => {
  const by = genresByArtist([
    row('a', 'you', [['electronic', 'techno', 1]]),
    row('a', 'owner', [['rock', 'indie rock', 1]]),
    row('a', 'music-story', [['electronic', 'house', 1]]),
    row('b', 'music-story', [['electronic', 'house', 1]]),
    row('b', 'owner', []),
    row('c', 'musicbrainz', [['rock', 'indie rock', 1]]),
    row('c', 'you', [['electronic', 'techno', 1]]),
  ]);
  assert.deepEqual(topStyles(by.get('a')), ['indie rock']);
  assert.equal(by.get('a')?.source, 'owner');
  assert.deepEqual(topStyles(by.get('b')), []);
  assert.deepEqual(topStyles(by.get('c')), ['techno']);
  assert.deepEqual(missingGenreKeys([ev('e', [act('C'), act('D')])], [row('c', 'owner', []), row('d', 'added', [['rock', 'rock', 1]])]), ['d']);
});

test('a member\'s additions go after the shared base, deduped, with scaled weights', () => {
  const by = genresByArtist([
    row('a', 'music-story', [['rock', 'rock', 0.7], ['pop', 'pop', 0.3]]),
    row('a', 'added', [['rock', ' ROCK ', 0.5], ['jazz', 'jazz', 0.5]]),
    row('b', 'added', [['jazz', 'jazz', 1], ['soul', 'soul', 1]]),
    row('c', 'musicbrainz', []),
    row('c', 'added', [['jazz', 'jazz', 1]]),
    row('d', 'owner', [['rock', 'rock', 1]]),
    row('d', 'added', []),
    row('e', 'owner', [['rock', 'rock', 1]]),
    row('e', 'added', [['rock', 'Rock', 1]]),
  ]);
  const a = by.get('a')!;
  assert.equal(a.source, 'music-story');
  assert.deepEqual(a.added, ['jazz']);
  assert.deepEqual(a.genres.map((g) => g.style), ['rock', 'pop', 'jazz']);
  assert.deepEqual(a.genres.map((g) => Math.round(g.weight * 1000) / 1000), [0.467, 0.2, 0.333]);
  const b = by.get('b')!;
  assert.equal(b.source, 'added');
  assert.deepEqual(b.genres.map((g) => [g.style, g.weight]), [['jazz', 0.5], ['soul', 0.5]]);
  const c = by.get('c')!;
  assert.equal(c.source, 'added');
  assert.deepEqual(c.genres.map((g) => [g.style, g.weight]), [['jazz', 1]]);
  assert.deepEqual(by.get('d')?.genres.map((g) => [g.style, g.weight]), [['rock', 1]]);
  assert.equal(by.get('d')?.added, undefined);
  assert.equal(by.get('e')?.added, undefined);

  const mix = genreMix([ev('e1', [act('A'), act('B')])], by);
  assert.equal(mix.known, 2);
  const styles = Object.fromEntries(mix.styles.map((s) => [s.name, Math.round(s.sets * 1000) / 1000]));
  assert.deepEqual(styles, { jazz: 0.833, soul: 0.5, rock: 0.467, pop: 0.2 });
});
