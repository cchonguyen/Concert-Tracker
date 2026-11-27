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
  setOwnerGenres,
  setMemberAdditions,
  undoGenreChange,
} from '../src/server/events/genres.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';
import { genreMix, genresByArtist, hasGenreUnder, missingGenreKeys, topStyles } from '../src/services/genres.ts';
import type { GenreVocabulary } from '../src/server/events/genreTypes.ts';
import { addGenreAlias, createGenre } from '../src/server/events/genreVocabularyManage.ts';
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
  await assert.rejects(setOwnGenres(store, 'nobody', ['house'], now), /Only acts in the catalog/);
  await assert.rejects(setOwnGenres(store, 'bonobo', 'house', now), /styles/);
  await assert.rejects(setOwnGenres(store, 'bonobo', ['x'.repeat(61)], now), /at most 60/);
  const r = await setOwnGenres(store, 'bonobo', ['HOUSE', ' Downtempo  vibes ', 'house', ''], now);
  assert.deepEqual(r?.genres, [
    { style: 'house', parent: 'electronic', weight: 0.5 },
    { style: 'Downtempo vibes', parent: 'Not grouped', weight: 0.5 },
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

const ANN = { userId: 'u1', role: 'member' as const };

test('setOwnerGenres writes the shared owner row, logged, for any act in the universe', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'genres-')));
  await store.forUser(ANN).putEvent(ev('e1', [act('Moon Garden')])); // only a member saw it
  await store.putSetting(GENRE_MAP_SETTING, map);
  const now = new Date('2026-11-26T00:00:00Z');
  const r = await setOwnerGenres(store, 'moon garden', ['house'], now);
  assert.equal(r?.source, 'owner');
  assert.deepEqual((await store.listArtistGenres()).map((g) => `${g.key}:${g.source}`), ['moon garden:owner']);
  assert.deepEqual((await setOwnerGenres(store, 'moon garden', [], now))?.genres, []); // owner says none
  assert.equal(await setOwnerGenres(store, 'moon garden', undefined, now, true), null);
  assert.deepEqual(await store.listArtistGenres(), []);
  const log = await store.listGenreChanges({ key: 'moon garden' });
  assert.deepEqual(log.map((c) => [c.actor, c.reason, c.source]), [
    ['owner', 'Reset to found genres', 'owner'],
    ['owner', 'Set in the app', 'owner'],
    ['owner', 'Set in the app', 'owner'],
  ]);
});

test('a member PUT writes only their added row, within the limits, and reset removes it', async () => {
  const base = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'genres-')));
  const ann = base.forUser(ANN);
  await ann.putEvent(ev('e1', [act('Bonobo')]));
  await base.putSetting(GENRE_MAP_SETTING, map);
  const now = new Date('2026-11-26T00:00:00Z');
  const asAnn = <T>(fn: () => Promise<T>) => runAsMember({ email: 'a@x', ...ANN }, ann, fn);
  await assert.rejects(asAnn(() => setOwnGenres(ann, 'nobody', ['house'], now)), /Only acts you saw/);
  await assert.rejects(setMemberAdditions(ann, 'bonobo', Array.from({ length: 11 }, (_, i) => `g${i}`), now), /At most 10/);
  await assert.rejects(setMemberAdditions(ann, 'bonobo', ['x'.repeat(61)], now), /at most 60/);
  const r = await asAnn(() => setOwnGenres(ann, 'bonobo', ['house', 'jazz'], now));
  assert.equal(r?.source, 'added');
  assert.deepEqual((await ann.listArtistGenres()).map((g) => `${g.key}:${g.source}:${g.genres.map((x) => x.style)}`), ['bonobo:added:house,jazz']);
  assert.deepEqual(await base.listArtistGenres(), []); // nothing shared
  assert.deepEqual(await base.listGenreChanges({}), []); // never logged
  assert.equal(await asAnn(() => setOwnGenres(ann, 'bonobo', undefined, now, true)), null);
  assert.deepEqual(await ann.listArtistGenres(), []);
});

test('music-story and MusicBrainz match the universe and log their system actors', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'genres-')));
  await store.upsertArtist({ key: 'odesza', name: 'Odesza' }); // catalog only, nobody's event
  await store.forUser(ANN).putEvent(ev('e1', [act('Bonobo')]));
  const now = new Date('2026-11-26T00:00:00Z');
  const out = await importMusicStory(store, file, now);
  assert.deepEqual(out, { matched: 1, seen: 2, inFile: 3, mapTags: 4 });
  const { fetcher } = fakeFetcher({
    'https://musicbrainz.org/ws/2/artist/?query=artist%3A%22Bonobo%22': { body: { artists: [{ id: 'mb-bonobo', name: 'Bonobo', score: 100 }] } },
    'https://musicbrainz.org/ws/2/artist/mb-bonobo?inc=genres': { body: { genres: [{ name: 'house', count: 1 }] } },
  });
  await musicBrainzGenres(store, fetcher, ['bonobo'], now);
  const log = await store.listGenreChanges({});
  assert.deepEqual(log.map((c) => [c.key, c.source, c.actor, c.reason, Boolean(c.batchId)]), [
    ['bonobo', 'musicbrainz', 'system:musicbrainz', 'MusicBrainz lookup', false],
    ['odesza', 'music-story', 'system:music-story', 'music-story file upload', true],
  ]);
  await assert.rejects(importMusicStory(store.forUser(ANN), file, now), /Only the owner/);
});

test('undoGenreChange restores the row before the latest change, and refuses when changed since', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'genres-')));
  await store.putEvent(ev('e1', [act('Bonobo')]));
  await store.putSetting(GENRE_MAP_SETTING, map);
  const now = new Date('2026-11-26T00:00:00Z');
  await assert.rejects(undoGenreChange(store, 'bonobo', now), /no change to undo/);
  await setOwnerGenres(store, 'bonobo', ['house'], now);
  await setOwnerGenres(store, 'bonobo', ['techno'], now);
  const owner = async () => (await store.listArtistGenres()).find((r) => r.source === 'owner')?.genres.map((g) => g.style) ?? null;
  await undoGenreChange(store, 'bonobo', now);
  assert.deepEqual(await owner(), ['house']);
  await undoGenreChange(store, 'bonobo', now); // walks back past its own undo
  assert.equal(await owner(), null);
  await assert.rejects(undoGenreChange(store, 'bonobo', now), /no change to undo/);
  const reasons = (await store.listGenreChanges({ key: 'bonobo' })).map((c) => [c.reason, Boolean(c.undoneAt)]);
  assert.deepEqual(reasons, [['Undo', false], ['Undo', false], ['Set in the app', true], ['Set in the app', true]]);

  // Changed since: the latest change is no longer what the row holds.
  await setOwnerGenres(store, 'bonobo', ['house'], now);
  await store.putArtistGenres([{ key: 'bonobo', name: 'Bonobo', source: 'owner', genres: [{ parent: 'rock', style: 'indie rock', weight: 1 }], checkedAt: 'x' }]);
  await assert.rejects(undoGenreChange(store, 'bonobo', now), /Changed since; nothing undone/);
  assert.deepEqual(await owner(), ['indie rock']);
});

test('genresByArtist folds spellings of one genre and adds their weights inside an act', () => {
  const by = genresByArtist([
    row('a', 'music-story', [['electronic', 'electro house', 0.4], ['electronic', 'Electro-House', 0.3], ['electronic', 'techno', 0.3]]),
    row('b', 'musicbrainz', [['electronic', 'electrohouse', 1]]),
    row('c', 'owner', [['made up', 'Électro_House', 0.5], ['made up', 'nu thing', 0.5]]),
    row('d', 'music-story', [['electronic', '!!!', 0.5], ['electronic', 'techno', 0.5]]),
    row('e', 'music-story', [['electronic', 'electro house', 1]]), // the most used spelling is shown
  ]);
  assert.deepEqual(by.get('a')?.genres.map((g) => [g.style, g.parent, Math.round(g.weight * 10) / 10]), [
    ['electro house', 'electronic', 0.7],
    ['techno', 'electronic', 0.3],
  ]);
  assert.deepEqual(topStyles(by.get('b')), ['electro house']);
  // Accents fold; a known genre takes the map's group; an unknown one is "Not grouped".
  assert.deepEqual(by.get('c')?.genres.map((g) => [g.style, g.parent]), [
    ['electro house', 'electronic'],
    ['nu thing', 'Not grouped'],
  ]);
  // A style with no letter or digit is dropped.
  assert.deepEqual(topStyles(by.get('d')), ['techno']);
});

test('genresByArtist uses the genre map when given: its spelling and group win', () => {
  const by = genresByArtist(
    [row('a', 'owner', [['electro house', 'ELECTRO HOUSE', 0.5], ['footwork', 'footwork', 0.5]])],
    undefined,
    [{ tag: 'electro house', style: 'electro house', parent: 'electronic' }],
  );
  assert.deepEqual(by.get('a')?.genres.map((g) => [g.style, g.parent]), [
    ['electro house', 'electronic'],
    ['footwork', 'Not grouped'],
  ]);
});

test('a member\'s additions are deduped by genre key against the shared base', () => {
  const by = genresByArtist([
    row('a', 'music-story', [['electronic', 'electro house', 1]]),
    row('a', 'added', [['x', 'Electro-House', 0.5], ['x', 'electrohouse', 0.5]]),
    row('b', 'music-story', [['electronic', 'techno', 1]]),
    row('b', 'added', [['x', 'electro-house', 1]]),
  ]);
  assert.equal(by.get('a')?.added, undefined);
  assert.deepEqual(topStyles(by.get('a')), ['electro house']);
  assert.deepEqual(by.get('b')?.added, ['electro house']);
});

test('genreMix counts resolved styles as one bar and ungrouped genres as "Not grouped"', () => {
  const by = genresByArtist([
    row('a', 'music-story', [['electronic', 'electro house', 1]]),
    row('b', 'owner', [['electronic', 'Electro-House', 1]]),
    row('c', 'owner', [['nu thing', 'nu thing', 1]]),
  ]);
  const mix = genreMix([ev('e1', [act('A'), act('B'), act('C')])], by);
  assert.deepEqual(mix.styles.map((s) => [s.name, s.sets]), [['electro house', 2], ['nu thing', 1]]);
  assert.deepEqual(mix.parents.map((s) => [s.name, s.sets]), [['electronic', 2], ['Not grouped', 1]]);
});

test('knownGenres lists each genre once by genre key, in the resolved spelling', () => {
  const k = knownGenres(map, [
    row('a', 'owner', [['electronic', 'Deep-House', 0.5], ['x', 'electro house', 0.5]]),
    row('b', 'owner', [['x', 'Electro-House', 1]]),
    row('c', 'owner', [['x', 'electro house', 1]]), // the most used spelling is shown
  ]);
  assert.deepEqual(k.filter((g) => /house/i.test(g.style)).map((g) => [g.style, g.parent]), [
    ['deep house', 'electronic'],
    ['electro house', 'Not grouped'],
    ['house', 'electronic'],
  ]);
});

test('typed genres fold by genre key, store the resolved spelling, and need a letter or digit', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'genres-')));
  await store.putEvent(ev('e1', [act('Bonobo')]));
  await store.putSetting(GENRE_MAP_SETTING, map);
  const now = new Date('2026-11-26T00:00:00Z');
  await assert.rejects(setOwnGenres(store, 'bonobo', ['house', '!!!'], now), /A genre needs a letter or a number/);
  const r = await setOwnGenres(store, 'bonobo', ['Deep-House', 'deephouse', 'deep_house'], now);
  assert.deepEqual(r?.genres, [{ style: 'deep house', parent: 'electronic', weight: 1 }]);
});

// house > tech house, electro house; "bass house" sits under both house and bass.
const umbrellaVocab: GenreVocabulary = {
  genres: [
    { key: 'house', name: 'House', aliases: [], umbrellas: [] },
    { key: 'techhouse', name: 'tech house', aliases: [], umbrellas: ['house'] },
    { key: 'electrohouse', name: 'electro house', aliases: [], umbrellas: ['house'] },
    { key: 'bass', name: 'bass', aliases: [], umbrellas: [] },
    { key: 'basshouse', name: 'bass house', aliases: [], umbrellas: ['house', 'bass', 'techhouse'] },
  ],
};

test('genreMix umbrellas: one act under one umbrella by two genres counts one set, not two', () => {
  const vocab = { genres: umbrellaVocab.genres.slice(0, 3) }; // house, tech house, electro house
  const by = genresByArtist([row('a', 'owner', [['electronic', 'tech house', 0.5], ['electronic', 'electro house', 0.5]])], vocab);
  const mix = genreMix([ev('e1', [act('A')])], by, vocab);
  assert.deepEqual(mix.umbrellas.map((u) => [u.name, u.sets, u.share]), [['House', 1, 1]]);
  assert.equal(mix.styles.length, 2);
});

test('genreMix umbrellas: a genre under two umbrellas counts in both, once each even by two paths', () => {
  const by = genresByArtist(
    [
      // bass house reaches house directly and through tech house: still its weight once.
      row('a', 'owner', [['electronic', 'bass house', 0.5], ['electronic', 'tech house', 0.5]]),
      row('b', 'owner', [['electronic', 'techno', 1]]),
    ],
    umbrellaVocab,
  );
  const mix = genreMix([ev('e1', [act('A'), act('B')])], by, umbrellaVocab);
  assert.deepEqual(
    mix.umbrellas.map((u) => [u.name, u.sets]),
    // tech house is itself an umbrella (of bass house), so it holds both halves.
    [['House', 1], ['tech house', 1], ['bass', 0.5]],
  );
  for (const u of mix.umbrellas) assert.ok(u.sets <= 1);
  assert.equal(mix.known, 2);
});

test('genreMix umbrellas: the umbrella itself counts, and none without a vocabulary', () => {
  const by = genresByArtist([row('a', 'owner', [['electronic', 'house', 1]])]);
  assert.deepEqual(genreMix([ev('e1', [act('A')])], by, umbrellaVocab).umbrellas.map((u) => [u.name, u.sets]), [['House', 1]]);
  assert.deepEqual(genreMix([ev('e1', [act('A')])], by).umbrellas, []);
});

test('hasGenreUnder finds an act by the umbrella or any genre under it, at any depth', () => {
  const by = genresByArtist([
    row('a', 'owner', [['electronic', 'bass house', 1]]),
    row('b', 'owner', [['electronic', 'House', 1]]),
    row('c', 'owner', [['electronic', 'techno', 1]]),
  ]);
  assert.equal(hasGenreUnder(by.get('a'), 'house', umbrellaVocab), true);
  assert.equal(hasGenreUnder(by.get('a'), 'bass', umbrellaVocab), true);
  assert.equal(hasGenreUnder(by.get('b'), 'house', umbrellaVocab), true);
  assert.equal(hasGenreUnder(by.get('c'), 'house', umbrellaVocab), false);
  assert.equal(hasGenreUnder(by.get('a'), 'house', undefined), false);
});

test('genresByArtist builds its map from the rows when the given map is empty', () => {
  const rows = [
    row('a', 'music-story', [['electronic', 'electro house', 1]]),
    row('b', 'owner', [['x', 'Electro-House', 1]]),
  ];
  assert.deepEqual(genresByArtist(rows, undefined, []).get('b')?.genres.map((g) => [g.style, g.parent]), [['electro house', 'electronic']]);
});

test('knownGenres resolves aliases and includes vocabulary genres', () => {
  const vocab: GenreVocabulary = {
    genres: [
      {
        key: 'ukgarage',
        name: 'UK Garage',
        parent: 'Electronic',
        aliases: [{ key: '2step', alias: '2-Step' }],
        umbrellas: [],
      },
      {
        key: 'dubstep',
        name: 'Dubstep',
        parent: 'Electronic',
        aliases: [],
        umbrellas: [],
      },
    ],
  };
  const rows = [row('a', 'owner', [['rock', '2-Step', 1]])];
  const known = knownGenres(map, rows, vocab);
  assert.deepEqual(
    known.filter((g) => g.style === 'UK Garage' || g.style === 'Dubstep' || g.style === '2-Step'),
    [
      { style: 'Dubstep', parent: 'Electronic' },
      { style: 'UK Garage', parent: 'Electronic' },
    ],
  );
});

test('setOwnerGenres resolves an alias typed by the owner to the vocabulary spelling', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'genres-')));
  await store.putEvent(ev('e1', [act('Burial')]));
  await store.putSetting(GENRE_MAP_SETTING, map);
  await createGenre(store, { name: 'UK Garage', parent: 'electronic' });
  await addGenreAlias(store, 'UK Garage', '2-Step');
  const r = await setOwnerGenres(store, 'burial', ['2-Step'], new Date('2026-11-26T00:00:00Z'));
  assert.deepEqual(r?.genres.map((g) => [g.style, g.parent]), [['UK Garage', 'electronic']]);
});
