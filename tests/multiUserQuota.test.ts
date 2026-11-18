import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { roundRobin } from '../src/server/lineup/store/types.ts';
import { QuotaExhaustedError, QuotaLedger } from '../src/server/lineup/quota.ts';
import type { LookupJob } from '../src/server/lineup/types.ts';

const NOW = new Date('2026-10-29T18:00:00Z');
const job = (id: string, userId: string | undefined, createdAt: string): LookupJob => ({
  id, userId, kind: 'lineup', input: { eventName: id } as any, editionKey: id, status: 'queued', stage: 'collect', attempts: 0,
  pendingExtraction: [], discoveryDone: false, facts: {}, log: [], createdAt, updatedAt: createdAt,
});

async function ledger(config: { dailyLimit?: number; ownerReserve?: number; userDaily?: number }, owner: string | null = 'owner') {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'mu-quota-')));
  (store as any).ownerUserId = async () => owner;
  return { store, quota: new QuotaLedger(store, { provider: 'gemini', model: 'm', dailyLimit: 10, perMinute: 1000, ...config }) };
}

const refused = (p: Promise<unknown>) => p.then(() => null, (e) => e as QuotaExhaustedError);

test('turns: due jobs go one member at a time, oldest first, and a single owner keeps plain order', () => {
  const jobs = [
    job('a1', 'ann', '2026-01-01T00:00:01Z'), job('a2', 'ann', '2026-01-01T00:00:02Z'), job('a3', 'ann', '2026-01-01T00:00:03Z'),
    job('b1', 'bob', '2026-01-01T00:00:04Z'), job('o1', 'owner', '2026-01-01T00:00:05Z'),
  ];
  assert.deepEqual(roundRobin(jobs, 10).map((j) => j.id), ['a1', 'b1', 'o1', 'a2', 'a3']);
  assert.deepEqual(roundRobin(jobs, 3).map((j) => j.id), ['a1', 'b1', 'o1']);
  const solo = [job('x2', undefined, '2026-01-01T00:00:02Z'), job('x1', undefined, '2026-01-01T00:00:01Z')];
  assert.deepEqual(roundRobin(solo, 5).map((j) => j.id), ['x1', 'x2']);
});

test('file store: dueJobs gives each member a turn', async () => {
  const s = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'mu-due-')));
  for (const j of [job('a1', 'ann', '2026-01-01T00:00:01Z'), job('a2', 'ann', '2026-01-01T00:00:02Z'), job('b1', 'bob', '2026-01-01T00:00:03Z')]) await s.createJob(j);
  assert.deepEqual((await s.dueJobs(NOW, 2)).map((j) => j.id), ['a1', 'b1']);
});

test('quota: with no member (single owner) nothing changes', async () => {
  const { quota } = await ledger({ userDaily: 1, ownerReserve: 5 });
  for (let i = 0; i < 10; i++) await quota.acquire(NOW);
  assert.ok((await refused(quota.acquire(NOW)))?.reason.includes('Daily Gemini budget'));
});

test('quota: a member over their daily cap is parked alone, scoped to them; others and the owner carry on', async () => {
  const { quota } = await ledger({ userDaily: 2 });
  await quota.acquire(NOW, { userId: 'ann' });
  await quota.acquire(NOW, { userId: 'ann' });
  const err = await refused(quota.acquire(NOW, { userId: 'ann' }));
  assert.equal(err?.scope, 'user');
  assert.ok(err?.reason.startsWith('Your daily limit of 2'));
  assert.ok(err!.retryAt > NOW);
  await quota.acquire(NOW, { userId: 'bob' });
  await quota.acquire(NOW, { userId: 'owner' });
  assert.equal((await quota.status(NOW)).used, 4);
});

test('quota: members stop at the owner\'s reserve; the owner can use it', async () => {
  const { quota } = await ledger({ ownerReserve: 3 });
  for (let i = 0; i < 7; i++) await quota.acquire(NOW, { userId: i % 2 ? 'ann' : 'bob' });
  const err = await refused(quota.acquire(NOW, { userId: 'ann' }));
  assert.equal(err?.scope, 'user');
  assert.ok(err?.reason.includes('reserve'));
  for (let i = 0; i < 3; i++) await quota.acquire(NOW, { userId: 'owner' });
  assert.ok((await refused(quota.acquire(NOW, { userId: 'owner' })))?.scope === 'global');
});

test('quota: the owner is exempt from the member daily cap but not from the shared budget', async () => {
  const { quota } = await ledger({ userDaily: 2, dailyLimit: 5 });
  for (let i = 0; i < 5; i++) await quota.acquire(NOW, { userId: 'owner' });
  const err = await refused(quota.acquire(NOW, { userId: 'owner' }));
  assert.equal(err?.scope, 'global');
  assert.equal((await quota.status(NOW)).used, 5);
});

test('quota: counts reset the next Pacific day', async () => {
  const { quota } = await ledger({ userDaily: 1 });
  await quota.acquire(NOW, { userId: 'ann' });
  assert.ok(await refused(quota.acquire(NOW, { userId: 'ann' })));
  await quota.acquire(new Date('2026-10-30T18:00:00Z'), { userId: 'ann' });
});

test('quota: the background lane has its own per-member cap and does not use up the interactive one', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'mu-lane-')));
  const quota = new QuotaLedger(store, { provider: 'gemini', model: 'm', dailyLimit: 20, perMinute: 1000, userDaily: 5, userBackfillDaily: 3 });
  for (let i = 0; i < 3; i++) await quota.acquire(NOW, { userId: 'ann', lane: 'backfill' });
  const err = await refused(quota.acquire(NOW, { userId: 'ann', lane: 'backfill' }));
  assert.equal(err?.scope, 'user');
  assert.ok(err?.reason.includes('background'));
  for (let i = 0; i < 5; i++) await quota.acquire(NOW, { userId: 'ann' });
  assert.ok(await refused(quota.acquire(NOW, { userId: 'ann' })));
});
