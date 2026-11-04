import { dispatch } from './helpers/testApp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { cleanMilestone, cleanTips, prefsRouter, PrefsError } from '../src/server/auth/prefs.ts';

test('a tips choice keeps tile keys and a hidden flag', () => {
  assert.deepEqual(cleanTips({ dismissed: ['lineup', 'lineup', 'merge'], allHidden: false }), { dismissed: ['lineup', 'merge'], allHidden: false });
  assert.deepEqual(cleanTips({ dismissed: [], allHidden: true }), { dismissed: [], allHidden: true });
});

test('a tips choice with a bad shape is refused', () => {
  assert.throws(() => cleanTips(null), PrefsError);
  assert.throws(() => cleanTips({ dismissed: 'lineup', allHidden: false }), PrefsError);
  assert.throws(() => cleanTips({ dismissed: ['Not A Key!'], allHidden: false }), PrefsError);
  assert.throws(() => cleanTips({ dismissed: Array(21).fill('lineup'), allHidden: false }), PrefsError);
  assert.throws(() => cleanTips({ dismissed: [], allHidden: 'yes' }), PrefsError);
});

test('a milestone patch names a show count and an act count, or 0', () => {
  assert.deepEqual(cleanMilestone({ shows: 250 }), { shows: 250 });
  assert.deepEqual(cleanMilestone({ artists: 100 }), { artists: 100 });
  assert.deepEqual(cleanMilestone({ shows: 0, artists: 0 }), { shows: 0, artists: 0 });
  assert.throws(() => cleanMilestone({ shows: 7 }), PrefsError);
  assert.throws(() => cleanMilestone({ artists: 50 }), PrefsError);
  assert.throws(() => cleanMilestone(100), PrefsError);
});

async function setup(t: { after: (fn: () => void) => void }) {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'prefs-')));
  const app = express();
  app.use(express.json());
  app.use('/api', prefsRouter(store));
  const call = async (method: string, body?: unknown) => {
    const res = await dispatch(app, {
      method,
      url: '/api/me/prefs',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body,
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return call;
}

test('an account with nothing saved reads no tips and no milestone', async (t) => {
  const call = await setup(t);
  assert.deepEqual(await call('GET'), { status: 200, body: { tips: null, milestone: { shows: 0, artists: 0 } } });
});

test('tips saved on the account come back on the next read', async (t) => {
  const call = await setup(t);
  const saved = { dismissed: ['fill'], allHidden: false };
  assert.equal((await call('PUT', { tips: saved })).status, 200);
  assert.deepEqual((await call('GET')).body.tips, saved);
});

test('a bad tips choice is refused and changes nothing', async (t) => {
  const call = await setup(t);
  await call('PUT', { tips: { dismissed: ['fill'], allHidden: false } });
  const bad = await call('PUT', { tips: { dismissed: 'fill', allHidden: false } });
  assert.equal(bad.status, 400);
  assert.deepEqual((await call('GET')).body.tips, { dismissed: ['fill'], allHidden: false });
});

test('each milestone kind only moves up, so an older browser cannot bring the card back', async (t) => {
  const call = await setup(t);
  await call('PUT', { milestone: { shows: 100, artists: 100 } });
  assert.deepEqual((await call('PUT', { milestone: { shows: 50 } })).body.milestone, { shows: 100, artists: 100 });
  assert.deepEqual((await call('PUT', { milestone: { shows: 250 } })).body.milestone, { shows: 250, artists: 100 });
});

test('a milestone that is not a milestone count is refused', async (t) => {
  const call = await setup(t);
  assert.equal((await call('PUT', { milestone: { shows: 42 } })).status, 400);
  assert.deepEqual((await call('GET')).body.milestone, { shows: 0, artists: 0 });
});
