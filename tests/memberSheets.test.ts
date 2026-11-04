import { dispatch } from './helpers/testApp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { PipelineDeps } from '../src/server/lineup/pipeline.ts';
import { sheetsRouter, withoutPrivateColumns } from '../src/server/events/sheetRoutes.ts';
import { SHEETS_BASE_SETTING, SHEETS_SETTING, SheetsApi, SheetValue } from '../src/server/events/sheets.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';
import { openToken, sealToken } from '../src/server/auth/tokenBox.ts';
import { sheetRows } from '../src/services/sheetSync.ts';
import { fakeFetcher } from './fakes.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');
const ANN = { email: 'ann@example.com', userId: 'u-ann', role: 'member' as const };
const SHEET_ID = 'abcdefghijklmnopqrstuvwxyz';

test('tokenBox: sealed under the user id, so another member cannot open it', async () => {
  const sealed = await sealToken(KEY, 'u-ann', 'refresh-123');
  assert.match(sealed, /^t1:/);
  assert.ok(!sealed.includes('refresh-123'));
  assert.equal(await openToken(KEY, 'u-ann', sealed), 'refresh-123');
  await assert.rejects(openToken(KEY, 'u-bob', sealed), /could not be opened/);
  await assert.rejects(openToken(Buffer.alloc(32, 9).toString('base64'), 'u-ann', sealed), /could not be opened/);
  await assert.rejects(sealToken('c2hvcnQ=', 'u-ann', 'x'), /32 random bytes/);
});

test('withoutPrivateColumns cuts Notes and Went with, and only those', () => {
  const rows = [['Event', 'Went', 'Went with', 'Notes', 'ID'], ['A', 'Yes', 'Sam', 'secret', '1']];
  assert.deepEqual(withoutPrivateColumns(rows), [['Event', 'Went', 'ID'], ['A', 'Yes', '1']]);
  assert.deepEqual(withoutPrivateColumns([['Event'], ['A']]), [['Event'], ['A']]);
});

test('sheetRows omitPrivate leaves out Notes and Went with', () => {
  const header = sheetRows([]).at(0)!;
  const cut = sheetRows([], {}, { omitPrivate: true }).at(0)!;
  assert.ok(header.includes('Notes') && header.includes('Went with'));
  assert.ok(!cut.includes('Notes') && !cut.includes('Went with') && cut.includes('Went') && cut.includes('ID'));
});

async function memberServer(t: { after: (fn: () => void) => void }) {
  const base = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'msheets-')));
  const store = base.forUser({ userId: ANN.userId, role: ANN.role });
  const written: Array<Array<SheetValue | null>>[] = [];
  const scopes: boolean[] = [];
  const api: SheetsApi = {
    authUrl: (redirect, st, narrow) => (scopes.push(Boolean(narrow)), `https://accounts.google.com/auth?redirect_uri=${encodeURIComponent(redirect)}&state=${st}`),
    accessToken: async () => 'short-lived',
    connect: async () => ({ refreshToken: 'rt-secret', account: 'ann@gmail.com' }),
    info: async () => ({ title: 'Picked', tabs: [{ title: 'Sheet1', id: 0 }] }),
    create: async () => ({ id: 'created-sheet-id-000000000', info: { title: 'LiveArchive events', tabs: [{ title: 'Events', id: 0 }] } }),
    read: async () => [],
    write: async (_rt, _id, _tab, rows) => void written.push(rows),
  };
  const deps = { store, fetcher: fakeFetcher({}).fetcher, adapters: [], lateAdapters: [], gemini: null, quota: null, search: null, now: () => new Date('2026-10-29T12:00:00Z') } as PipelineDeps;
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runAsMember(ANN, store, next));
  app.use('/api', sheetsRouter(deps, api));
  const call = (route: string, method = 'GET', body?: unknown) =>
    dispatch(app, { method, url: `/api${route}`, headers: { 'content-type': 'application/json' }, body });
  return { store, call, written, scopes };
}

test('member sheets: refused without the sealing key', async (t) => {
  delete process.env.SHEETS_TOKEN_ENC_KEY;
  const { call } = await memberServer(t);
  const res = await call('/sheets/connect');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /SHEETS_TOKEN_ENC_KEY/);
});

test('member sheets: narrow scope, sealed token, picked id only, no notes or companions written or kept', async (t) => {
  process.env.SHEETS_TOKEN_ENC_KEY = KEY;
  t.after(() => void delete process.env.SHEETS_TOKEN_ENC_KEY);
  const { store, call, written, scopes } = await memberServer(t);

  const start = await call('/sheets/connect');
  assert.equal(start.status, 302);
  assert.deepEqual(scopes, [true]);
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  await call(`/gmail/callback?code=c&state=${state}`);

  // The stored setting holds a sealed token, never the plain one.
  const stored: any = await store.getSetting(SHEETS_SETTING);
  assert.equal(stored.refreshToken, undefined);
  assert.ok(!JSON.stringify(stored).includes('rt-secret'));
  assert.equal(await openToken(KEY, ANN.userId, stored.refreshTokenSealed), 'rt-secret');
  assert.equal((await (await call('/sheets')).json()).connected, true);

  // A pasted link is not how a member names a sheet; the picker's id is.
  assert.equal((await call('/sheets/link', 'POST', { url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit` })).status, 400);
  const linked = await (await call('/sheets/link', 'POST', { pickedId: SHEET_ID })).json();
  assert.equal(linked.sheet.id, SHEET_ID);

  // The picker needs its keys.
  assert.equal((await call('/sheets/picker')).status, 400);
  process.env.GOOGLE_PICKER_API_KEY = 'k';
  process.env.GOOGLE_APP_ID = '123';
  t.after(() => (delete process.env.GOOGLE_PICKER_API_KEY, delete process.env.GOOGLE_APP_ID));
  assert.deepEqual(await (await call('/sheets/picker')).json(), { accessToken: 'short-lived', apiKey: 'k', appId: '123' });

  // A client that sends the private columns anyway still cannot get them into
  // the sheet or the stored base.
  const { version } = await (await call('/sheets/values')).json();
  const rows = [['Event', 'Went with', 'Notes', 'ID'], ['Robyn', 'Sam', 'private words', 'e1']];
  assert.equal((await call('/sheets/values', 'PUT', { rows, version })).status, 200);
  assert.deepEqual(written[0], [['Event', 'ID'], ['Robyn', 'e1']]);
  const base: any = await store.getSetting(SHEETS_BASE_SETTING);
  assert.ok(!JSON.stringify(base).includes('private words') && !JSON.stringify(base).includes('Sam'));

  // Signing out drops the base copy too.
  await call('/sheets/disconnect', 'POST');
  assert.equal((await (await call('/sheets')).json()).connected, false);
  assert.equal(((await store.getSetting(SHEETS_BASE_SETTING)) as any).rows, undefined);
});
