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
  genresCsvUndoStatus,
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
  (await store.listArtistGenres()).find((r) => r.key === key && r.source === 'owner')?.genres.map((g) => g.style) ?? null;

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
  assert.deepEqual(rows.map((r) => r.source).sort(), ['music-story', 'owner']);
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

test('undo puts back the latest upload from the change log, one upload at a time', async () => {
  const store = await fresh();
  await setOwnGenres(store, 'bonobo', ['indie rock'], now);
  const stamp = genreStamp('you', ['indie rock']);
  await applyGenresCsv(store, { rows: [line('Bonobo', 'house', stamp)] }, now);
  const second = await applyGenresCsv(store, { rows: [line('Bonobo', 'techno', genreStamp('you', ['house']))] }, later);
  const latest = await store.listGenreChanges({ latestBatchReason: 'Genres file upload' });
  assert.deepEqual(latest.map((c) => [c.batchId, c.actor, c.before?.genres.map((g) => g.style)]), [[second.batchId, 'owner', ['house']]]);
  assert.deepEqual(await genresCsvUndoStatus(store), { at: later.toISOString(), count: 1 });

  const undone = await undoGenresCsv(store, later);
  assert.deepEqual(undone, { restored: 1, leftAlone: [] });
  assert.deepEqual(await ownStyles(store, 'bonobo'), ['house']);
  const undoRow = (await store.listGenreChanges({ key: 'bonobo' }))[0];
  assert.equal(undoRow.reason, 'Undo genres file upload');
  assert.equal(undoRow.actor, 'owner');
  assert.equal((await store.listGenreChanges({ batchId: second.batchId! }))[0].undoneAt, later.toISOString());

  // The earlier upload is now the latest one not undone.
  assert.deepEqual(await undoGenresCsv(store, later), { restored: 1, leftAlone: [] });
  assert.deepEqual(await ownStyles(store, 'bonobo'), ['indie rock']);
  assert.equal(await genresCsvUndoStatus(store), null);
  await assert.rejects(undoGenresCsv(store), /no upload to undo/);
});

test('export covers the lineup catalog and every seen act, by name only', async () => {
  const store = await fresh([act('Bonobo')]);
  await store.upsertArtist({ key: 'caribou', name: 'Caribou', mbid: 'mb-caribou' });
  const text = await exportGenresCsv(store);
  const names = text.trimEnd().split('\r\n').slice(1).map((l) => l.split(',').slice(0, 2).join(','));
  assert.deepEqual(names.sort(), ['Bonobo,', 'Caribou,mb-caribou']);
  assert.doesNotMatch(text, /e1/);
});

test('the old undo setting is ignored and cleared', async () => {
  const store = await fresh();
  const old = { batchId: 'old', at: '2026-01-01T00:00:00Z', rows: [{ key: 'bonobo', name: 'Bonobo', before: null, after: null }] };
  await store.putSetting(GENRES_CSV_UNDO_SETTING, old);
  assert.equal(await genresCsvUndoStatus(store), null);
  await assert.rejects(undoGenresCsv(store), /no upload to undo/);
  assert.equal(await store.getSetting(GENRES_CSV_UNDO_SETTING), null);

  await store.putSetting(GENRES_CSV_UNDO_SETTING, old);
  await applyGenresCsv(store, { rows: [line('Bonobo', 'house', genreStamp('none', []))] }, now);
  assert.equal(await store.getSetting(GENRES_CSV_UNDO_SETTING), null);
  assert.deepEqual(await undoGenresCsv(store, later), { restored: 1, leftAlone: [] });
  assert.equal(await ownStyles(store, 'bonobo'), null);
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

// The owner's vocabulary: "big room" is an alias of "electro house".
async function withVocab(store: FileLineupStore) {
  await store.writeGenreVocabulary(
    [{ key: 'electrohouse', image: { key: 'electrohouse', name: 'electro house', parent: 'electronic', aliases: [{ key: 'bigroom', alias: 'big room' }], umbrellas: [] } }],
    { operation: 'alias-add', actor: 'owner', reason: 'test', summary: 'test' },
  );
}

test('export lists resolved names, and stored rows are not rewritten', async () => {
  const store = await fresh();
  await applyGenresCsv(store, { rows: [line('Bonobo', 'Big Room', genreStamp('none', []))] }, now);
  assert.deepEqual(await ownStyles(store, 'bonobo'), ['Big Room']);
  await withVocab(store);
  const text = await exportGenresCsv(store);
  const lines = text.trimEnd().split('\r\n');
  assert.equal(lines[1], `Bonobo,,electro house,owner,,${genreStamp('owner', ['electro house'])}`);
  assert.deepEqual(await ownStyles(store, 'bonobo'), ['Big Room']);
});

test('apply stores the resolved spelling and a resolved-equal row is no change', async () => {
  const store = await fresh();
  await withVocab(store);
  const preview = await previewGenresCsv(store, { rows: [line('Bonobo', 'Big Room', genreStamp('none', []))] });
  assert.deepEqual(preview.changes[0].after, [{ style: 'electro house', parent: 'electronic', isNew: false, typed: 'Big Room' }]);
  const saved = await applyGenresCsv(store, { rows: [line('Bonobo', 'Big Room', genreStamp('none', []))] }, now);
  assert.equal(saved.saved, 1);
  const row = (await store.listArtistGenres()).find((r) => r.key === 'bonobo' && r.source === 'owner');
  assert.deepEqual(row?.genres.map((g) => [g.style, g.parent]), [['electro house', 'electronic']]);
  const again = await previewGenresCsv(store, { rows: [line('Bonobo', 'Electro-House', genreStamp('owner', ['electro house']))] });
  assert.equal(again.changes[0].sameAsNow, true);
  assert.equal(again.changes[0].stale, false);
});

test('an alias made after download makes the row stale; a re-spelling does not', async () => {
  const store = await fresh();
  await applyGenresCsv(store, { rows: [line('Bonobo', 'big room', genreStamp('none', []))] }, now);
  const downloaded = genreStamp('owner', ['big room']);
  await withVocab(store);
  const p = await previewGenresCsv(store, { rows: [line('Bonobo', 'techno', downloaded)] });
  assert.equal(p.changes[0].stale, true);
  assert.equal(genreStamp('owner', ['Big-Room']), downloaded);
});
