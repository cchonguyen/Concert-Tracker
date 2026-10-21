import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import express from 'express';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { PipelineDeps } from '../src/server/lineup/pipeline.ts';
import { EventPatch } from '../src/server/events/service.ts';
import { LoggedEvent } from '../src/server/events/types.ts';
import { sheetsRouter } from '../src/server/events/sheetRoutes.ts';
import { importsRouter } from '../src/server/events/importRoutes.ts';
import { parseSheetLink, SHEETS_SETTING, SheetsApi, SheetsAuthError, SheetValue, sheetVersion } from '../src/server/events/sheets.ts';
import { editPatch, findMatches, ImportApi, readTable, runImport } from '../src/services/listImport.ts';
import { SHEETS_BASE_SETTING } from '../src/server/events/sheets.ts';
import { droppedColumns, rowsToReview, serialToDate, sheetRows, sheetTable } from '../src/services/sheetSync.ts';
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

test('round trip: an untouched sheet changes nothing and needs no review', () => {
  const table = sheetTable(asRead(sheetRows([show])));
  const list = readTable(table);
  assert.equal(list.rows[0].eventId, 'e1');
  const m = findMatches(list.rows[0], [show], []);
  assert.equal(m.edit, show);
  assert.deepEqual(editPatch(list.rows[0], show, list.present).changes, []);
  assert.equal(rowsToReview(list, [show], []), 0);
  assert.deepEqual(droppedColumns(list), []);
});

// The tab as the app wrote it at the last sync, read back as a base.
const baseOf = (events: LoggedEvent[]) => {
  const base = readTable(sheetTable(asRead(sheetRows(events))));
  return (id: string) => ({ row: base.rows.find((r) => r.eventId === id)!, present: base.present });
};

test('three-way: edits made in the app since the last sync are never undone by the stale sheet', () => {
  const base = baseOf([show]);
  // In the app since: new venue, rating, an act and a person. The sheet is untouched.
  const now = ev('e1', {
    ...show,
    venue: 'Greek Theatre',
    rating: 5,
    seen: [...show.seen, { key: 'charli xcx', name: 'Charli XCX', from: 'you' }],
    companions: ['Sam', 'Lee'],
  });
  const sheet = readTable(sheetTable(asRead(sheetRows([show]))));
  assert.deepEqual(editPatch(sheet.rows[0], now, sheet.present, new Set(), base('e1')).changes, []);
  const written = readTable(sheetTable(asRead(sheetRows([show]))));
  assert.equal(rowsToReview(sheet, [now], [], written), 0);
  // Without the base the same sheet looks like edits, all marked as unknown.
  const blind = editPatch(sheet.rows[0], now, sheet.present);
  assert.equal(blind.changes.length > 0 && blind.changes.every((c) => c.both), true);
});

test('three-way: a field changed in the sheet applies; one changed on both sides is flagged and kept with keepApp', () => {
  const base = baseOf([show]);
  const now = ev('e1', { ...show, venue: 'Greek Theatre', notes: 'app note' });
  const rows = sheetRows([show]);
  const header = rows[0] as string[];
  const set = (col: string, v: string | number | null) => (rows[1][header.indexOf(col)] = v);
  set('Rating', 3); // only the sheet changed it
  set('Venue', 'Hearst Greek'); // both changed it
  set('Saw', 'Robyn; Kim Petras; Tove Lo'); // the sheet added an act
  const sheet = readTable(sheetTable(asRead(rows)));
  const all = editPatch(sheet.rows[0], now, sheet.present, new Set(), base('e1'));
  assert.deepEqual(
    all.changes.map((c) => [c.field, c.from, c.to, c.both]),
    [
      ['venue', 'Greek Theatre', 'Hearst Greek', true],
      ['rating', '4', '3', false],
      ['acts seen', '', 'Tove Lo', false],
    ],
  );
  const kept = editPatch(sheet.rows[0], now, sheet.present, new Set(), base('e1'), true).patch;
  assert.equal('venue' in kept, false);
  assert.equal('notes' in kept, false);
  assert.equal(kept.rating, 3);
  assert.deepEqual(
    kept.seen?.map((s) => s.name),
    ['Robyn', 'Kim Petras', 'Tove Lo'],
  );
});

test('three-way: lists merge, so an act added in the app and one removed in the sheet both stand', () => {
  const base = baseOf([show]);
  const now = ev('e1', { ...show, seen: [...show.seen, { key: 'charli xcx', name: 'Charli XCX', from: 'you' }], companions: ['Sam', 'Lee'] });
  const rows = sheetRows([show]);
  const header = rows[0] as string[];
  rows[1][header.indexOf('Saw')] = 'Robyn';
  rows[1][header.indexOf('Went with')] = 'Sam; Ana';
  const sheet = readTable(sheetTable(asRead(rows)));
  const { patch, changes } = editPatch(sheet.rows[0], now, sheet.present, new Set(), base('e1'));
  assert.deepEqual(patch.seen?.map((s) => s.name), ['Robyn', 'Charli XCX']);
  assert.deepEqual(patch.companions, ['Sam', 'Lee', 'Ana']);
  assert.equal(changes.every((c) => !c.both), true);
});

test('editPatch: edited cells replace values, emptied cells clear them, unreadable cells change nothing', () => {
  const rows = sheetRows([show]);
  const header = rows[0] as string[];
  const row = [...rows[1]];
  const set = (col: string, v: string | number | null) => (row[header.indexOf(col)] = v);
  set('Venue', 'Greek Theatre');
  set('City', null);
  set('Rating', 'great'); // not 1 to 5: flagged, left alone
  set('Saw', 'Robyn; Charli XCX');
  set('Went with', 'Sam; Lee');
  set('Notes', 'Encore was Dancing On My Own');
  const list = readTable(sheetTable(asRead([header, row])));
  const { patch, changes } = editPatch(list.rows[0], show, list.present);
  assert.deepEqual(
    changes.map((c) => c.field),
    ['venue', 'city', 'notes', 'acts seen', 'went with'],
  );
  assert.equal(patch.venue, 'Greek Theatre');
  assert.equal(patch.city, null);
  assert.equal('rating' in patch, false);
  assert.equal(patch.notes, 'Encore was Dancing On My Own');
  // Robyn keeps the lineup's role and the favourite mark; Kim Petras is gone.
  assert.deepEqual(patch.seen, [
    { name: 'Robyn', from: 'lineup', role: 'headliner', roleFrom: 'lineup', favourite: true },
    { name: 'Charli XCX', from: 'you' },
  ]);
  assert.deepEqual(patch.companions, ['Sam', 'Lee']);
  // Without a base, nothing says the sheet is newer.
  assert.deepEqual(changes.find((c) => c.field === 'acts seen'), { field: 'acts seen', from: 'Kim Petras', to: 'Charli XCX', both: true });
  assert.equal(changes.every((c) => c.both), true);
  assert.deepEqual(editPatch(list.rows[0], show, list.present, new Set(), undefined, true).patch, {});
});

test('editPatch: dates, end dates and the year', () => {
  const header = sheetRows([])[0] as string[];
  const read = (cells: Record<string, string | number>) =>
    readTable(sheetTable([header, header.map((h) => cells[h] ?? '')]));
  const base = { Event: 'Robyn', ID: 'e1', Venue: 'The Greek', City: 'Berkeley, CA', Saw: 'Robyn; Kim Petras', 'Went with': 'Sam', Rating: 4 };

  // A typed date (a serial) moves the event and adds an end date.
  let list = read({ ...base, Date: 45760, 'End date': 45761, Year: 2025 });
  let out = editPatch(list.rows[0], show, list.present);
  assert.equal(out.patch.startDate, '2025-04-13');
  assert.equal(out.patch.endDate, '2025-04-14');

  // Clearing the date keeps the year (the server keeps it from the date).
  list = read({ ...base, Year: 2025 });
  out = editPatch(list.rows[0], show, list.present);
  assert.equal(out.patch.startDate, null);
  assert.equal('year' in out.patch, false);
  assert.deepEqual(out.changes.map((c) => c.field), ['date']);

  // A date the code can't read (05/06/2025) changes nothing.
  list = read({ ...base, Date: '05/06/2025', Year: 2025 });
  out = editPatch(list.rows[0], show, list.present);
  assert.deepEqual(out.changes, []);

  // An undated event: a year read from its name is not a change you made.
  const undated = ev('e2', { name: 'Coachella 2019', seen: [], companions: [] });
  list = read({ Event: 'Coachella 2019', ID: 'e2' });
  assert.deepEqual(editPatch(list.rows[0], undated, list.present).changes, []);
});

test('runImport applies edits through PATCH and counts untouched rows', async () => {
  const rows = sheetRows([show, ev('e2', { name: 'Other', year: 2024 })]);
  const header = rows[0] as string[];
  rows[1][header.indexOf('Rating')] = 5;
  const list = readTable(sheetTable(asRead(rows)));
  const patches: Array<{ id: string; patch: EventPatch }> = [];
  const api: ImportApi = {
    create: async () => assert.fail('nothing is created'),
    update: async (id, patch) => {
      patches.push({ id, patch });
      return show;
    },
    addEmail: async () => assert.fail('no email rows'),
    restoreEmail: async () => assert.fail('no email rows'),
  };
  const events = [show, ev('e2', { name: 'Other', year: 2024 })];
  const items = list.rows.map((row) => ({ row, choice: { kind: 'edit' as const, event: findMatches(row, events, []).edit!, keepApp: false } }));
  const result = await runImport(items, api, new Set(), list.present);
  assert.deepEqual(result, { created: 0, merged: 0, edited: 1, unchanged: 1, failed: [] });
  assert.deepEqual(patches, [{ id: 'e1', patch: { rating: 5 } }]);
});

test('a row added in the sheet without an ID goes through the usual list matching', () => {
  const rows = sheetRows([show]);
  const header = rows[0] as string[];
  const added = header.map((h) => (h === 'Event' ? 'Robyn - Sexistential Tour' : h === 'Date' ? '2025-04-12' : h === 'Notes' ? 'mine' : null));
  const list = readTable(sheetTable(asRead([...rows, added])));
  const m = findMatches(list.rows[1], [show], []);
  assert.equal(m.edit, undefined);
  assert.equal(m.exact?.kind, 'event');
  assert.equal(rowsToReview(list, [show], []), 1);
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
  const listening = app.listen(0);
  await new Promise((resolve) => listening.once('listening', resolve));
  t.after(() => listening.close());
  const base = `http://127.0.0.1:${(listening.address() as AddressInfo).port}/api`;
  const call = (route: string, method = 'GET', body?: unknown) =>
    fetch(`${base}${route}`, {
      method,
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
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
  assert.match(gmail.headers.get('location')!, /^\/\?gmail=/);
  const done = await call(`/gmail/callback?code=good-code&state=${state}`);
  assert.equal(done.headers.get('location'), '/?view=table&sheets=connected');
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
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal((await ok.json()).sheet.syncedAt, NOW.toISOString());
  assert.deepEqual(fake.state.writes[0], [['Event', 'ID'], ['Robyn', 'e1'], ['Bicep', null]]);
  // What was written is the base for the next sync.
  const next = await (await call('/sheets/values')).json();
  assert.deepEqual(next.base, [['Event', 'ID'], ['Robyn', 'e1'], ['Bicep', null]]);
  assert.deepEqual((await store.getSetting<{ tab: string }>(SHEETS_BASE_SETTING))?.tab, '2025');

  await call('/sheets/disconnect', 'POST');
  assert.deepEqual(await (await call('/sheets')).json(), { configured: true, connected: false });
  assert.deepEqual(await store.getSetting(SHEETS_SETTING), {});
});
