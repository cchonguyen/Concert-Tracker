import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { ManageError } from '../src/server/entities/manage.ts';
import { GENRE_MAP_SETTING } from '../src/server/events/genreTypes.ts';
import type { ArtistGenres, GenreMapEntry } from '../src/server/events/genreTypes.ts';
import {
  addGenreAlias,
  addGenreUmbrella,
  createGenre,
  GENRES_CHANGED_SINCE,
  mergeGenres,
  pickGenreSpelling,
  planGenreMerge,
  removeGenreAlias,
  removeGenreUmbrella,
  renameGenre,
  setGenreParent,
  undoGenreVocabChange,
} from '../src/server/events/genreVocabularyManage.ts';

const MAP: GenreMapEntry[] = [
  { tag: 'house', style: 'house', parent: 'electronic' },
  { tag: 'tech house', style: 'tech house', parent: 'electronic' },
  { tag: 'rock', style: 'rock', parent: 'rock' },
];

const row = (key: string, styles: string[], source: ArtistGenres['source'] = 'music-story'): ArtistGenres => ({
  key,
  name: key,
  source,
  genres: styles.map((style) => ({ parent: 'electronic', style, weight: 1 / styles.length })),
  checkedAt: '2026-11-26T00:00:00Z',
});

async function setup(rows: ArtistGenres[] = []) {
  const s = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'genre-manage-')));
  await s.putSetting(GENRE_MAP_SETTING, MAP);
  if (rows.length) await s.putArtistGenres(rows);
  return s;
}

const refused = (message: string | RegExp, status?: number) => (e: unknown) => {
  assert.ok(e instanceof ManageError, String(e));
  if (typeof message === 'string') assert.equal(e.message, message);
  else assert.match(e.message, message);
  if (status !== undefined) assert.equal(e.status, status);
  return true;
};

const genreOf = async (s: FileLineupStore, key: string) => (await s.getGenreVocabulary()).genres.find((g) => g.key === key);

test('createGenre writes one owner change and refuses an existing genre or a bad group', async () => {
  const s = await setup();
  const change = await createGenre(s, { name: 'Melodic Bass', parent: 'electronic' });
  assert.equal(change.actor, 'owner');
  assert.equal(change.operation, 'create');
  assert.equal(change.summary, 'Melodic Bass created');
  assert.deepEqual(await genreOf(s, 'melodicbass'), { key: 'melodicbass', name: 'Melodic Bass', parent: 'electronic', aliases: [], umbrellas: [] });
  await assert.rejects(createGenre(s, { name: 'melodic-bass' }), refused('That is already a genre: Melodic Bass.', 409));
  await assert.rejects(createGenre(s, { name: 'House' }), refused(/already a genre: house/, 409));
  await assert.rejects(createGenre(s, { name: 'x', parent: 'jazz' }), refused("Pick one of the genre map's groups.", 400));
  await assert.rejects(createGenre(s, { name: '---' }), refused('A genre needs a letter or a number.', 400));
  assert.equal((await s.listGenreVocabChanges({})).length, 1);
});

test('renameGenre keeps the old spelling as an alias and moves the genres under it', async () => {
  const s = await setup([row('a1', ['Electro-House'])]);
  await createGenre(s, { name: 'electro' });
  await addGenreUmbrella(s, 'tech house', 'electro');
  const change = await renameGenre(s, 'electro', 'Electronica');
  assert.equal(change.operation, 'rename');
  assert.equal(change.summary, 'electro renamed to Electronica');
  assert.equal(await genreOf(s, 'electro'), undefined);
  assert.deepEqual((await genreOf(s, 'electronica'))?.aliases, [{ key: 'electro', alias: 'electro' }]);
  assert.deepEqual((await genreOf(s, 'techhouse'))?.umbrellas, ['electronica']);
  await assert.rejects(renameGenre(s, 'electronica', 'House'), refused('That is already a genre: house. Merge instead.', 409));
  // Stored artist genres are never rewritten.
  assert.deepEqual((await s.listArtistGenres())[0].genres.map((g) => g.style), ['Electro-House']);
});

test('a rename to the same letters changes only the spelling', async () => {
  const s = await setup();
  const change = await renameGenre(s, 'house', 'House');
  assert.deepEqual(change.after, [{ key: 'house', name: 'House', aliases: [], umbrellas: [] }]);
});

test('addGenreAlias and removeGenreAlias, with Merge instead for a genre', async () => {
  const s = await setup([row('a1', ['dnb'])]);
  await createGenre(s, { name: 'drum and bass' });
  await assert.rejects(addGenreAlias(s, 'drum and bass', 'House'), refused('That is already a genre: house. Merge instead.', 409));
  await assert.rejects(addGenreAlias(s, 'drum and bass', 'DNB'), refused('That is already a genre: dnb. Merge instead.', 409));
  const add = await addGenreAlias(s, 'drum and bass', 'D&B');
  assert.equal(add.operation, 'alias-add');
  assert.deepEqual((await genreOf(s, 'drumandbass'))?.aliases, [{ key: 'db', alias: 'D&B' }]);
  await assert.rejects(addGenreAlias(s, 'house', 'd b'), refused('That is already a genre: drum and bass. Merge instead.', 409));
  await assert.rejects(addGenreAlias(s, 'drum and bass', 'Drum-and-Bass'), /same letters/);
  await assert.rejects(removeGenreAlias(s, 'drum and bass', 'house'), refused(/Merge instead/, 409));
  await assert.rejects(removeGenreAlias(s, 'drum and bass', 'jungle'), refused(/not a spelling/, 404));
  const rm = await removeGenreAlias(s, 'D&B', 'd&b');
  assert.equal(rm.operation, 'alias-remove');
  assert.deepEqual((await genreOf(s, 'drumandbass'))?.aliases, []);
});

test('setGenreParent sets and clears the owner group', async () => {
  const s = await setup();
  await setGenreParent(s, 'house', 'rock');
  assert.equal((await genreOf(s, 'house'))?.parent, 'rock');
  const clear = await setGenreParent(s, 'house', null);
  assert.equal(clear.summary, 'house group set back to the genre map');
  assert.equal((await genreOf(s, 'house'))?.parent, undefined);
  await assert.rejects(setGenreParent(s, 'house', 'jazz'), refused("Pick one of the genre map's groups.", 400));
});

test('umbrellas: add creates the umbrella row, a loop is refused, remove takes it out', async () => {
  const s = await setup();
  const add = await addGenreUmbrella(s, 'tech house', 'house');
  assert.equal(add.operation, 'umbrella-add');
  assert.deepEqual((await genreOf(s, 'techhouse'))?.umbrellas, ['house']);
  assert.ok(await genreOf(s, 'house'));
  await assert.rejects(addGenreUmbrella(s, 'house', 'tech house'), refused('That would put house under itself.', 400));
  await assert.rejects(addGenreUmbrella(s, 'house', 'house'), refused('That would put house under itself.', 400));
  await removeGenreUmbrella(s, 'tech house', 'house');
  assert.deepEqual((await genreOf(s, 'techhouse'))?.umbrellas, []);
  await assert.rejects(removeGenreUmbrella(s, 'tech house', 'house'), refused(/not under/, 404));
});

test('pickGenreSpelling saves the chosen spelling for a collision', async () => {
  const s = await setup([row('a1', ['Tech-House']), row('a2', ['TECH HOUSE'])]);
  const change = await pickGenreSpelling(s, 'techhouse', 'Tech House');
  assert.equal(change.operation, 'spelling');
  assert.equal((await genreOf(s, 'techhouse'))?.name, 'Tech House');
  await assert.rejects(pickGenreSpelling(s, 'techhouse', 'House'), refused(/not a spelling/, 400));
});

test('planGenreMerge previews artists, aliases and moved and dropped links; mergeGenres writes once', async () => {
  const s = await setup([
    row('a1', ['electro-house']),
    row('a2', ['Electro House', 'house']),
    row('a3', ['house']),
    row('m1', ['electro house'], 'added'),
  ]);
  await createGenre(s, { name: 'electro' });
  await createGenre(s, { name: 'dance' });
  await addGenreAlias(s, 'electro house', 'electrohaus');
  await addGenreUmbrella(s, 'electro house', 'house'); // would point at itself after the merge
  await addGenreUmbrella(s, 'electro house', 'dance'); // moves to house
  await addGenreUmbrella(s, 'electro', 'electro house'); // moves under house
  const before = (await s.listGenreVocabChanges({})).length;

  const plan = await planGenreMerge(s, 'Electro-House', 'house');
  assert.equal(plan.artists, 2);
  assert.deepEqual(plan.aliases.sort(), ['Electro House', 'electrohaus']);
  assert.deepEqual(plan.umbrellasMoved.map((l) => `${l.genre}>${l.umbrella}`).sort(), ['electro>house', 'house>dance']);
  assert.deepEqual(plan.umbrellasDropped.map((l) => `${l.genre}>${l.umbrella}`), ['Electro House>house']);
  assert.equal((await s.listGenreVocabChanges({})).length, before, 'a preview writes nothing');

  const { change } = await mergeGenres(s, 'Electro-House', 'house');
  assert.equal(change.operation, 'merge');
  assert.equal(change.summary, 'Electro House merged into house');
  assert.equal((await s.listGenreVocabChanges({})).length, before + 1);
  assert.equal(await genreOf(s, 'electrohouse'), undefined);
  const house = await genreOf(s, 'house');
  assert.deepEqual(house?.aliases.map((a) => a.key).sort(), ['electrohaus', 'electrohouse']);
  assert.deepEqual(house?.umbrellas, ['dance']);
  assert.deepEqual((await genreOf(s, 'electro'))?.umbrellas, ['house']);
  await assert.rejects(planGenreMerge(s, 'house', 'House'), refused('Cannot merge a genre into itself.', 400));
  // Stored artist genres are never rewritten.
  assert.deepEqual((await s.listArtistGenres()).find((r) => r.key === 'a1')?.genres.map((g) => g.style), ['electro-house']);
});

test('undoGenreVocabChange restores the before images and marks the change undone', async () => {
  const s = await setup([row('a1', ['electro house'])]);
  await createGenre(s, { name: 'dance' });
  await addGenreUmbrella(s, 'electro house', 'dance');
  const { change } = await mergeGenres(s, 'electro house', 'house');
  const undo = await undoGenreVocabChange(s, change.id, new Date('2026-11-26T12:00:00Z'));
  assert.equal(undo.operation, 'undo');
  assert.equal(undo.actor, 'owner');
  assert.deepEqual((await genreOf(s, 'electrohouse'))?.umbrellas, ['dance']);
  assert.equal(await genreOf(s, 'house'), undefined);
  const logged = (await s.listGenreVocabChanges({ id: change.id }))[0];
  assert.equal(logged.undoneAt, '2026-11-26T12:00:00.000Z');
  await assert.rejects(undoGenreVocabChange(s, change.id), refused('That change was already undone.', 409));
  await assert.rejects(undoGenreVocabChange(s, 'nope'), refused('No such genre change.', 404));
});

test('undo is refused when a touched genre changed after the change', async () => {
  const s = await setup();
  const first = await createGenre(s, { name: 'dance' });
  await setGenreParent(s, 'dance', 'electronic');
  await assert.rejects(undoGenreVocabChange(s, first.id), refused(GENRES_CHANGED_SINCE, 409));
  assert.ok(await genreOf(s, 'dance'));
});

test('undo of a create is refused when a later change put another genre under it', async () => {
  const s = await setup();
  const first = await createGenre(s, { name: 'dance' });
  await addGenreUmbrella(s, 'house', 'dance');
  await assert.rejects(undoGenreVocabChange(s, first.id), refused(GENRES_CHANGED_SINCE, 409));
});
