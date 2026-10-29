import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
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

test('a milestone is one of the milestone counts or 0', () => {
  assert.equal(cleanMilestone(0), 0);
  assert.equal(cleanMilestone(250), 250);
  assert.throws(() => cleanMilestone(7), PrefsError);
  assert.throws(() => cleanMilestone('100'), PrefsError);
});

async function setup(t: { after: (fn: () => void) => void }) {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'prefs-')));
  const app = express();
  app.use(express.json());
  app.use('/api', prefsRouter(store));
  const listening = app.listen(0);
  await new Promise((resolve) => listening.once('listening', resolve));
  t.after(() => listening.close());
  const base = `http://127.0.0.1:${(listening.address() as AddressInfo).port}/api/me/prefs`;
  const call = async (method: string, body?: unknown) => {
    const res = await fetch(base, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return call;
}

test('an account with nothing saved reads no tips and no milestone', async (t) => {
  const call = await setup(t);
  assert.deepEqual(await call('GET'), { status: 200, body: { tips: null, milestone: 0 } });
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

test('the milestone only moves up, so an older browser cannot bring the card back', async (t) => {
  const call = await setup(t);
  await call('PUT', { milestone: 100 });
  assert.equal((await call('PUT', { milestone: 50 })).body.milestone, 100);
  assert.equal((await call('PUT', { milestone: 250 })).body.milestone, 250);
});

test('a milestone that is not a milestone count is refused', async (t) => {
  const call = await setup(t);
  assert.equal((await call('PUT', { milestone: 42 })).status, 400);
  assert.equal((await call('GET')).body.milestone, 0);
});
