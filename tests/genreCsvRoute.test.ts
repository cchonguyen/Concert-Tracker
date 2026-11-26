import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { genresRouter } from '../src/server/events/genreRoutes.ts';
import { GENRE_MAP_SETTING } from '../src/server/events/genres.ts';
import { ownerOnly } from '../src/server/auth/requestScope.ts';
import type { LoggedEvent, SeenAct } from '../src/server/events/types.ts';

const json = { 'content-type': 'application/json' };
const now = new Date('2026-11-26T00:00:00Z');

const ev = (seen: SeenAct[]): LoggedEvent => ({
  id: 'e1',
  input: 'e1',
  name: 'e1',
  sources: {},
  details: { status: 'resolved', candidates: [], notes: [] },
  seen,
  daysAttended: [],
  companions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

async function withApp(fn: (app: express.Express, store: FileLineupStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'genres-csv-route-'));
  try {
    const store = new FileLineupStore(dir);
    await store.putEvent(ev([{ key: 'bonobo', name: 'Bonobo', from: 'you' }]));
    await store.putSetting(GENRE_MAP_SETTING, [
      { tag: 'house', style: 'house', parent: 'electronic' },
      { tag: 'techno', style: 'techno', parent: 'electronic' },
    ]);
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', genresRouter({ store, fetcher: {} as any, now: () => now } as any));
    await fn(app, store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ownStyles = async (store: FileLineupStore, key: string) =>
  (await store.listArtistGenres()).find((r) => r.key === key && r.source === 'owner')?.genres.map((g) => g.style) ?? null;

test('GET /api/artist-genres reports whether an upload can be undone', async () => {
  await withApp(async (app) => {
    const before = (await (await dispatch(app, { url: '/api/artist-genres' })).json()) as { csvUndo: unknown };
    assert.equal(before.csvUndo, null);

    const rows = [{ line: 2, name: 'Bonobo', mbid: '', newGenres: 'house', stamp: '' }];
    const applied = await dispatch(app, { url: '/api/artist-genres/csv/apply', method: 'POST', headers: json, body: { rows } });
    assert.equal(applied.status, 200);

    const after = (await (await dispatch(app, { url: '/api/artist-genres' })).json()) as { csvUndo: { count: number; at: string } };
    assert.equal(after.csvUndo.count, 1);
    assert.equal(after.csvUndo.at, now.toISOString());
  });
});

test('export is a CSV download with a BOM and a dated file name', async () => {
  await withApp(async (app) => {
    const res = await dispatch(app, { url: '/api/artist-genres/csv/export' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/csv/);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="artists-and-genres-2026-11-26.csv"');
    assert.ok(res.text().startsWith('﻿Artist,MusicBrainz ID,'));
    assert.ok(res.text().includes('Bonobo'));
  });
});

test('preview changes nothing; apply saves; undo puts the act back', async () => {
  await withApp(async (app, store) => {
    const rows = [{ line: 2, name: 'Bonobo', mbid: '', newGenres: 'house; techno', stamp: '' }];

    const preview = await dispatch(app, { url: '/api/artist-genres/csv/preview', method: 'POST', headers: json, body: { rows } });
    assert.equal(preview.status, 200);
    assert.equal(((await preview.json()) as { changes: unknown[] }).changes.length, 1);
    assert.equal(await ownStyles(store, 'bonobo'), null);

    const apply = await dispatch(app, { url: '/api/artist-genres/csv/apply', method: 'POST', headers: json, body: { rows, overwrite: [] } });
    const applied = (await apply.json()) as { saved: number; batchId: string | null };
    assert.equal(applied.saved, 1);
    assert.ok(applied.batchId);
    assert.deepEqual(await ownStyles(store, 'bonobo'), ['house', 'techno']);

    const undo = await dispatch(app, { url: '/api/artist-genres/csv/undo', method: 'POST', headers: json, body: {} });
    assert.equal(undo.status, 200);
    assert.equal(((await undo.json()) as { restored: number }).restored, 1);
    assert.equal(await ownStyles(store, 'bonobo'), null);
  });
});

test('more than 5,000 rows with new genres is refused in plain English', async () => {
  await withApp(async (app) => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({ line: i + 2, name: `Act ${i}`, mbid: '', newGenres: 'house', stamp: '' }));
    const res = await dispatch(app, { url: '/api/artist-genres/csv/preview', method: 'POST', headers: json, body: { rows } });
    assert.equal(res.status, 400);
    assert.match((res.json() as { error: string }).error, /more than 5,000 rows/);
  });
});

test('a body without rows, and an undo with no upload, are plain 400s', async () => {
  await withApp(async (app) => {
    const bad = await dispatch(app, { url: '/api/artist-genres/csv/apply', method: 'POST', headers: json, body: {} });
    assert.equal(bad.status, 400);
    assert.equal((bad.json() as { error: string }).error, 'Send { rows: [...] }.');

    const none = await dispatch(app, { url: '/api/artist-genres/csv/undo', method: 'POST', headers: json, body: {} });
    assert.equal(none.status, 400);
    assert.equal((none.json() as { error: string }).error, 'There is no upload to undo.');
  });
});

test('the genres file and the other genre tools are owner-only; PUT stays open (a member sets only their own additions)', () => {
  assert.equal(ownerOnly('POST', '/api/artist-genres/csv/preview'), true);
  assert.equal(ownerOnly('POST', '/api/artist-genres/csv/apply'), true);
  assert.equal(ownerOnly('POST', '/api/artist-genres/csv/undo'), true);
  assert.equal(ownerOnly('GET', '/api/artist-genres/csv/export'), true);
  assert.equal(ownerOnly('POST', '/api/artist-genres/bonobo/undo'), true);
  assert.equal(ownerOnly('GET', '/api/artist-genres'), false);
  assert.equal(ownerOnly('POST', '/api/artist-genres/music-story'), true);
  assert.equal(ownerOnly('POST', '/api/artist-genres/musicbrainz'), true);
  assert.equal(ownerOnly('PUT', '/api/artist-genres/bonobo'), false);
});

test('the owner sets an act\'s shared genres, then undoes it; a second undo is a plain 400', async () => {
  await withApp(async (app, store) => {
    const shared = async () => (await store.listArtistGenres()).find((r) => r.key === 'bonobo' && r.source === 'owner')?.genres.map((g) => g.style) ?? null;
    const put = await dispatch(app, { url: '/api/artist-genres/bonobo', method: 'PUT', headers: json, body: { styles: ['house'] } });
    assert.equal(put.status, 200);
    assert.deepEqual(await shared(), ['house']);
    assert.equal((await store.listGenreChanges({ key: 'bonobo' })).length, 1);

    const undo = await dispatch(app, { url: '/api/artist-genres/bonobo/undo', method: 'POST', headers: json, body: {} });
    assert.equal(undo.status, 200);
    const body = (await undo.json()) as { restored: unknown; rows: Array<{ key: string; source: string }> };
    assert.equal(body.restored, null);
    assert.ok(body.rows.every((r) => r.key === 'bonobo' && r.source !== 'owner'));
    assert.equal(await shared(), null);

    const again = await dispatch(app, { url: '/api/artist-genres/bonobo/undo', method: 'POST', headers: json, body: {} });
    assert.equal(again.status, 400);
  });
});

test('undo is refused with 409 when the act\'s genres were changed since', async () => {
  await withApp(async (app, store) => {
    await dispatch(app, { url: '/api/artist-genres/bonobo', method: 'PUT', headers: json, body: { styles: ['house'] } });
    const row = (await store.listArtistGenres()).find((r) => r.key === 'bonobo' && r.source === 'owner')!;
    await store.putArtistGenres([{ ...row, genres: [{ parent: 'electronic', style: 'techno', weight: 1 }] }]);
    const undo = await dispatch(app, { url: '/api/artist-genres/bonobo/undo', method: 'POST', headers: json, body: {} });
    assert.equal(undo.status, 409);
    assert.equal((undo.json() as { error: string }).error, 'Changed since; nothing undone.');
  });
});
