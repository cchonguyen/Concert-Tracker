import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  parseGenreVocabCsv,
  planGenreTaxonomyCsvImport,
  planGenreVocabCsvImport,
  planGenreVocabUpload,
} from '../src/server/events/genreVocabCsv';
import { applyGenreVocabCsv, previewGenreVocabCsv } from '../src/server/events/genreVocabularyManage';
import { FileLineupStore } from '../src/server/lineup/store/fileStore';
import { parseCsv } from '../src/services/listImport';
import type { VocabGenre } from '../src/server/events/genreTypes';

const withStore = async (fn: (store: FileLineupStore) => Promise<void>) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'genre-vocab-csv-'));
  try {
    await fn(new FileLineupStore(dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

test('parseGenreVocabCsv parses header, groups, and semicolon aliases', () => {
  const parsed = parseGenreVocabCsv([
    ['genre', 'group', 'specificity_tier', 'artists_using_it', 'other_spellings'],
    ['drum and bass', 'electronic', 'subgenre', '12', "d&b; dnb; drum 'n' bass; drum n bass"],
    ['', '', '', '', ''],
    ['trap', 'electronic; hip hop', 'subgenre', '8', ''],
  ]);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].genre, 'drum and bass');
  assert.deepEqual(parsed.rows[0].otherSpellings, ['d&b', 'dnb', "drum 'n' bass", 'drum n bass']);
  assert.equal(parsed.rows[1].group, 'electronic; hip hop');
  assert.equal(parsed.rows[1].tree, undefined);
});

test('parseGenreVocabCsv rejects missing genre column or blank genre cell', () => {
  assert.match(parseGenreVocabCsv([['group'], ['electronic']]).errors[0], /missing the "genre" column/i);
  assert.match(parseGenreVocabCsv([['genre', 'group'], ['', 'electronic']]).errors[0], /Line 2: missing genre name/);
});

test('planGenreVocabCsvImport skips loose-match spellings, deduplicates alias keys, and links multi-group umbrellas', () => {
  const { rows } = parseGenreVocabCsv([
    ['genre', 'group', 'other_spellings'],
    ['electronic', 'electronic', ''],
    ['hip hop', 'hip hop', 'hip-hop'],
    ['alt-country', 'country', 'alt country'],
    ['drum and bass', 'electronic', "d&b; dnb; drum 'n' bass; drum n bass"],
    ['trap', 'electronic; hip hop', ''],
    ['future bass', 'electronic', 'trap'],
  ]);

  const plan = planGenreVocabCsvImport(rows, { genres: [] });
  assert.deepEqual(plan.preview.errors, []);
  assert.equal(plan.preview.created, 6);
  assert.equal(plan.preview.updated, 0);
  assert.equal(plan.preview.umbrellasAdded, 1);

  const byKey = new Map(plan.after.map((r) => [r.key, r.image!]));
  // 'alt country' shares genreKey with 'alt-country', so no alias is added.
  assert.deepEqual(byKey.get('altcountry')?.aliases, []);
  // 'drum 'n' bass' and 'drum n bass' share aliasKey 'drumnbass', so only one is kept.
  assert.deepEqual(
    byKey.get('drumandbass')?.aliases.map((a) => a.key),
    ['db', 'dnb', 'drumnbass'],
  );
  // 'trap' gets primary parent 'electronic' and umbrella 'hiphop'.
  assert.equal(byKey.get('trap')?.parent, 'electronic');
  assert.deepEqual(byKey.get('trap')?.umbrellas, ['hiphop']);
  // 'trap' as an alias on 'future bass' collides with the 'trap' genre.
  assert.equal(plan.preview.skippedAliases.length, 1);
  assert.equal(plan.preview.skippedAliases[0].alias, 'trap');
});

test('applyGenreVocabCsv writes vocabulary and is idempotent on repeat', () =>
  withStore(async (store) => {
    const { rows } = parseGenreVocabCsv([
      ['genre', 'group', 'other_spellings'],
      ['hip hop', 'hip hop', 'hip-hop'],
      ['trap', 'electronic; hip hop', ''],
    ]);
    const preview1 = await previewGenreVocabCsv(store, rows);
    assert.equal(preview1.created, 2);

    const applied1 = await applyGenreVocabCsv(store, rows);
    assert.ok(applied1.change);
    assert.equal(applied1.change.actor, 'owner');

    const vocab = await store.getGenreVocabulary();
    assert.equal(vocab.genres.length, 2);

    const applied2 = await applyGenreVocabCsv(store, rows);
    assert.equal(applied2.change, null);
    assert.equal(applied2.preview.created, 0);
    assert.equal(applied2.preview.updated, 0);
    assert.equal(applied2.preview.unchanged, 2);
  }));

// A small tree: 2 macros, 3 families, 7 genres. 'house' (genre) sits in family 'House' next to
// family:house; 'deep house' has a secondary family; 'big room' has two spellings that fold together;
// 'ambient' has no family.
const TREE_HEADER = ['genre', 'family', 'macro', 'tier', 'secondary_families', 'other_spellings'];
const treeFixture = (): string[][] => [
  TREE_HEADER,
  ['house', 'House', 'Electronic', 'specific', '', 'house music'],
  ['deep house', 'House', 'Electronic', 'specific', 'Techno', 'deep-house; Deep House'],
  ['techno', 'Techno', 'Electronic', 'specific', '', ''],
  ['big room', 'House', 'Electronic', 'specific', '', 'Big Beat; big-beat'],
  ['pop', 'Pop', 'Pop', 'specific', '', ''],
  ['ambient pop', 'Pop', 'Pop', 'umbrella_fallback', 'House', ''],
  ['ambient', '', '', '', '', ''],
];

const imageOf = (rows: Array<{ key: string; image: VocabGenre | null }>, key: string): VocabGenre => {
  const hit = rows.find((r) => r.key === key)?.image;
  assert.ok(hit, `no image for ${key}`);
  return hit;
};

test('parseGenreVocabCsv reads a tree header into the tree columns', () => {
  const parsed = parseGenreVocabCsv(treeFixture());
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows.length, 7);
  assert.deepEqual(parsed.rows[0].tree, { family: 'House', macro: 'Electronic', tier: 'specific', secondaryFamilies: [] });
  assert.deepEqual(parsed.rows[1].tree?.secondaryFamilies, ['Techno']);
  assert.equal(parsed.rows[6].tree?.family, '');
});

test('a tree file plans macro, family and genre images with levels, keeping house and family:house apart', () => {
  const { rows } = parseGenreVocabCsv(treeFixture());
  const plan = planGenreTaxonomyCsvImport(rows, { genres: [] });
  assert.deepEqual(plan.preview.errors, []);

  const after = plan.after;
  assert.equal(after.length, 12);
  assert.deepEqual(
    after.map((r) => r.key).sort(),
    ['ambient', 'ambientpop', 'bigroom', 'deephouse', 'family:house', 'family:pop', 'family:techno', 'house', 'macro:electronic', 'macro:pop', 'pop', 'techno'],
  );

  const house = imageOf(after, 'house');
  assert.equal(house.level, 'genre');
  assert.equal(house.primaryParent, 'family:house');
  assert.deepEqual(house.aliases, [{ key: 'housemusic', alias: 'house music' }]);

  const familyHouse = imageOf(after, 'family:house');
  assert.equal(familyHouse.level, 'family');
  assert.equal(familyHouse.primaryParent, 'macro:electronic');
  assert.equal(familyHouse.name, 'House');

  const macroPop = imageOf(after, 'macro:pop');
  assert.equal(macroPop.level, 'macro');
  assert.equal(macroPop.primaryParent, undefined);

  // The one secondary family becomes a curated secondary_parent link; the rest of the genre is unchanged.
  assert.deepEqual(imageOf(after, 'deephouse').relations, [
    { target: 'family:techno', type: 'secondary_parent', weight: 1, origin: 'curated' },
  ]);
  assert.equal(imageOf(after, 'deephouse').tier, 'specific');
  assert.equal(imageOf(after, 'ambientpop').tier, 'umbrella_fallback');

  // Spellings that fold to the genre's own key are skipped; a folded pair is kept once.
  assert.equal(plan.preview.taxonomy?.aliasesSkipped, 2);
  assert.deepEqual(imageOf(after, 'bigroom').aliases, [{ key: 'bigbeat', alias: 'Big Beat' }]);
  assert.equal(imageOf(after, 'ambient').primaryParent, undefined);
});

test('a tree preview counts created rows, secondary links and genres with no family', () => {
  const { rows } = parseGenreVocabCsv(treeFixture());
  const preview = planGenreTaxonomyCsvImport(rows, { genres: [] }).preview;
  assert.equal(preview.created, 12);
  assert.equal(preview.updated, 0);
  assert.equal(preview.unchanged, 0);
  assert.deepEqual(preview.taxonomy?.macros, { created: 2, updated: 0, unchanged: 0 });
  assert.deepEqual(preview.taxonomy?.families, { created: 3, updated: 0, unchanged: 0 });
  assert.equal(preview.taxonomy?.genres.created, 7);
  assert.equal(preview.taxonomy?.aliasesAdded, 2);
  assert.equal(preview.taxonomy?.secondaryAdded, 2);
  assert.equal(preview.taxonomy?.secondaryRemoved, 0);
  assert.deepEqual(preview.taxonomy?.withoutFamily, { count: 1, names: ['ambient'], checked: 'vocabulary only' });

  const withStored = planGenreTaxonomyCsvImport(rows, { genres: [] }, [{ key: 'drumandbass', name: 'drum and bass' }]);
  assert.equal(withStored.preview.taxonomy?.withoutFamily.count, 2);
  assert.deepEqual(withStored.preview.taxonomy?.withoutFamily.names, ['ambient', 'drum and bass']);
  assert.equal(withStored.preview.taxonomy?.withoutFamily.checked, 'stored and vocabulary');
});

test('re-uploading the same tree file changes nothing', () => {
  const { rows } = parseGenreVocabCsv(treeFixture());
  const first = planGenreTaxonomyCsvImport(rows, { genres: [] });
  const current: { genres: VocabGenre[] } = { genres: first.after.map((r) => r.image!) };
  const second = planGenreVocabUpload(rows, current);
  assert.deepEqual(second.preview.errors, []);
  assert.equal(second.after.length, 0);
  assert.equal(second.preview.created, 0);
  assert.equal(second.preview.updated, 0);
  assert.equal(second.preview.unchanged, 12);
});

test('a tree upload keeps a genre existing adjacent and derived links, and replaces only its secondary families', () => {
  const current = {
    genres: [
      { key: 'techno', name: 'Techno', aliases: [], umbrellas: [] },
      {
        key: 'house',
        name: 'House',
        aliases: [],
        umbrellas: [],
        relations: [
          { target: 'techno', type: 'adjacent' as const, weight: 0.5, origin: 'artist_cooccur' as const },
          { target: 'family:techno', type: 'secondary_parent' as const, weight: 1, origin: 'curated' as const },
        ],
      },
    ],
  };
  const { rows } = parseGenreVocabCsv(treeFixture());
  const plan = planGenreTaxonomyCsvImport(rows, current);
  assert.deepEqual(plan.preview.errors, []);
  assert.deepEqual(imageOf(plan.after, 'house').relations, [
    { target: 'techno', type: 'adjacent', weight: 0.5, origin: 'artist_cooccur' },
  ]);
  assert.equal(plan.preview.taxonomy?.secondaryRemoved, 1);
  assert.equal(plan.preview.taxonomy?.genres.secondaryChanged, 1);
});

test('a tree upload moves a genre to another family and reports it', () => {
  const current = {
    genres: [
      { key: 'family:techno', name: 'Techno', level: 'family' as const, primaryParent: 'macro:electronic', aliases: [], umbrellas: [] },
      { key: 'macro:electronic', name: 'Electronic', level: 'macro' as const, aliases: [], umbrellas: [] },
      { key: 'techno', name: 'Techno', level: 'genre' as const, primaryParent: 'family:techno', aliases: [], umbrellas: [] },
    ],
  };
  const { rows } = parseGenreVocabCsv([
    TREE_HEADER,
    ['techno', 'House', 'Electronic', 'specific', '', ''],
  ]);
  const plan = planGenreTaxonomyCsvImport(rows, current);
  assert.deepEqual(plan.preview.errors, []);
  assert.equal(plan.preview.taxonomy?.genres.updated, 1);
  assert.equal(plan.preview.taxonomy?.genres.familyMoved, 1);
  assert.equal(imageOf(plan.after, 'techno').primaryParent, 'family:house');
});

test('a tree upload refuses a family listed under two macros', () => {
  const { rows } = parseGenreVocabCsv([
    TREE_HEADER,
    ['house', 'House', 'Electronic', 'specific', '', ''],
    ['pop', 'House', 'Pop', 'specific', '', ''],
  ]);
  assert.match(planGenreTaxonomyCsvImport(rows, { genres: [] }).preview.errors.join('\n'), /House is listed under two macros/);
});

test('a tree upload refuses a secondary family that is not in the file', () => {
  const { rows } = parseGenreVocabCsv([
    TREE_HEADER,
    ['house', 'House', 'Electronic', 'specific', 'Trance', ''],
  ]);
  assert.match(planGenreTaxonomyCsvImport(rows, { genres: [] }).preview.errors.join('\n'), /secondary family Trance is not in the file's families/);
});

test('a tree upload refuses a tier other than specific or umbrella_fallback', () => {
  const { rows } = parseGenreVocabCsv([
    TREE_HEADER,
    ['house', 'House', 'Electronic', 'subgenre', '', ''],
  ]);
  assert.match(planGenreTaxonomyCsvImport(rows, { genres: [] }).preview.errors.join('\n'), /tier "subgenre"/);
});

test('a tree upload refuses a spelling that belongs to a different genre', () => {
  const { rows } = parseGenreVocabCsv([
    TREE_HEADER,
    ['house', 'House', 'Electronic', 'specific', '', 'techno'],
    ['techno', 'Techno', 'Electronic', 'specific', '', ''],
  ]);
  assert.match(planGenreTaxonomyCsvImport(rows, { genres: [] }).preview.errors.join('\n'), /belongs to a different genre/);
});

test('a tree upload refuses a genre key listed twice', () => {
  const { rows } = parseGenreVocabCsv([
    TREE_HEADER,
    ['House', 'House', 'Electronic', 'specific', '', ''],
    ['house', 'House', 'Electronic', 'specific', '', ''],
  ]);
  assert.match(planGenreTaxonomyCsvImport(rows, { genres: [] }).preview.errors.join('\n'), /house is listed more than once/);
});

test('a tree upload refuses a macro with no family, and a family with no macro', () => {
  const { rows } = parseGenreVocabCsv([
    TREE_HEADER,
    ['house', 'House', '', 'specific', '', ''],
  ]);
  assert.match(planGenreTaxonomyCsvImport(rows, { genres: [] }).preview.errors.join('\n'), /family House has no macro/);
});

test('a tree upload also refuses when the resulting vocabulary breaks a taxonomy rule', () => {
  const current = {
    genres: [{ key: 'x', name: 'X', aliases: [], umbrellas: [], relations: [{ target: 'nope', type: 'adjacent' as const, weight: 0.5, origin: 'curated' as const }] }],
  };
  const { rows } = parseGenreVocabCsv(treeFixture());
  assert.match(planGenreTaxonomyCsvImport(rows, current).preview.errors.join('\n'), /target nope does not exist/);
});

test('the group-format file still plans without tree images', () => {
  const { rows } = parseGenreVocabCsv([
    ['genre', 'group', 'other_spellings'],
    ['trap', 'electronic; hip hop', ''],
  ]);
  const plan = planGenreVocabUpload(rows, { genres: [] });
  assert.equal(plan.preview.taxonomy, undefined);
  assert.equal(plan.after[0].image?.level, undefined);
  assert.equal(plan.after[0].image?.parent, 'electronic');
});

test('applyGenreVocabCsv writes a tree upload in one change, with full images, and undoes it', () =>
  withStore(async (store) => {
    const { rows } = parseGenreVocabCsv(treeFixture());
    const applied = await applyGenreVocabCsv(store, rows);
    assert.ok(applied.change);
    assert.equal(applied.preview.taxonomy?.genres.created, 7);
    const vocab = await store.getGenreVocabulary();
    const house = vocab.genres.find((g) => g.key === 'house');
    assert.equal(house?.primaryParent, 'family:house');
    assert.ok(house?.level === undefined || house.level === 'genre');
    assert.ok(vocab.genres.some((g) => g.key === 'macro:electronic' && g.level === 'macro'));

    const again = await applyGenreVocabCsv(store, rows);
    assert.equal(again.change, null);
    assert.equal(again.preview.unchanged, 12);
  }));

const REAL_TREE = '/mnt/project-files/genre-taxonomy/phase-a-taxonomy-tree-v3.csv';

test('the owner tree file plans 8 macros, 28 families, 256 genres and 209 secondary links with no errors', { skip: !fsSync.existsSync(REAL_TREE) }, async () => {
  const text = await fs.readFile(REAL_TREE, 'utf8');
  const parsed = parseGenreVocabCsv(parseCsv(text));
  assert.deepEqual(parsed.errors, []);
  const plan = planGenreTaxonomyCsvImport(parsed.rows, { genres: [] });
  assert.deepEqual(plan.preview.errors, []);
  const levels = plan.after.map((r) => r.image?.level ?? 'genre');
  assert.equal(levels.filter((l) => l === 'macro').length, 8);
  assert.equal(levels.filter((l) => l === 'family').length, 28);
  assert.equal(levels.filter((l) => l === 'genre').length, 256);
  assert.equal(plan.preview.taxonomy?.secondaryAdded, 209);
});

