import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { PipelineDeps } from '../src/server/lineup/pipeline.ts';
import { EventPatch } from '../src/server/events/service.ts';
import { LoggedEvent } from '../src/server/events/types.ts';
import { sheetsRouter } from '../src/server/events/sheetRoutes.ts';
import { importsRouter } from '../src/server/events/importRoutes.ts';
import { parseSheetLink, SHEETS_SETTING, SheetsApi, SheetsAuthError, SheetValue, sheetVersion } from '../src/server/events/sheets.ts';
import { fillPatch, findMatches, ImportApi, readTable, runImport } from '../src/services/listImport.ts';
import { SHEETS_BASE_SETTING } from '../src/server/events/sheets.ts';
import { droppedColumns, outsideEdits, serialToDate, sheetRows, sheetTable } from '../src/services/sheetSync.ts';
import { fakeFetcher } from './fakes.ts';

const NOW = new Date('2026-10-21T12:00:00Z');

const ev = (id: string, patch: Partial<LoggedEvent>): LoggedEvent => ({
  id,
  input: patch.name ?? id,
  name: id,
  sources: {},
  details: { status: 'resolved', candidates: [], notes: [] },
  seen: [],
  daysAttended: [],
  companions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...patch,
});

const show = ev('e1', {
  name: 'Robyn',
  startDate: '2025-04-12',
  year: 2025,
  venue: 'The Greek',
  city: 'Berkeley',
  region: 'CA',
  seen: [
    { key: 'robyn', name: 'Robyn', from: 'lineup', role: 'headliner', roleFrom: 'lineup', favourite: true },
    { key: 'kim petras', name: 'Kim Petras', from: 'you' },
  ],
  companions: ['Sam'],
  rating: 4,
});

// The sheet as the app writes it, then read back the way Sheets returns it
// (unformatted: numbers stay numbers, empty cells are "").
const asRead = (rows: Array<Array<string | number | null>>): SheetValue[][] => rows.map((r) => r.map((v) => v ?? ''));

test('parseSheetLink: the id and tab from a link, or a bare id', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  assert.deepEqual(parseSheetLink(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=42`), { id, tabId: 42 });
  assert.deepEqual(parseSheetLink(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`), { id, tabId: undefined });
  assert.deepEqual(parseSheetLink(id), { id, tabId: undefined });
  assert.equal(parseSheetLink('https://example.com/not-a-sheet'), null);
});

test('sheetTable: date serials in date columns become dates; numbers elsewhere stay numbers', () => {
  assert.equal(serialToDate(45759), '2025-04-12');
  const table = sheetTable([
    ['Date', 'Event', 'Rating', 'Ticket price', 'Year'],
    [45759, 'Robyn', 4, 89.5, 2025],
    ['2025-05-01', 1999, '', '', ''],
  ]);
  assert.deepEqual(table, [
    ['Date', 'Event', 'Rating', 'Ticket price', 'Year'],
    ['2025-04-12', 'Robyn', '4', '89.5', '2025'],
    ['2025-05-01', '1999', '', '', ''],
  ]);
});

test('round trip: an untouched sheet has no outside edits, and its rows add nothing to their events', () => {
  const table = sheetTable(asRead(sheetRows([show])));
  assert.equal(outsideEdits(table, table), 0);
  const list = readTable(table);
  assert.equal(list.rows[0].eventId, 'e1');
  const m = findMatches(list.rows[0], [show], []);
  assert.equal(m.exported, true);
  assert.deepEqual(m.exact, { kind: 'event', event: show });
  assert.deepEqual(fillPatch(list.rows[0], show).adds, []);
  assert.deepEqual(droppedColumns(list), []);
});

test('outsideEdits counts rows edited, added or removed in the sheet since the app wrote it', () => {
  const written = sheetTable(asRead(sheetRows([show, ev('e2', { name: 'Other', year: 2024 })])));
  const header = written[0];
  const edited = written.map((r) => [...r]);
  edited[1][header.indexOf('Rating')] = '3';
  assert.equal(outsideEdits(edited, written), 1);
  assert.equal(outsideEdits([...written, header.map((h) => (h === 'Event' ? 'Added' : ''))], written), 1);
  assert.equal(outsideEdits(written.slice(0, 2), written), 1, 'a removed row counts');
  assert.equal(outsideEdits([...written, header.map(() => '')], written), 0, 'blank rows do not');
  // Never written by the app: every row with data would be replaced.
  assert.equal(outsideEdits(written), 2);
  assert.equal(outsideEdits([]), 0);
});

test('the app is the source of truth: an edited export row never changes what the event says', () => {
  const now = ev('e1', { ...show, notes: undefined, ticketPrice: undefined });
  const rows = sheetRows([show]);
  const header = rows[0] as string[];
  const set = (col: string, v: string | number | null) => (rows[1][header.indexOf(col)] = v);
  set('Venue', 'Hearst Greek'); // the event has a venue: kept
  set('Rating', 2); // kept
  set('Saw', 'Robyn; Tove Lo'); // Kim Petras is not removed; Tove Lo is new
  set('Went with', ''); // Sam is not removed
  set('Notes', 'from the sheet'); // the event has none: filled
  const list = readTable(sheetTable(asRead(rows)));
  const { patch, adds } = fillPatch(list.rows[0], now);
  assert.equal('venue' in patch, false);
  assert.equal('rating' in patch, false);
  assert.equal('companions' in patch, false);
  assert.equal(patch.notes, 'from the sheet');
  assert.deepEqual(
    patch.seen?.map((s) => s.name),
    ['Robyn', 'Kim Petras', 'Tove Lo'],
  );
  assert.deepEqual(adds, ['1 act seen', 'notes']);
});

test('runImport folds export rows into their events through PATCH, filling only gaps', async () => {
  const other = ev('e2', { name: 'Other', year: 2024 });
  const rows = sheetRows([show, other]);
  const header = rows[0] as string[];
  rows[1][header.indexOf('Rating')] = 5; // show is rated: ignored
  rows[2][header.indexOf('Rating')] = 3; // other is not: filled
  const list = readTable(sheetTable(asRead(rows)));
  const patches: Array<{ id: string; patch: EventPatch }> = [];
  const api: ImportApi = {
    create: async () => assert.fail('nothing is created'),
    update: async (id, patch) => {
      patches.push({ id, patch });
      return other;
    },
    addEmail: async () => assert.fail('no email rows'),
    restoreEmail: async () => assert.fail('no email rows'),
  };
  const events = [show, other];
  const items = list.rows.map((row) => ({ row, choice: { kind: 'into' as const, target: findMatches(row, events, []).exact! } }));
  const result = await runImport(items, api);
  assert.deepEqual(result, { created: 0, merged: 1, unchanged: 1, failed: [] });
  assert.deepEqual(patches, [{ id: 'e2', patch: { rating: 3 } }]);
});

test('a row without an ID goes through the usual list matching', () => {
  const rows = sheetRows([show]);
  const header = rows[0] as string[];
  const added = header.map((h) => (h === 'Event' ? 'Robyn - Sexistential Tour' : h === 'Date' ? '2025-04-12' : h === 'Notes' ? 'mine' : null));
  const list = readTable(sheetTable(asRead([...rows, added])));
  const m = findMatches(list.rows[1], [show], []);
  assert.equal(m.exported, undefined);
  assert.equal(m.exact?.kind, 'event');
});

test('droppedColumns: columns of your own are named before the tab is rewritten', () => {
  const list = readTable([
    ['Event', 'Date', 'Vibe', 'Type'],
    ['Robyn', '2025-04-12', 'great', 'Concert'],
  ]);
  assert.deepEqual(droppedColumns(list), ['Vibe']);
});

function fakeSheets(initial: SheetValue[][] = []) {
  const state = { values: initial, writes: [] as Array<Array<SheetValue | null>>[] };
  const api: SheetsApi = {
    authUrl: (redirect, st) => `https://accounts.google.com/auth?redirect_uri=${encodeURIComponent(redirect)}&state=${st}`,
    accessToken: async () => 'at',
    connect: async (code) => {
      if (code !== 'good-code') throw new SheetsAuthError('bad code');
      return { refreshToken: 'rt', account: 'me@example.com' };
    },
    info: async (_rt, id) => {
      if (id.startsWith('missing')) throw new Error('not found');
      return { title: 'My shows', tabs: [{ title: 'Sheet1', id: 0 }, { title: '2025', id: 7 }] };
    },
    create: async () => ({ id: 'created-sheet-id-000000000', info: { title: 'LiveArchive events', tabs: [{ title: 'Events', id: 0 }] } }),
    read: async () => state.values,
    write: async (_rt, _id, _tab, rows) => {
      state.writes.push(rows);
      state.values = rows.map((r) => r.map((v) => v ?? ''));
    },
  };
  return { api, state };
}

async function server(t: { after: (fn: () => void) => void }, sheets: SheetsApi | null) {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'sheets-')));
  const deps: PipelineDeps = {
    store,
    fetcher: fakeFetcher({}).fetcher,
    adapters: [],
    lateAdapters: [],
    gemini: null,
    quota: null,
    search: null,
    now: () => NOW,
  };
  const app = express();
  app.use(express.json());
  app.use('/api', sheetsRouter(deps, sheets));
  app.use('/api', importsRouter(deps, null));
  const call = (route: string, method = 'GET', body?: unknown) =>
    dispatch(app, {
      method,
      url: `/api${route}`,
      headers: { 'content-type': 'application/json' },
      body,
    });
  return { store, call };
}

test('sheets routes: off without Google keys', async (t) => {
  const { call } = await server(t, null);
  assert.deepEqual(await (await call('/sheets')).json(), { configured: false, connected: false });
  assert.equal((await call('/sheets/connect')).status, 503);
});

test('sheets routes: sign in through the shared callback, link a tab, and refuse a write over a changed sheet', async (t) => {
  const fake = fakeSheets([['Event'], ['Robyn']]);
  const { store, call } = await server(t, fake.api);

  // Signed out: reading is refused with a connect hint.
  const early = await call('/sheets/values');
  assert.equal(early.status, 409);
  assert.equal((await early.json()).connect, true);

  const start = await call('/sheets/connect');
  assert.equal(start.status, 302);
  const location = new URL(start.headers.get('location')!);
  assert.match(location.searchParams.get('redirect_uri')!, /\/api\/gmail\/callback$/);
  const state = location.searchParams.get('state')!;
  assert.match(state, /^sheets-/);
  // A Gmail callback is passed on to the Gmail router.
  const gmail = await call('/gmail/callback?code=x&state=gmail-state');
  assert.match(gmail.headers.get('location')!, /^\/app\?gmail=/);
  const done = await call(`/gmail/callback?code=good-code&state=${state}`);
  assert.equal(done.headers.get('location'), '/app?view=table&sheets=connected');
  assert.match((await call(`/gmail/callback?code=good-code&state=${state}`)).headers.get('location')!, /sheets=That%20sign-in%20expired/);

  assert.equal((await (await call('/sheets/link', 'POST', { url: 'nope' })).json()).error.includes('Paste the link'), true);
  const linked = await (
    await call('/sheets/link', 'POST', { url: 'https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz/edit#gid=7' })
  ).json();
  assert.equal(linked.sheet.tab, '2025');
  assert.equal(linked.sheet.url, 'https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz/edit#gid=7');

  const status = await (await call('/sheets')).json();
  assert.deepEqual([status.connected, status.account, status.sheet.title], [true, 'me@example.com', 'My shows']);

  const read = await (await call('/sheets/values')).json();
  assert.equal(read.version, sheetVersion([['Event'], ['Robyn']]));

  // Someone edits the sheet before the write: refused, nothing written.
  fake.state.values = [['Event'], ['Robyn'], ['Bicep']];
  const stale = await call('/sheets/values', 'PUT', { rows: [['Event'], ['Robyn']], version: read.version });
  assert.equal(stale.status, 409);
  assert.equal(fake.state.writes.length, 0);

  const fresh = await (await call('/sheets/values')).json();
  const ok = await call('/sheets/values', 'PUT', { rows: [['Event', 'ID'], ['Robyn', 'e1'], ['Bicep', null]], version: fresh.version });
  assert.equal(ok.status, 200, ok.text());
  assert.equal((await ok.json()).sheet.syncedAt, NOW.toISOString());
  assert.deepEqual(fake.state.writes[0], [['Event', 'ID'], ['Robyn', 'e1'], ['Bicep', null]]);
  // What was written is the base for the next sync.
  const next = await (await call('/sheets/values')).json();
  assert.deepEqual(next.base, [['Event', 'ID'], ['Robyn', 'e1'], ['Bicep', null]]);
  assert.deepEqual((await store.getSetting<{ tab: string }>(SHEETS_BASE_SETTING))?.tab, '2025');

  await call('/sheets/disconnect', 'POST');
  assert.deepEqual(await (await call('/sheets')).json(), { configured: true, member: false, picker: false, connected: false });
  assert.deepEqual(await store.getSetting(SHEETS_SETTING), {});
});
