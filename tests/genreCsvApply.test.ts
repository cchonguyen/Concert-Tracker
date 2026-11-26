import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LoggedEvent, SeenAct } from '../src/server/events/types.ts';
import { GENRE_MAP_SETTING, setOwnGenres } from '../src/server/events/genres.ts';
import { genresByArtist } from '../src/services/genres.ts';
import {
  applyGenresCsv,
  exportGenresCsv,
  previewGenresCsv,
  undoGenresCsv,
  GENRES_CSV_UNDO_SETTING,
} from '../src/server/events/genreCsvApply.ts';
import { genreStamp } from '../src/server/events/genreCsv.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';

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
  { tag: 'techno', style: 'techno', parent: 'electronic' },
  { tag: 'indie rock', style: 'indie rock', parent: 'rock' },
];
const now = new Date('2026-11-26T00:00:00Z');
const later = new Date('2026-11-27T00:00:00Z');

async function fresh(seen: SeenAct[] = [act('Bonobo')]) {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'genres-csv-')));
  await store.putEvent(ev('e1', seen));
  await store.putSetting(GENRE_MAP_SETTING, map);
  return store;
}

const line = (name: string, newGenres: string, stamp = '', mbid = '', n = 2) => ({ line: n, name, mbid, newGenres, stamp });
const ownStyles = async (store: FileLineupStore, key: string) =>
  (await store.listArtistGenres()).find((r) => r.key === key && r.source === 'you')?.genres.map((g) => g.style) ?? null;

test('export lists every act once, with the stamp of what shows now', async () => {
  const store = await fresh([act('Bonobo'), act('Bonobo')]);
  await store.upsertArtist({ key: 'bonobo', name: 'Bonobo', mbid: 'mb-bonobo' });
  const text = await exportGenresCsv(store);
  assert.ok(text.startsWith('﻿Artist,MusicBrainz ID,Current genres,Source,New genres,Version (leave as it is)\r\n'));
  const lines = text.trimEnd().split('\r\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], `Bonobo,mb-bonobo,,none,,${genreStamp('none', [])}`);
});

test('edited after export with the CSV untouched: nothing changes', async () => {
  const store = await fresh();
  const stamp = genreStamp('none', []); // what the file held at export
  await setOwnGenres(store, 'bonobo', ['house'], now); // edited in the app since
  const out = await applyGenresCsv(store, { rows: [line('Bonobo', 'techno', stamp)] }, now);
  assert.equal(out.saved, 0);
  assert.equal(out.batchId, null);
  assert.deepEqual(out.skipped.map((s) => s.reason.slice(0, 22)), ['changed in the app aft']);
  assert.deepEqual(await ownStyles(store, 'bonobo'), ['house']);
  assert.equal(await store.getSetting(GENRES_CSV_UNDO_SETTING), null);
});

test('a stale row is saved only when its act is ticked to overwrite', async () => {
  const store = await fresh();
  await setOwnGenres(store, 'bonobo', ['house'], now);
  const stale = genreStamp('you', ['house']);
  const old = genreStamp('none', []);
  const rows = { rows: [line('Bonobo', 'techno', old)] };
  const preview = await previewGenresCsv(store, rows);
  assert.equal(preview.changes[0].stale, true);
  const out = await applyGenresCsv(store, { rows: [line('Bonobo', 'techno', old)], overwrite: ['bonobo'] }, now);
  assert.equal(out.saved, 1);
  assert.deepEqual(await ownStyles(store, 'bonobo'), ['techno']);
  // A current stamp (of what shows now, techno) is not stale, so no tick is needed.
  const fine = await applyGenresCsv(store, { rows: [line('Bonobo', 'house', genreStamp('you', ['techno']))] }, later);
  assert.equal(fine.saved, 1);
  assert.deepEqual(await ownStyles(store, 'bonobo'), ['house']);
  assert.notEqual(stale, genreStamp('you', ['techno']));
});

test('over-limit rows are skipped with a reason and never cut short', async () => {
  const store = await fresh([act('Bonobo'), act('Caribou'), act('Radiohead')]);
  const many = Array.from({ length: 11 }, (_, i) => `style ${i}`).join('; ');
  const long = 'x'.repeat(61);
  const out = await applyGenresCsv(
    store,
    {
      rows: [
        line('Bonobo', many, '', '', 2),
        line('Radiohead', long, '', '', 3),
        line('Caribou', 'house', genreStamp('none', []), '', 4),
      ],
    },
    now,
  );
  assert.deepEqual(out.skipped.map((s) => s.line), [2, 3]);
  assert.match(out.skipped[0].reason, /^There are 11 genres/);
  assert.match(out.skipped[1].reason, /longer than 60 characters/);
  assert.equal(out.saved, 1);
  assert.equal(await ownStyles(store, 'bonobo'), null);
  assert.equal(await ownStyles(store, 'radiohead'), null);
  assert.deepEqual(await ownStyles(store, 'caribou'), ['house']);
});

test('music-story rows stay stored underneath your genres', async () => {
  const store = await fresh();
  await store.putArtistGenres([
    { key: 'bonobo', name: 'Bonobo', source: 'music-story', genres: [{ parent: 'electronic', style: 'house', weight: 1 }], checkedAt: 'now' },
  ]);
  await applyGenresCsv(store, { rows: [line('Bonobo', 'techno', genreStamp('music-story', ['house']))] }, now);
  const rows = await store.listArtistGenres();
  assert.deepEqual(rows.map((r) => r.source).sort(), ['music-story', 'you']);
  assert.deepEqual(genresByArtist(rows).get('bonobo')?.genres.map((g: { style: string }) => g.style), ['techno']);
  // Undo removes yours; the music-story row is still there.
  await undoGenresCsv(store);
  assert.deepEqual((await store.listArtistGenres()).map((r) => [r.source, r.genres[0].style]), [['music-story', 'house']]);
});

test('a blank New genres cell leaves the act alone', async () => {
  const store = await fresh();
  const out = await applyGenresCsv(store, { rows: [line('Bonobo', '   ', genreStamp('none', []))] }, now);
  assert.deepEqual(out, { saved: 0, skipped: [], batchId: null });
  assert.deepEqual(await store.listArtistGenres(), []);
});

test('unmatched and ambiguous rows are skipped, never guessed', async () => {
  const store = await fresh([act('Bonobo'), act('Caribou')]);
  const out = await applyGenresCsv(
    store,
    {
      rows: [
        line('Nobody', 'house', '', '', 2),
        line('Caribou', 'house', '', '', 3),
        line('caribou', 'techno', '', '', 4),
      ],
    },
    now,
  );
  assert.equal(out.saved, 0);
  assert.deepEqual(out.skipped.map((s) => [s.line, s.reason]), [
    [2, 'no act with that MusicBrainz ID or name'],
    [3, 'two rows for the same act'],
    [4, 'two rows for the same act'],
  ]);
});

test('an act matched by MusicBrainz ID is kept even with a different name', async () => {
  const store = await fresh();
  await store.upsertArtist({ key: 'bonobo', name: 'Bonobo', mbid: 'mb-bonobo' });
  const preview = await previewGenresCsv(store, { rows: [line('Some other name', 'house', '', 'MB-BONOBO')] });
  assert.equal(preview.changes[0]?.key, 'bonobo');
});

test('undo restores the act before the upload, and a later upload replaces the record', async () => {
  const store = await fresh();
  await setOwnGenres(store, 'bonobo', ['indie rock'], now);
  const stamp = genreStamp('you', ['indie rock']);
  await applyGenresCsv(store, { rows: [line('Bonobo', 'house', stamp)] }, now);
  await applyGenresCsv(store, { rows: [line('Bonobo', 'techno', genreStamp('you', ['house']))] }, later);
  const record = await store.getSetting<{ rows: Array<{ before: { genres: Array<{ style: string }> } | null }> }>(GENRES_CSV_UNDO_SETTING);
  assert.deepEqual(record?.rows[0].before?.genres.map((g) => g.style), ['house']);
  const undone = await undoGenresCsv(store);
  assert.deepEqual(undone, { restored: 1, leftAlone: [] });
  assert.deepEqual(await ownStyles(store, 'bonobo'), ['house']);
  assert.equal(await store.getSetting(GENRES_CSV_UNDO_SETTING), null);
  await assert.rejects(undoGenresCsv(store), /no upload to undo/);
});

test('undo removes the act you had no genres for, and leaves later edits alone', async () => {
  const store = await fresh([act('Bonobo'), act('Caribou')]);
  await applyGenresCsv(store, { rows: [line('Bonobo', 'house', genreStamp('none', []), '', 2), line('Caribou', 'techno', genreStamp('none', []), '', 3)] }, now);
  await setOwnGenres(store, 'bonobo', ['indie rock'], later); // edited after the upload
  const undone = await undoGenresCsv(store);
  assert.deepEqual(undone, { restored: 1, leftAlone: ['Bonobo'] });
  assert.deepEqual(await ownStyles(store, 'bonobo'), ['indie rock']);
  assert.equal(await ownStyles(store, 'caribou'), null);
});

test('the upload input must be a list of rows', async () => {
  const store = await fresh();
  await assert.rejects(applyGenresCsv(store, { rows: 'nope' }, now), /Send \{ rows/);
  await assert.rejects(previewGenresCsv(store, {}), /Send \{ rows/);
});
