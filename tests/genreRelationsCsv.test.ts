import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyGenreRelationsCsv,
  parseGenreRelationsCsv,
  planGenreRelationsCsvImport,
  previewGenreRelationsCsv,
  type GenreRelationsCsvRow,
} from '../src/server/events/genreRelationsCsv';
import { applyGenreVocabCsv, undoGenreVocabChange } from '../src/server/events/genreVocabularyManage';
import { parseGenreVocabCsv, planGenreVocabUpload } from '../src/server/events/genreVocabCsv';
import { FileLineupStore } from '../src/server/lineup/store/fileStore';
import { ManageError } from '../src/server/entities/manage';
import { parseCsv } from '../src/services/listImport';
import type { GenreVocabulary, VocabGenre } from '../src/server/events/genreTypes';
import type { GenreVocabWriteRow } from '../src/server/lineup/store/types';

const withStore = async (fn: (store: FileLineupStore) => Promise<void>) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'genre-relations-csv-'));
  try {
    await fn(new FileLineupStore(dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

// Two families (Dance, Soul & Funk) under two macros, four genres.
const TREE: string[][] = [
  ['genre', 'family', 'macro', 'tier', 'secondary_families', 'other_spellings'],
  ['house', 'Dance', 'Electronic', 'specific', '', ''],
  ['techno', 'Dance', 'Electronic', 'specific', '', ''],
  ['soul', 'Soul & Funk', 'Black Music', 'specific', '', ''],
  ['funk', 'Soul & Funk', 'Black Music', 'specific', '', 'funky'],
];

// Header, then rows, as a CSV table.
const table = (...lines: string[]): string[][] => [
  ['source', 'target', 'type', 'weight', 'origin'],
  ...lines.map((l) => l.split(',')),
];

const FIRST = table(
  'house,techno,adjacent,0.8,artist_cooccur',
  'house,Soul & Funk,secondary_parent,1,curated',
  'funk,soul,adjacent,0.5,curated',
);

const relationRows = (t: string[][]): GenreRelationsCsvRow[] => {
  const parsed = parseGenreRelationsCsv(t);
  assert.deepEqual(parsed.errors, []);
  return parsed.rows;
};

async function seed(store: FileLineupStore): Promise<void> {
  const parsed = parseGenreVocabCsv(TREE);
  assert.deepEqual(parsed.errors, []);
  const applied = await applyGenreVocabCsv(store, parsed.rows);
  assert.deepEqual(applied.preview.errors, []);
  assert.ok(applied.change);
}

const genresOf = async (store: FileLineupStore): Promise<Map<string, VocabGenre>> => {
  const vocab = await store.getGenreVocabulary();
  return new Map(vocab.genres.map((g) => [g.key, g]));
};

// The links of one genre as readable strings, sorted.
const linksOf = (genres: Map<string, VocabGenre>, key: string): string[] =>
  (genres.get(key)?.relations ?? []).map((r) => `${r.type}|${r.origin}|${r.target}|${r.weight}`).sort();

const applyAfter = (genres: VocabGenre[], after: GenreVocabWriteRow[]): VocabGenre[] => {
  const byKey = new Map(genres.map((g) => [g.key, g]));
  for (const r of after) {
    if (r.image) byKey.set(r.key, r.image);
    else byKey.delete(r.key);
  }
  return [...byKey.values()];
};

test('parseGenreRelationsCsv refuses a file without the five columns', () => {
  const parsed = parseGenreRelationsCsv([['source', 'target', 'type', 'weight']]);
  assert.deepEqual(parsed.rows, []);
  assert.deepEqual(parsed.errors, ['CSV is missing the "origin" column.']);
});

test('an upload adds its adjacent and secondary links and is one logged change', () =>
  withStore(async (store) => {
    await seed(store);
    const preview = await previewGenreRelationsCsv(store, relationRows(FIRST));
    assert.deepEqual(preview.errors, []);
    assert.equal(preview.added, 3);
    assert.equal(preview.removed, 0);
    assert.equal(preview.genresTouched, 2);

    const applied = await applyGenreRelationsCsv(store, relationRows(FIRST));
    assert.ok(applied.change);
    assert.equal(applied.change.operation, 'relations-import');
    assert.equal(applied.change.actor, 'owner');

    const genres = await genresOf(store);
    assert.deepEqual(linksOf(genres, 'house'), ['adjacent|artist_cooccur|techno|0.8', 'secondary_parent|curated|family:soulfunk|1']);
    assert.deepEqual(linksOf(genres, 'funk'), ['adjacent|curated|soul|0.5']);
    assert.deepEqual(linksOf(genres, 'techno'), []);
  }));

test('a file of only adjacent artist_cooccur rows leaves curated and secondary rows as they are', () =>
  withStore(async (store) => {
    await seed(store);
    await applyGenreRelationsCsv(store, relationRows(FIRST));

    const SECOND = table('house,techno,adjacent,0.9,artist_cooccur', 'funk,house,adjacent,0.3,artist_cooccur');
    const preview = await previewGenreRelationsCsv(store, relationRows(SECOND));
    assert.deepEqual(preview.errors, []);
    assert.deepEqual(preview.pairs, [{ type: 'adjacent', origin: 'artist_cooccur', added: 1, removed: 0, weightChanged: 1, unchanged: 0 }]);
    await applyGenreRelationsCsv(store, relationRows(SECOND));

    let genres = await genresOf(store);
    assert.deepEqual(linksOf(genres, 'house'), ['adjacent|artist_cooccur|techno|0.9', 'secondary_parent|curated|family:soulfunk|1']);
    assert.deepEqual(linksOf(genres, 'funk'), ['adjacent|artist_cooccur|house|0.3', 'adjacent|curated|soul|0.5']);

    // A row missing from the pair's file is removed; the curated rows still stay.
    const THIRD = table('funk,house,adjacent,0.3,artist_cooccur');
    const removal = await previewGenreRelationsCsv(store, relationRows(THIRD));
    assert.equal(removal.removed, 1);
    await applyGenreRelationsCsv(store, relationRows(THIRD));
    genres = await genresOf(store);
    assert.deepEqual(linksOf(genres, 'house'), ['secondary_parent|curated|family:soulfunk|1']);
    assert.deepEqual(linksOf(genres, 'funk'), ['adjacent|artist_cooccur|house|0.3', 'adjacent|curated|soul|0.5']);
  }));

test('a re-upload of the same file changes nothing and apply writes nothing', () =>
  withStore(async (store) => {
    await seed(store);
    await applyGenreRelationsCsv(store, relationRows(FIRST));
    const changesBefore = (await store.listGenreVocabChanges({})).length;

    const preview = await previewGenreRelationsCsv(store, relationRows(FIRST));
    assert.deepEqual(preview.errors, []);
    assert.equal(preview.added, 0);
    assert.equal(preview.removed, 0);
    assert.equal(preview.weightChanged, 0);
    assert.equal(preview.unchanged, 3);
    assert.equal(preview.genresTouched, 0);

    const applied = await applyGenreRelationsCsv(store, relationRows(FIRST));
    assert.equal(applied.change, null);
    assert.equal((await store.listGenreVocabChanges({})).length, changesBefore);
  }));

// Each refusal names its reason and writes nothing.
const REFUSALS: Array<[string, string[][], RegExp]> = [
  ['a source that is not in the vocabulary', table('nope,techno,adjacent,0.5,curated'), /not a genre in the vocabulary\. Upload the genre tree first/],
  ['a family used as a source', table('Dance,techno,adjacent,0.5,curated'), /not a genre in the vocabulary/],
  ['a weight of 0', table('house,techno,adjacent,0,curated'), /weight "0" must be/],
  ['a weight above 1', table('house,techno,adjacent,1.5,curated'), /weight "1.5" must be/],
  ['a weight that is not a number', table('house,techno,adjacent,heavy,curated'), /weight "heavy" must be/],
  ['an unknown type', table('house,techno,related,0.5,curated'), /type "related" must be/],
  ['origin lineup_cooccur', table('house,techno,adjacent,0.5,lineup_cooccur'), /reserved for the system job/],
  ['an unknown origin', table('house,techno,adjacent,0.5,guess'), /origin "guess" must be curated or artist_cooccur/],
  ['a secondary family that is a genre', table('house,techno,secondary_parent,1,curated'), /techno is not a family/],
  ['a secondary family that does not exist', table('house,Jazz,secondary_parent,1,curated'), /Jazz is not a family/],
  ['an adjacent target that is a family', table('house,Dance,adjacent,0.5,curated'), /Dance is not a genre/],
  ['the same link listed twice', table('house,techno,adjacent,0.5,curated', 'house,techno,adjacent,0.6,curated'), /is listed more than once/],
  ['an adjacent pair listed both ways', table('house,techno,adjacent,0.5,curated', 'techno,house,adjacent,0.5,curated'), /both directions/],
  ['a link to itself', table('house,house,adjacent,0.5,curated'), /cannot link to itself/],
  ['a derived_from loop', table('house,techno,derived_from,1,curated', 'techno,house,derived_from,1,curated'), /makes a loop/],
];

for (const [name, rows, reason] of REFUSALS) {
  test(`a file with ${name} is refused`, () =>
    withStore(async (store) => {
      await seed(store);
      const preview = await previewGenreRelationsCsv(store, relationRows(rows));
      assert.ok(preview.errors.some((e) => reason.test(e)), `expected ${reason} in ${JSON.stringify(preview.errors)}`);
      const changesBefore = (await store.listGenreVocabChanges({})).length;
      await assert.rejects(applyGenreRelationsCsv(store, relationRows(rows)), ManageError);
      assert.equal((await store.listGenreVocabChanges({})).length, changesBefore);
    }));
}

test('an adjacent pair reversed against a stored row the file does not replace is refused', () =>
  withStore(async (store) => {
    await seed(store);
    await applyGenreRelationsCsv(store, relationRows(FIRST)); // stored: funk to soul, adjacent, curated
    const reversed = relationRows(table('soul,funk,adjacent,0.5,artist_cooccur'));
    const preview = await previewGenreRelationsCsv(store, reversed);
    assert.ok(preview.errors.some((e) => /adjacent in both directions/.test(e)), JSON.stringify(preview.errors));
  }));

test('a file that names the same pair as a stored link with another origin is refused', () =>
  withStore(async (store) => {
    await seed(store);
    await applyGenreRelationsCsv(store, relationRows(FIRST)); // stored: house to techno, adjacent, artist_cooccur
    const clash = relationRows(table('house,techno,adjacent,0.5,curated'));
    const preview = await previewGenreRelationsCsv(store, clash);
    assert.ok(preview.errors.some((e) => /already stored with an origin this file does not replace/.test(e)), JSON.stringify(preview.errors));
  }));

test('a missing source column is reported at parse', () => {
  const parsed = parseGenreRelationsCsv([['target', 'type', 'weight', 'origin']]);
  assert.deepEqual(parsed.errors, ['CSV is missing the "source" column.']);
});

test('a file whose genres are not uploaded yet is refused until the tree is in', () => {
  const plan = planGenreRelationsCsvImport(relationRows(FIRST), { genres: [] });
  assert.equal(plan.after.length, 0);
  assert.ok(plan.preview.errors.some((e) => /Upload the genre tree first/.test(e)));
});

test('undo puts back the links the upload replaced', () =>
  withStore(async (store) => {
    await seed(store);
    const before = await genresOf(store);
    const beforeHouse = linksOf(before, 'house');
    const beforeFunk = linksOf(before, 'funk');

    const applied = await applyGenreRelationsCsv(store, relationRows(FIRST));
    assert.ok(applied.change);
    await undoGenreVocabChange(store, applied.change.id);

    const after = await genresOf(store);
    assert.deepEqual(linksOf(after, 'house'), beforeHouse);
    assert.deepEqual(linksOf(after, 'funk'), beforeFunk);
    const [logged] = await store.listGenreVocabChanges({ id: applied.change.id });
    assert.ok(logged.undoneAt);
  }));

const TREE_FILE = '/mnt/project-files/genre-taxonomy/phase-a-taxonomy-tree-v3.csv';
const RELATIONS_FILE = '/mnt/project-files/genre-taxonomy/phase-a-genre-relations-v3.csv';
const REAL_FILES = fsSync.existsSync(TREE_FILE) && fsSync.existsSync(RELATIONS_FILE);

test(
  'the real tree and genre links files plan with no errors and 589 links',
  { skip: REAL_FILES ? false : 'the real taxonomy files are not present' },
  () => {
    const tree = parseGenreVocabCsv(parseCsv(fsSync.readFileSync(TREE_FILE, 'utf8')));
    assert.deepEqual(tree.errors, []);
    const treePlan = planGenreVocabUpload(tree.rows, { genres: [] });
    assert.deepEqual(treePlan.preview.errors, []);
    const genres = applyAfter([], treePlan.after);

    const links = parseGenreRelationsCsv(parseCsv(fsSync.readFileSync(RELATIONS_FILE, 'utf8')));
    assert.deepEqual(links.errors, []);
    assert.equal(links.rows.length, 589);

    const plan = planGenreRelationsCsvImport(links.rows, { genres });
    assert.deepEqual(plan.preview.errors, []);
    const linkCount = applyAfter(genres, plan.after).reduce((n, g) => n + (g.relations?.length ?? 0), 0);
    assert.equal(linkCount, 589);
  },
);
