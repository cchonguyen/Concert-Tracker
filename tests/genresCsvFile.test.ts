import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGenresCsv,
  genresCsvFileName,
  readGenresCsvFile,
  readGenresCsvText,
} from '../src/services/genresCsvFile';
import { csvText, exportTable } from '../src/server/events/genreCsv';
import type { CsvAct } from '../src/server/events/genreCsv';

const acts: CsvAct[] = [
  {
    key: 'band inc',
    name: 'Band, Inc',
    mbid: 'mbid-1',
    source: 'music-story',
    genres: [
      { style: 'punk', weight: 0.3 },
      { style: 'rock', weight: 0.7 },
    ],
  },
  { key: 'formula', name: '=Formula', source: 'none', genres: [] },
];

test('file name is artists-and-genres with the local date', () => {
  assert.equal(genresCsvFileName(new Date(2026, 10, 26)), 'artists-and-genres-2026-11-26.csv');
});

test('built CSV starts with a BOM, uses CRLF, and quotes cells per RFC 4180', () => {
  const text = buildGenresCsv(acts);
  assert.equal(text.charCodeAt(0), 0xfeff);
  const lines = text.slice(1).split('\r\n');
  assert.equal(lines[0], 'Artist,MusicBrainz ID,Current genres,Source,New genres,Version (leave as it is)');
  // Largest share first; the name has a comma so it is quoted.
  assert.ok(lines[1].startsWith('"Band, Inc",mbid-1,rock; punk,music-story,,'));
  // A name starting with = gets a leading apostrophe; nothing shown means "none".
  assert.ok(lines[2].startsWith("'=Formula,,,none,,"));
  assert.equal(lines[3], '');
});

test('reads columns by header name in any order and keeps only filled rows', () => {
  const text =
    '﻿New genres,Source,artist,MusicBrainz ID,Version (leave as it is)\r\n' +
    'rock; punk,none,Band,,stamp1\r\n' +
    '  ,none,Other,,\r\n' +
    "'+weird,none,\"Quoted, Name\",mb-2,\r\n";
  const result = readGenresCsvText(text);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.rows, [
    { line: 2, name: 'Band', mbid: '', newGenres: 'rock; punk', stamp: 'stamp1' },
    { line: 4, name: 'Quoted, Name', mbid: 'mb-2', newGenres: '+weird', stamp: '' },
  ]);
});

test('a missing New genres or Artist column gives a plain error', () => {
  const noNew = readGenresCsvText('Artist,Source\r\nBand,none\r\n');
  assert.deepEqual(noNew, { ok: false, error: 'The file has no "New genres" column.' });
  const noArtist = readGenresCsvText('New genres,Source\r\nrock,none\r\n');
  assert.deepEqual(noArtist, { ok: false, error: 'The file has no "Artist" column.' });
});

test('an empty file gives a plain error', () => {
  const result = readGenresCsvText('');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, 'The file is empty.');
});

test('an exported file with New genres filled reads back exactly', async () => {
  const table = exportTable(acts);
  table[1][4] = 'jazz';
  table[2][4] = "'=sum";
  const result = await readGenresCsvFile(new Blob([csvText(table)]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.rows, [
    { line: 2, name: 'Band, Inc', mbid: 'mbid-1', newGenres: 'jazz', stamp: table[1][5] },
    { line: 3, name: '=Formula', mbid: '', newGenres: '=sum', stamp: table[2][5] },
  ]);
});
