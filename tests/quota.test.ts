import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nextPacificMidnight, parseRateLimitError, QuotaExhaustedError, QuotaLedger } from '../src/server/lineup/quota.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';

test('daily reset is midnight Pacific in both DST states', () => {
  assert.equal(nextPacificMidnight(new Date('2025-07-01T12:00:00Z')).toISOString(), '2025-07-02T07:00:00.000Z');
  assert.equal(nextPacificMidnight(new Date('2025-01-15T12:00:00Z')).toISOString(), '2025-01-16T08:00:00.000Z');
});

test('429 parsing distinguishes daily and per-minute limits', () => {
  const now = new Date('2025-07-01T12:00:00Z');
  const daily = parseRateLimitError({ status: 429, message: 'quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier' }, now);
  assert.equal(daily?.retryAt.toISOString(), '2025-07-02T07:00:00.000Z');
  const minute = parseRateLimitError({ status: 429, message: '{"retryDelay": "34s"}' }, now);
  assert.equal(minute?.retryAt.toISOString(), '2025-07-01T12:00:35.000Z');
  assert.equal(parseRateLimitError(new Error('500 internal'), now), null);
});

test('ledger refuses calls past the daily budget', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'quota-')));
  const ledger = new QuotaLedger(store, { provider: 'gemini', model: 'm', dailyLimit: 2, perMinute: 100 });
  const now = new Date('2025-07-01T12:00:00Z');
  await ledger.acquire(now);
  await ledger.acquire(now);
  await assert.rejects(ledger.acquire(now), QuotaExhaustedError);
  assert.equal((await ledger.status(now)).used, 2);
});
