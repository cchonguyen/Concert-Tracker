import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseGenreVocabCsv, planGenreVocabCsvImport } from '../src/server/events/genreVocabCsv';
import { applyGenreVocabCsv, previewGenreVocabCsv } from '../src/server/events/genreVocabularyManage';
import { FileLineupStore } from '../src/server/lineup/store/fileStore';

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
