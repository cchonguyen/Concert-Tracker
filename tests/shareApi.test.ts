import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import type { PipelineDeps } from '../src/server/lineup/pipeline.ts';
import { shareRouter } from '../src/server/share/routes.ts';
import { frontDoor } from '../src/server/share/door.ts';
import { hashShareCode } from '../src/server/share/links.ts';
import { SHARE_HEADERS } from '../src/server/share/page.ts';

const NOW = new Date('2026-10-28T12:00:00Z');
const settings = { displayName: 'Owner', timeZone: 'UTC', showDates: true, showVenues: true, showFormat: false };

async function setup(t: { after: (fn: () => void) => void }) {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'share-api-')));
  await store.putEvents([
    {
      id: 'a',
      input: 'a',
      name: 'PAST_SHOW',
      startDate: '2025-03-01',
      sources: {},
      details: { status: 'resolved', candidates: [], notes: [] },
      seen: [],
      daysAttended: [],
      companions: ['SECRET_FRIEND'],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ]);
  const app = express();
  app.use(express.json());
  app.use('/api', shareRouter({ store, now: () => NOW } as unknown as PipelineDeps));
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await dispatch(app, { method, url: `/api${route}`, body });
    return { status: res.status, headers: res.headers, text: res.body };
  };
  const open = async (code: string) =>
    (await frontDoor(new Request(`https://concert.example.com/s/${code}`), { store: async () => store, access: null, now: () => NOW }))!.status;
  return { store, call, open };
}

test('the owner makes, changes and turns off a link; the code is returned once and never stored', async (t) => {
  const { store, call, open } = await setup(t);
  assert.equal(JSON.parse((await call('GET', '/share')).text).link, null);

  const made = await call('POST', '/share', { settings });
  assert.equal(made.status, 200);
  const { link, code } = JSON.parse(made.text);
  assert.match(code, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(link.settings.displayName, 'Owner');
  assert.equal(link.codeHash, undefined, 'hash sent to the browser');
  const stored = JSON.stringify(await store.listShareLinks());
  assert.ok(!stored.includes(code), 'code stored');
  assert.ok(stored.includes(await hashShareCode(code)));
  assert.equal(await open(code), 200);

  const status = JSON.parse((await call('GET', '/share')).text);
  assert.equal(status.link.id, link.id);
  assert.equal(status.code, undefined, 'code returned again');

  const changed = await call('PUT', '/share/settings', { settings: { ...settings, displayName: 'Someone', showVenues: false } });
  assert.equal(JSON.parse(changed.text).link.settings.displayName, 'Someone');

  // A new link stops the old one.
  const again = JSON.parse((await call('POST', '/share', { settings })).text);
  assert.equal(await open(code), 404);
  assert.equal(await open(again.code), 200);

  assert.equal((await call('DELETE', '/share')).status, 200);
  assert.equal(await open(again.code), 404);
  assert.equal(JSON.parse((await call('GET', '/share')).text).link, null);
});

test('bad settings are refused, and settings need an active link', async (t) => {
  const { call } = await setup(t);
  assert.equal((await call('POST', '/share', { settings: { ...settings, displayName: '' } })).status, 400);
  assert.equal((await call('POST', '/share', { settings: { ...settings, timeZone: 'Not/AZone' } })).status, 400);
  assert.equal((await call('POST', '/share', { settings: { ...settings, displayName: 'x'.repeat(61) } })).status, 400);
  assert.equal((await call('PUT', '/share/settings', { settings })).status, 404);
});

test('the preview is the active link\'s page with the share headers', async (t) => {
  const { call } = await setup(t);
  assert.equal((await call('GET', '/share/preview')).status, 404);
  await call('POST', '/share', { settings });
  const res = await call('GET', '/share/preview');
  assert.equal(res.status, 200);
  for (const [k, v] of Object.entries(SHARE_HEADERS)) assert.equal(res.headers.get(k), v, k);
  assert.ok(res.text.includes('PAST_SHOW'));
  assert.ok(!res.text.includes('SECRET_FRIEND'));
});
