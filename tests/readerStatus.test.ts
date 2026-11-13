import { dispatch } from './helpers/testApp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { lineupRouter } from '../src/server/lineup/routes.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';
import { BREAKER_KEY, callsMonthKey, dayKey, monthKey, recordOutcome } from '../src/server/reader/guard.ts';
import { readReaderConfig } from '../src/server/reader/config.ts';

const now = new Date('2026-11-13T12:00:00Z');

async function status(role: string, opts: { reader?: boolean; seed?: (s: FileLineupStore) => Promise<void> } = {}) {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'reader-status-')));
  await opts.seed?.(store);
  const deps = {
    store,
    now: () => now,
    adapters: [],
    lateAdapters: [],
    gemini: null,
    quota: null,
    reader: opts.reader === false ? null : { provider: 'gemini', model: 'gemini-3.5-flash-lite' },
  } as any;
  const app = express();
  app.use((_req, _res, next) => runAsMember({ role, uid: 'u1' } as any, store as any, next));
  app.use('/api', lineupRouter(deps, { kick: async () => {} } as any));
  return (await dispatch(app, { url: '/api/lineup/status' })).json();
}

const seed = async (s: FileLineupStore) => {
  await s.setQuota({ key: dayKey(now), used: 250_000 });
  await s.setQuota({ key: monthKey(now), used: 1_500_000 });
  await s.setQuota({ key: callsMonthKey(now), used: 7 });
  await s.setQuota({ key: 'reader:logfail:2026-11-13', used: 2 });
  await s.setQuota({ key: BREAKER_KEY, used: 5, exhaustedUntil: '2026-11-13T12:30:00.000Z' });
  await s.addAiCall({
    id: 'c1', createdAt: '2026-11-13T11:00:00Z', feature: 'lineup_extract', jobId: 'j', eventId: null, userId: null,
    provider: 'gemini', model: 'm', sourceDocumentId: 'doc', inputChars: 100, inputTokens: 30, outputTokens: 10,
    estCostUsd: 0.001, durationMs: 5, outcome: 'ok', errorCode: null, guardReason: null,
    namesReturned: 3, namesVerbatim: 3, namesRejected: 0,
  });
};

test('owner gets the full reader shape', async () => {
  const body = await status('owner', { seed });
  assert.ok('gemini' in body && 'quota' in body && 'sources' in body);
  const r = body.reader;
  assert.equal(r.provider, 'gemini');
  assert.equal(r.model, 'gemini-3.5-flash-lite');
  assert.equal(r.thinkingLevel, 'LOW');
  assert.equal(r.enabled, true);
  assert.equal(r.callsMonth, 7);
  assert.equal(r.callsToday, 0);
  assert.equal(r.spendTodayUsd, 0.25);
  assert.equal(r.spendMonthUsd, 1.5);
  assert.deepEqual(r.caps, { dayUsd: 0.5, monthUsd: 5, perJob: 6, inputChars: 200000, outputTokens: 8192 });
  assert.equal(r.logWriteFailuresToday, 2);
  assert.equal(r.recent.length, 1);
  assert.equal(r.recent[0].outcome, 'ok');
  assert.equal('sourceDocumentId' in r.recent[0], false);
});

test('breaker open reports until and failures; expired breaker reads closed', async () => {
  const open = await status('owner', { seed });
  assert.deepEqual(open.reader.breaker, { open: true, until: '2026-11-13T12:30:00.000Z', failures: 5 });
  const closed = await status('owner', { seed: async (s) => s.setQuota({ key: BREAKER_KEY, used: 2, exhaustedUntil: '2026-11-13T11:00:00.000Z' }) });
  assert.deepEqual(closed.reader.breaker, { open: false, failures: 2 });
});

test('member gets the summary without recent, spend, caps or log failures', async () => {
  const r = (await status('member', { seed })).reader;
  assert.equal(r.provider, 'gemini');
  assert.equal(r.callsMonth, 7);
  assert.equal(r.breaker.open, true);
  for (const k of ['recent', 'spendTodayUsd', 'spendMonthUsd', 'caps', 'logWriteFailuresToday']) assert.equal(k in r, false, k);
});

test('no reader field when no reader is configured', async () => {
  const body = await status('owner', { reader: false });
  assert.equal('reader' in body, false);
  assert.ok('quota' in body);
});

test('recordOutcome adds one to the month calls counter per call', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'reader-status-')));
  const config = readReaderConfig({});
  for (const outcome of ['success', 'error'] as const) {
    await recordOutcome({ store, config, provider: 'gemini', model: 'm', outcome, usage: null, worstCaseMicroUsd: 0, now });
  }
  assert.equal((await store.getQuota(callsMonthKey(now)))?.used, 2);
});
