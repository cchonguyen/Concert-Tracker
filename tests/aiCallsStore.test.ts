import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import type { AiCallRow } from '../src/server/lineup/store/types.ts';

const row = (id: string, createdAt: string): AiCallRow => ({
  id,
  createdAt,
  feature: 'lineup_extract',
  jobId: null,
  eventId: null,
  userId: null,
  provider: 'gemini',
  model: 'm',
  sourceDocumentId: null,
  inputChars: 100,
  inputTokens: null,
  outputTokens: null,
  estCostUsd: null,
  durationMs: 5,
  outcome: 'ok',
  errorCode: null,
  guardReason: null,
  namesReturned: 3,
  namesVerbatim: 2,
  namesRejected: 1,
});

test('ai calls round-trip: add, list newest first with limit, delete before cutoff', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aicalls-'));
  const store = new FileLineupStore(dir);
  await store.addAiCall(row('b', '2026-02-01T00:00:00.000Z'));
  await store.addAiCall(row('a', '2026-01-01T00:00:00.000Z'));
  await store.addAiCall(row('c', '2026-03-01T00:00:00.000Z'));
  assert.deepEqual((await store.listAiCalls(10)).map((r) => r.id), ['c', 'b', 'a']);
  assert.deepEqual((await store.listAiCalls(2)).map((r) => r.id), ['c', 'b']);
  assert.deepEqual(await store.listAiCalls(1), [row('c', '2026-03-01T00:00:00.000Z')]);
  assert.equal(await store.deleteAiCallsBefore(new Date('2026-02-01T00:00:00.000Z')), 1);
  assert.deepEqual((await new FileLineupStore(dir).listAiCalls(10)).map((r) => r.id), ['c', 'b']);
  assert.equal(await store.deleteAiCallsBefore(new Date('2026-01-01T00:00:00.000Z')), 0);
});
