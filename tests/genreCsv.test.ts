import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GENRE_CSV_HEADER,
  MAX_CSV_ROWS,
  changesToSave,
  csvText,
  exportTable,
  fnv1a,
  genreStamp,
  matchCsvRows,
  parseGenreList,
  previewGenresCsv,
  readCell,
  readGenreRows,
  safeCell,
} from '../src/server/events/genreCsv.ts';
import type { CsvAct, GenreCsvRow } from '../src/server/events/genreCsv.ts';

const act = (over: Partial<CsvAct> & { key: string; name: string }): CsvAct => ({
  source: 'you',
  genres: [],
  ...over,
});

const row = (over: Partial<GenreCsvRow> & { name: string; newGenres: string }): GenreCsvRow => ({
  line: 2,
  mbid: '',
  stamp: '',
  ...over,
});

// ---- version stamp ----

test('fnv1a matches the published FNV-1a 32-bit test vectors', () => {
  assert.equal(fnv1a(''), '811c9dc5');
  assert.equal(fnv1a('a'), 'e40c292c');
  assert.equal(fnv1a('foobar'), 'bf9cf968');
});

test('fnv1a always gives 8 lower-case hex characters', () => {
  for (const text of ['x', 'none|', 'musicbrainz|rock;pop', 'é€𝄞']) {
    assert.match(fnv1a(text), /^[0-9a-f]{8}$/);
  }
});

test('genreStamp ignores order and case of the styles', () => {
  assert.equal(genreStamp('you', ['Techno', 'House']), genreStamp('you', ['house', 'TECHNO']));
});

test('genreStamp changes when the styles or the source change', () => {
  const base = genreStamp('you', ['techno']);
  assert.notEqual(base, genreStamp('you', ['techno', 'house']));
  assert.notEqual(base, genreStamp('music-story', ['techno']));
});

test('genreStamp with nothing shown is the stamp of "none|"', () => {
  assert.equal(genreStamp('none', []), fnv1a('none|'));
  assert.equal(genreStamp('you', []), fnv1a('none|'));
});

// ---- cell safety ----

test('safeCell prefixes formula starts and readCell strips exactly one apostrophe', () => {
  for (const s of ['=SUM(A1)', '+1', '-x', '@me']) {
    assert.equal(safeCell(s), `'${s}`);
    assert.equal(readCell(safeCell(s)), s);
  }
  assert.equal(safeCell('Björk'), 'Björk');
  assert.equal(readCell("''=x"), "'=x");
  assert.equal(readCell("'plain"), "'plain");
});

test('safeCell and readCell round-trip names that start with apostrophes', () => {
  for (const s of ["'=x", "''-y", "'plain", "'", "x'=y", '=x']) {
    assert.equal(readCell(safeCell(s)), s);
  }
  assert.equal(safeCell("'=x"), "''=x");
});

// ---- export ----

test('exportTable writes the header, then one row per act with its shown genres', () => {
  const table = exportTable([
    act({
      key: 'boards of canada',
      name: 'Boards of Canada',
      mbid: 'mbid-1',
      source: 'music-story',
      genres: [
        { style: 'idm', weight: 0.3 },
        { style: 'ambient', weight: 0.7 },
      ],
    }),
  ]);
  assert.deepEqual(table[0], [...GENRE_CSV_HEADER]);
  assert.deepEqual(table[1], [
    'Boards of Canada',
    'mbid-1',
    'ambient; idm',
    'music-story',
    '',
    genreStamp('music-story', ['ambient', 'idm']),
  ]);
});

test('exportTable shows "none" as the source when nothing shows, even for a "say none" act', () => {
  const table = exportTable([act({ key: 'a', name: 'A', source: 'you', genres: [] })]);
  assert.equal(table[1][2], '');
  assert.equal(table[1][3], 'none');
  assert.equal(table[1][5], fnv1a('none|'));
});

test('exportTable labels MusicBrainz and yours the way the file says', () => {
  const table = exportTable([
    act({ key: 'a', name: 'A', source: 'musicbrainz', genres: [{ style: 'rock', weight: 1 }] }),
    act({ key: 'b', name: 'B', source: 'you', genres: [{ style: 'pop', weight: 1 }] }),
  ]);
  assert.equal(table[1][3], 'MusicBrainz');
  assert.equal(table[2][3], 'yours');
});

test('exportTable keeps one row per key and a blank MusicBrainz cell when none', () => {
  const table = exportTable([
    act({ key: 'a', name: 'A' }),
    act({ key: 'a', name: 'A again' }),
  ]);
  assert.equal(table.length, 2);
  assert.equal(table[1][0], 'A');
  assert.equal(table[1][1], '');
});

test('exportTable guards spreadsheet formulas in the name', () => {
  const table = exportTable([act({ key: 'x', name: '=HYPERLINK("u")' })]);
  assert.equal(table[1][0], `'=HYPERLINK("u")`);
});

test('csvText adds a byte order mark, CRLF endings and quotes only where needed', () => {
  const text = csvText([
    ['Artist', 'Note'],
    ['Simon, Paul', 'say "hi"'],
    ['Plain', 'line\nbreak'],
  ]);
  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.equal(text.slice(1), 'Artist,Note\r\n"Simon, Paul","say ""hi"""\r\nPlain,"line\nbreak"\r\n');
});

// ---- reading the file ----

test('readGenreRows finds columns by name, in any order and any case', () => {
  const result = readGenreRows([
    ['new GENRES', 'artist', 'Source', 'musicbrainz id'],
    ['techno; house', 'Carl Cox', 'yours', 'abc'],
    ['', 'Blank Row', 'yours', ''],
  ]);
  assert.deepEqual(result, {
    ok: true,
    rows: [{ line: 2, name: 'Carl Cox', mbid: 'abc', newGenres: 'techno; house', stamp: '' }],
  });
});

test('readGenreRows keeps only filled rows and gives 1-based record numbers', () => {
  const result = readGenreRows([
    ['Artist', 'New genres'],
    ['A', ''],
    ['B', '   '],
    ['C', 'rock'],
    ['D', 'pop'],
  ]);
  assert.ok(result.ok);
  assert.deepEqual(
    result.rows.map((r) => [r.line, r.name]),
    [
      [4, 'C'],
      [5, 'D'],
    ],
  );
});

test('readGenreRows reads the stamp and strips the formula apostrophe from the name', () => {
  const result = readGenreRows([
    ['Artist', 'New genres', 'Version (leave as it is)'],
    ["'=Odd name", 'rock', 'ABCDEF01'],
  ]);
  assert.ok(result.ok);
  assert.equal(result.rows[0].name, '=Odd name');
  assert.equal(result.rows[0].stamp, 'ABCDEF01');
});

test('readGenreRows tolerates a byte order mark on the first header', () => {
  const result = readGenreRows([['﻿Artist', 'New genres'], ['A', 'rock']]);
  assert.ok(result.ok);
  assert.equal(result.rows.length, 1);
});

test('readGenreRows gives a plain error when Artist or New genres is missing', () => {
  assert.deepEqual(readGenreRows([['Name', 'New genres'], ['A', 'x']]), {
    ok: false,
    error: 'The file has no "Artist" column.',
  });
  assert.deepEqual(readGenreRows([['Artist', 'Genres'], ['A', 'x']]), {
    ok: false,
    error: 'The file has no "New genres" column.',
  });
});

test('readGenreRows rejects an empty table', () => {
  assert.deepEqual(readGenreRows([]), { ok: false, error: 'The file is empty.' });
});

test('readGenreRows refuses more than 5,000 filled rows and accepts exactly 5,000', () => {
  const body = (n: number) => Array.from({ length: n }, (_, i) => [`Act ${i}`, 'rock']);
  const ok = readGenreRows([['Artist', 'New genres'], ...body(MAX_CSV_ROWS)]);
  assert.ok(ok.ok);
  assert.equal(ok.rows.length, MAX_CSV_ROWS);
  const over = readGenreRows([['Artist', 'New genres'], ...body(MAX_CSV_ROWS + 1)]);
  assert.equal(over.ok, false);
  assert.match(over.ok ? '' : over.error, /more than 5,000 rows/);
});

// ---- genre list ----

test('parseGenreList splits on semicolons, trims and collapses spaces', () => {
  assert.deepEqual(parseGenreList('  deep   house ;techno; '), { ok: true, styles: ['deep house', 'techno'] });
});

test('parseGenreList drops duplicates case-insensitively and keeps the first spelling', () => {
  assert.deepEqual(parseGenreList('Techno; techno ;TECHNO;house'), { ok: true, styles: ['Techno', 'house'] });
});

test('parseGenreList refuses a cell with only separators', () => {
  const r = parseGenreList(' ; ;; ');
  assert.equal(r.ok, false);
});

test('parseGenreList allows exactly 10 genres and refuses 11 whole', () => {
  const ten = Array.from({ length: 10 }, (_, i) => `g${i}`).join(';');
  assert.ok(parseGenreList(ten).ok);
  const eleven = `${ten};extra`;
  const r = parseGenreList(eleven);
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.reason, /11 genres/);
});

test('parseGenreList counts duplicates out before the 10 limit', () => {
  const ten = Array.from({ length: 10 }, (_, i) => `g${i}`).join(';');
  assert.ok(parseGenreList(`${ten};G1;g2`).ok);
});

test('parseGenreList allows 60 characters and refuses 61', () => {
  const sixty = 'a'.repeat(60);
  assert.deepEqual(parseGenreList(sixty), { ok: true, styles: [sixty] });
  const r = parseGenreList('a'.repeat(61));
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.reason, /60 characters/);
});

// ---- matching ----

const acts: CsvAct[] = [
  act({ key: 'carl cox', name: 'Carl Cox', mbid: 'MBID-COX' }),
  act({ key: 'bjork', name: 'Björk' }),
  act({ key: 'the rolling stones', name: 'The Rolling Stones' }),
  act({ key: 'rolling stones', name: 'Rolling Stones' }),
];

test('matchCsvRows matches by MusicBrainz ID, ignoring case and spaces', () => {
  const { matched, skipped } = matchCsvRows([row({ name: 'Whoever', mbid: ' mbid-cox ', newGenres: 'x' })], acts, {});
  assert.equal(skipped.length, 0);
  assert.equal(matched[0].act.key, 'carl cox');
});

test('matchCsvRows matches by normalized name (case, accents and punctuation)', () => {
  const { matched } = matchCsvRows([row({ name: 'BJORK!', newGenres: 'x' })], acts, {});
  assert.equal(matched[0].act.key, 'bjork');
  const { matched: m2 } = matchCsvRows([row({ name: 'björk', newGenres: 'x' })], acts, {});
  assert.equal(m2[0].act.key, 'bjork');
});

test('matchCsvRows uses an alias from artist_aliases', () => {
  const only = [act({ key: 'bjork', name: 'Björk' })];
  const { matched, skipped } = matchCsvRows(
    [row({ name: 'Bjork Gudmundsdottir', newGenres: 'x' })],
    only,
    { 'bjork gudmundsdottir': 'Björk' },
  );
  assert.equal(skipped.length, 0);
  assert.equal(matched[0].act.key, 'bjork');
});

test('matchCsvRows skips a name that an alias makes match two acts', () => {
  const { matched, skipped } = matchCsvRows(
    [row({ name: 'The Rolling Stones', newGenres: 'rock' })],
    acts,
    { 'the rolling stones': 'Rolling Stones' },
  );
  assert.equal(matched.length, 0);
  assert.equal(skipped[0].reason, 'the name matches more than one act');
});

test('matchCsvRows prefers the ID and skips when the name points to another act', () => {
  const { matched, skipped } = matchCsvRows(
    [row({ name: 'Bjork', mbid: 'mbid-cox', newGenres: 'x' })],
    acts,
    {},
  );
  assert.equal(matched.length, 0);
  assert.equal(skipped[0].reason, 'the ID and the name point to different acts');
});

test('matchCsvRows accepts an ID with a name that matches nothing', () => {
  const { matched } = matchCsvRows([row({ name: 'Old Name', mbid: 'mbid-cox', newGenres: 'x' })], acts, {});
  assert.equal(matched[0].act.key, 'carl cox');
});

test('matchCsvRows falls back to the name when the ID matches nothing and the act has no ID', () => {
  const { matched } = matchCsvRows([row({ name: 'Bjork', mbid: 'unknown', newGenres: 'x' })], acts, {});
  assert.equal(matched[0].act.key, 'bjork');
});

test('matchCsvRows skips a name match whose stored MusicBrainz ID is different', () => {
  const { matched, skipped } = matchCsvRows([row({ name: 'Carl Cox', mbid: 'other', newGenres: 'x' })], acts, {});
  assert.equal(matched.length, 0);
  assert.equal(skipped[0].reason, 'the name matches an act with a different MusicBrainz ID');
});

test('matchCsvRows reports a plain reason when nothing matches', () => {
  const { matched, skipped } = matchCsvRows([row({ name: 'Nobody', newGenres: 'x' })], acts, {});
  assert.equal(matched.length, 0);
  assert.deepEqual(skipped, [{ line: 2, name: 'Nobody', reason: 'no act with that MusicBrainz ID or name' }]);
});

test('matchCsvRows never matches a blank name', () => {
  const { matched, skipped } = matchCsvRows([row({ name: '  ', newGenres: 'x' })], acts, {});
  assert.equal(matched.length, 0);
  assert.equal(skipped[0].reason, 'no act with that MusicBrainz ID or name');
});

test('matchCsvRows skips every row for an act that appears twice', () => {
  const rows = [
    row({ line: 2, name: 'Carl Cox', newGenres: 'techno' }),
    row({ line: 3, name: 'carl cox', newGenres: 'house' }),
    row({ line: 4, name: 'Björk', newGenres: 'pop' }),
  ];
  const { matched, skipped } = matchCsvRows(rows, acts, {});
  assert.deepEqual(matched.map((m) => m.row.line), [4]);
  assert.deepEqual(skipped.map((s) => [s.line, s.reason]), [
    [2, 'two rows for the same act'],
    [3, 'two rows for the same act'],
  ]);
});

// ---- preview and stale checks ----

const known = [
  { style: 'Deep House', parent: 'house' },
  { style: 'techno', parent: 'electronic' },
];

test('previewGenresCsv gives before and after, marking unknown genres as new', () => {
  const cox = act({
    key: 'carl cox',
    name: 'Carl Cox',
    source: 'music-story',
    genres: [{ style: 'techno', weight: 1 }],
  });
  const stamp = genreStamp('music-story', ['techno']);
  const { changes, skipped } = previewGenresCsv(
    [row({ name: 'Carl Cox', newGenres: 'deep house; Dub Techno', stamp })],
    [cox],
    {},
    known,
  );
  assert.deepEqual(skipped, []);
  assert.deepEqual(changes, [
    {
      line: 2,
      key: 'carl cox',
      name: 'Carl Cox',
      mbid: '',
      before: ['techno'],
      beforeSource: 'music-story',
      after: [
        { style: 'Deep House', parent: 'house', isNew: false },
        { style: 'Dub Techno', parent: 'Dub Techno', isNew: true },
      ],
      stale: false,
      sameAsNow: false,
    },
  ]);
});

test('previewGenresCsv treats a changed stamp as stale', () => {
  const cox = act({ key: 'carl cox', name: 'Carl Cox', genres: [{ style: 'house', weight: 1 }] });
  const { changes } = previewGenresCsv(
    [row({ name: 'Carl Cox', newGenres: 'techno', stamp: genreStamp('you', ['techno']) })],
    [cox],
    {},
    known,
  );
  assert.equal(changes[0].stale, true);
});

test('previewGenresCsv: edited in the app after download and CSV untouched is stale with the same stamp rule', () => {
  // Downloaded with "techno", then the person changed it to "house" in the app.
  const downloadedStamp = genreStamp('you', ['techno']);
  const nowInApp = act({ key: 'carl cox', name: 'Carl Cox', genres: [{ style: 'house', weight: 1 }] });
  const { changes } = previewGenresCsv(
    [row({ name: 'Carl Cox', newGenres: 'deep house', stamp: downloadedStamp })],
    [nowInApp],
    {},
    known,
  );
  assert.equal(changes[0].stale, true);
  assert.deepEqual(changesToSave(changes, new Set()), []);
  assert.equal(changesToSave(changes, new Set(['carl cox'])).length, 1);
});

test('previewGenresCsv with a missing or unreadable stamp is stale only when the act has genres now', () => {
  const withGenres = act({ key: 'a', name: 'A', genres: [{ style: 'rock', weight: 1 }] });
  const without = act({ key: 'b', name: 'B', source: 'you', genres: [] });
  const { changes } = previewGenresCsv(
    [
      row({ line: 2, name: 'A', newGenres: 'pop', stamp: '' }),
      row({ line: 3, name: 'B', newGenres: 'pop', stamp: 'not-a-stamp' }),
    ],
    [withGenres, without],
    {},
    known,
  );
  assert.equal(changes[0].stale, true);
  assert.equal(changes[1].stale, false);
});

test('previewGenresCsv marks a row as no change only when your genres already are these', () => {
  const yours = act({ key: 'a', name: 'A', source: 'you', genres: [{ style: 'Deep House', weight: 1 }] });
  const fromStory = act({ key: 'b', name: 'B', source: 'music-story', genres: [{ style: 'rock', weight: 1 }] });
  const { changes } = previewGenresCsv(
    [
      row({ line: 2, name: 'A', newGenres: 'deep house', stamp: genreStamp('you', ['Deep House']) }),
      row({ line: 3, name: 'B', newGenres: 'rock', stamp: genreStamp('music-story', ['rock']) }),
    ],
    [yours, fromStory],
    {},
    known,
  );
  assert.equal(changes[0].sameAsNow, true);
  assert.equal(changes[1].sameAsNow, false);
  assert.deepEqual(changesToSave(changes, new Set()).map((c) => c.key), ['b']);
});

test('previewGenresCsv lists a bad genre list as skipped with the reason and changes nothing', () => {
  const cox = act({ key: 'carl cox', name: 'Carl Cox' });
  const { changes, skipped } = previewGenresCsv(
    [row({ name: 'Carl Cox', newGenres: ' ; ' })],
    [cox],
    {},
    known,
  );
  assert.deepEqual(changes, []);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].name, 'Carl Cox');
});

test('previewGenresCsv reports the file row number on each skipped row, in order', () => {
  const { skipped } = previewGenresCsv(
    [row({ line: 7, name: 'Nobody', newGenres: 'x' }), row({ line: 3, name: 'Nobody 2', newGenres: 'x' })],
    [],
    {},
    known,
  );
  assert.deepEqual(skipped.map((s) => s.line), [3, 7]);
});

test('changesToSave leaves out stale rows unless ticked', () => {
  const changes = previewGenresCsv(
    [row({ line: 2, name: 'A', newGenres: 'pop', stamp: 'ffffffff' })],
    [act({ key: 'a', name: 'A', genres: [{ style: 'rock', weight: 1 }] })],
    {},
    known,
  ).changes;
  assert.equal(changes[0].stale, true);
  assert.equal(changesToSave(changes, new Set()).length, 0);
  assert.equal(changesToSave(changes, new Set(['a'])).length, 1);
});
