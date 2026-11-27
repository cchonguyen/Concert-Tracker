import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { ManageError } from '../src/server/entities/manage.ts';
import { GENRE_MAP_SETTING } from '../src/server/events/genreTypes.ts';
import type { ArtistGenres, GenreMapEntry, VocabGenre } from '../src/server/events/genreTypes.ts';
import {
  addGenreAlias,
  addGenreRelation,
  addGenreUmbrella,
  createGenre,
  GENRES_CHANGED_SINCE,
  mergeGenres,
  pickGenreSpelling,
  planGenreMerge,
  removeGenreAlias,
  removeGenreRelation,
  removeGenreUmbrella,
  renameGenre,
  setGenreFamily,
  setGenreParent,
  setGenreRelationWeight,
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
  assert.deepEqual(change.after, [{ key: 'house', name: 'House', level: 'genre', relations: [], aliases: [], umbrellas: [] }]);
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

// ---- Taxonomy (genre-taxonomy-phase-a.md section 6) --------------------------

// One macro, two families, and four genres: house (in House), techhouse (no family),
// techno (no family). Written as full images, the way the tree upload writes them.
async function seedTaxonomy(s: FileLineupStore) {
  const g = (x: VocabGenre) => ({ key: x.key, image: x });
  await s.writeGenreVocabulary(
    [
      g({ key: 'macro:electronic', name: 'Electronic', level: 'macro', aliases: [], umbrellas: [] }),
      g({ key: 'family:house', name: 'House', level: 'family', primaryParent: 'macro:electronic', aliases: [], umbrellas: [] }),
      g({ key: 'family:techno', name: 'Techno', level: 'family', primaryParent: 'macro:electronic', aliases: [], umbrellas: [] }),
      g({ key: 'house', name: 'House', level: 'genre', primaryParent: 'family:house', tier: 'specific', aliases: [], umbrellas: [] }),
      g({ key: 'techhouse', name: 'Tech house', level: 'genre', tier: 'specific', aliases: [], umbrellas: [] }),
      g({ key: 'techno', name: 'Techno', level: 'genre', tier: 'specific', aliases: [], umbrellas: [] }),
    ],
    { operation: 'taxonomy-import', actor: 'owner', reason: 'test', summary: 'test taxonomy' },
  );
}

async function vocabOf(s: FileLineupStore, key: string): Promise<VocabGenre> {
  const g = (await s.getGenreVocabulary()).genres.find((x) => x.key === key);
  assert.ok(g, `no row ${key}`);
  return g;
}

test('setGenreFamily puts a genre in a family, clears it, and refuses a macro or an unknown family', async () => {
  const s = await setup();
  await seedTaxonomy(s);
  const change = await setGenreFamily(s, 'techhouse', 'Techno');
  assert.equal(change.operation, 'family');
  assert.equal((await vocabOf(s, 'techhouse')).primaryParent, 'family:techno');
  await setGenreFamily(s, 'techhouse', '');
  assert.equal((await vocabOf(s, 'techhouse')).primaryParent, undefined);
  await assert.rejects(setGenreFamily(s, 'techhouse', ''), refused(/not grouped already/, 400));
  await assert.rejects(setGenreFamily(s, 'techhouse', 'macro:electronic'), refused(/is not a family/, 400));
  await assert.rejects(setGenreFamily(s, 'techhouse', 'Nowhere'), refused(/No such family/, 404));
});

test('addGenreRelation adds adjacent, derived-from and secondary family links as curated', async () => {
  const s = await setup();
  await seedTaxonomy(s);
  const a = await addGenreRelation(s, 'house', 'techhouse', 'adjacent', 0.6);
  assert.equal(a.operation, 'relation-add');
  assert.deepEqual((await vocabOf(s, 'house')).relations, [{ target: 'techhouse', type: 'adjacent', weight: 0.6, origin: 'curated' }]);
  await addGenreRelation(s, 'techno', 'house', 'derived_from');
  assert.deepEqual((await vocabOf(s, 'techno')).relations, [{ target: 'house', type: 'derived_from', weight: 1, origin: 'curated' }]);
  await addGenreRelation(s, 'house', 'Techno', 'secondary_parent');
  assert.deepEqual((await vocabOf(s, 'house')).relations?.find((r) => r.type === 'secondary_parent'), {
    target: 'family:techno',
    type: 'secondary_parent',
    weight: 1,
    origin: 'curated',
  });
});

test('addGenreRelation refuses a reversed adjacent pair, a self link, a derived-from loop, a bad weight and a wrong target', async () => {
  const s = await setup();
  await seedTaxonomy(s);
  await addGenreRelation(s, 'techhouse', 'house', 'adjacent');
  await assert.rejects(addGenreRelation(s, 'house', 'techhouse', 'adjacent'), refused(/adjacent pair is stored once/, 409));
  await assert.rejects(addGenreRelation(s, 'house', 'house', 'adjacent'), refused(/cannot link to itself/, 400));
  await addGenreRelation(s, 'techno', 'house', 'derived_from');
  await assert.rejects(addGenreRelation(s, 'house', 'techno', 'derived_from'), refused(/under itself/, 400));
  for (const w of [0, 1.5, -0.2, 'x']) {
    await assert.rejects(addGenreRelation(s, 'techno', 'techhouse', 'adjacent', w), refused(/above 0 and up to 1/, 400));
  }
  await assert.rejects(addGenreRelation(s, 'house', 'family:techno', 'adjacent'), refused(/No such genre/, 404));
  await assert.rejects(addGenreRelation(s, 'house', 'rock', 'secondary_parent'), refused(/No such family/, 404));
});

test('removeGenreRelation takes a link out; setGenreRelationWeight changes it and makes it curated', async () => {
  const s = await setup();
  await seedTaxonomy(s);
  // A co-occurrence link written by the shared-data job, not the owner.
  await s.writeGenreVocabulary(
    [{ key: 'house', image: { ...(await vocabOf(s, 'house')), level: 'genre', relations: [{ target: 'techhouse', type: 'adjacent', weight: 0.4, origin: 'artist_cooccur' }] } }],
    { operation: 'relations-import', actor: 'owner', reason: 'test', summary: 'test link' },
  );
  const w = await setGenreRelationWeight(s, 'house', 'techhouse', 'adjacent', 0.8);
  assert.equal(w.operation, 'relation-weight');
  assert.deepEqual((await vocabOf(s, 'house')).relations, [{ target: 'techhouse', type: 'adjacent', weight: 0.8, origin: 'curated' }]);
  await assert.rejects(setGenreRelationWeight(s, 'house', 'techhouse', 'adjacent', 0.8), refused(/already its strength/, 400));
  const r = await removeGenreRelation(s, 'house', 'techhouse', 'adjacent');
  assert.equal(r.operation, 'relation-remove');
  assert.deepEqual((await vocabOf(s, 'house')).relations ?? [], []);
  await assert.rejects(removeGenreRelation(s, 'house', 'techhouse', 'adjacent'), refused(/no link/, 404));
});

test('renameGenre renames a family, moves the genres under it, and keeps no alias', async () => {
  const s = await setup();
  await seedTaxonomy(s);
  const c = await renameGenre(s, 'family:house', 'Dance house');
  assert.equal(c.operation, 'rename');
  const vocab = await s.getGenreVocabulary();
  const family = vocab.genres.find((g) => g.key === 'family:dancehouse');
  assert.ok(family);
  assert.equal(family.level, 'family');
  assert.equal(family.primaryParent, 'macro:electronic');
  assert.equal(family.aliases.length, 0);
  assert.ok(!vocab.genres.some((g) => g.key === 'family:house'));
  assert.equal((await vocabOf(s, 'house')).primaryParent, 'family:dancehouse');
});

test('mergeGenres and planGenreMerge refuse a family or a macro', async () => {
  const s = await setup();
  await seedTaxonomy(s);
  const message = "A family or macro can't be merged with a genre.";
  await assert.rejects(mergeGenres(s, 'family:house', 'techhouse'), refused(message, 400));
  await assert.rejects(planGenreMerge(s, 'techhouse', 'macro:electronic'), refused(message, 400));
});

test('a merge moves links from other genres to the kept genre', async () => {
  const s = await setup();
  await seedTaxonomy(s);
  await addGenreRelation(s, 'techno', 'techhouse', 'derived_from', 0.5);
  await mergeGenres(s, 'techhouse', 'house');
  assert.deepEqual((await vocabOf(s, 'techno')).relations, [{ target: 'house', type: 'derived_from', weight: 0.5, origin: 'curated' }]);
});

test('undo of a relation-add restores the earlier links', async () => {
  const s = await setup();
  await seedTaxonomy(s);
  const c = await addGenreRelation(s, 'house', 'techhouse', 'adjacent', 0.5);
  assert.equal((await vocabOf(s, 'house')).relations?.length, 1);
  await undoGenreVocabChange(s, c.id);
  assert.deepEqual((await vocabOf(s, 'house')).relations ?? [], []);
  assert.equal((await vocabOf(s, 'house')).primaryParent, 'family:house');
});

// ---- Phase A loose ends (genre-taxonomy-phase-a.md section 6, Slice 40.6) ----------

test('createGenre with a family sets its primary parent; a blank family is no family', async () => {
  const s = await setup();
  await seedTaxonomy(s);
  const change = await createGenre(s, { name: 'Deep House', family: 'House' });
  assert.equal(change.operation, 'create');
  assert.equal(change.summary, 'Deep House created');
  const deep = await vocabOf(s, 'deephouse');
  assert.equal(deep.level ?? 'genre', 'genre');
  assert.equal(deep.primaryParent, 'family:house');
  await createGenre(s, { name: 'Acid', family: 'family:techno' });
  assert.equal((await vocabOf(s, 'acid')).primaryParent, 'family:techno');
  await createGenre(s, { name: 'Plain', family: '  ' });
  assert.equal((await vocabOf(s, 'plain')).primaryParent, undefined);
});

test('createGenre refuses a family that is not a family row', async () => {
  const s = await setup();
  await seedTaxonomy(s);
  await assert.rejects(createGenre(s, { name: 'X', family: 'techhouse' }), refused('That is not a family: techhouse.', 400));
  await assert.rejects(createGenre(s, { name: 'X', family: 'macro:electronic' }), refused('That is not a family: macro:electronic.', 400));
  await assert.rejects(createGenre(s, { name: 'X', family: 'Electronic' }), refused('That is not a family: Electronic.', 400));
  assert.equal(await genreOf(s, 'x'), undefined);
  assert.equal((await s.listGenreVocabChanges({})).length, 1);
});

test('createGenre without a family is unchanged: a map group still goes on the new genre', async () => {
  const s = await setup();
  const change = await createGenre(s, { name: 'Melodic Bass', parent: 'electronic' });
  assert.equal(change.summary, 'Melodic Bass created');
  assert.deepEqual(await genreOf(s, 'melodicbass'), { key: 'melodicbass', name: 'Melodic Bass', parent: 'electronic', aliases: [], umbrellas: [] });
});

test('undo of a genre change is refused after a later link is added to that genre', async () => {
  const s = await setup();
  await seedTaxonomy(s);
  const first = await addGenreRelation(s, 'techhouse', 'techno', 'adjacent', 0.5);
  await addGenreRelation(s, 'techhouse', 'house', 'adjacent', 0.3);
  await assert.rejects(undoGenreVocabChange(s, first.id), refused(GENRES_CHANGED_SINCE, 409));
  assert.equal((await vocabOf(s, 'techhouse')).relations?.length, 2);
});

test('undo of a genre change still works when no link changed after it', async () => {
  const s = await setup();
  await seedTaxonomy(s);
  const c = await addGenreRelation(s, 'techhouse', 'techno', 'adjacent', 0.5);
  await undoGenreVocabChange(s, c.id);
  assert.deepEqual((await vocabOf(s, 'techhouse')).relations ?? [], []);
});

test('undo of an image written before 0063 (no level) is not blocked by its taxonomy', async () => {
  const s = await setup();
  await seedTaxonomy(s);
  const c = await createGenre(s, { name: 'dance' });
  // A later link on the same genre: the current taxonomy now differs from the 'after' image.
  await addGenreRelation(s, 'dance', 'techhouse', 'adjacent', 0.5);
  const list = s.listGenreVocabChanges.bind(s);
  s.listGenreVocabChanges = async (q) =>
    (await list(q)).map((ch) => ({ ...ch, after: ch.after.map(({ level: _level, ...g }) => g as VocabGenre) }));
  await undoGenreVocabChange(s, c.id);
  assert.equal(await genreOf(s, 'dance'), undefined);
});
