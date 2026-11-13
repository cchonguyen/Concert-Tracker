import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTrace, scrubDetail, resetTraceFailureMemory } from '../src/server/telemetry/trace';
import { FileLineupStore } from '../src/server/lineup/store/fileStore';
import type { IngestTraceRow } from '../src/server/lineup/store/types';

test('scrub drops personal-looking keys, long strings and non-primitives', () => {
  const d = scrubDetail({ companions: 'x', notes: 'x', rating: 5, price: 1, attendance: 'y', text: 'z', body: 'b', quote: 'q', prompt: 'p', count: 3, source: 's'.repeat(300), obj: { a: 1 }, ok: true });
  assert.deepEqual(Object.keys(d!).sort(), ['count', 'ok', 'source']);
  assert.equal((d!.source as string).length, 200);
});

test('steps keep order and finish writes one row', async () => {
  resetTraceFailureMemory();
  const rows: IngestTraceRow[] = [];
  const t = startTrace('research', { eventId: 'e1' });
  t.step('a'); t.step('b', { n: 2 }); t.subrequests(7); t.cost(120);
  const store = { addIngestTrace: async (r: IngestTraceRow) => void rows.push(r) };
  await t.finish(store);
  await t.finish(store);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].steps.map((s) => s.name), ['a', 'b']);
  assert.equal(rows[0].subrequests, 7);
  assert.equal(rows[0].aiCostMicros, 120);
  assert.equal(rows[0].eventId, 'e1');
});

test('finish never throws when the store throws, and does not retry for a while', async () => {
  resetTraceFailureMemory();
  let calls = 0;
  const bad = { addIngestTrace: async () => { calls++; throw new Error('relation "ingest_traces" does not exist'); } };
  await startTrace('save').finish(bad);
  await startTrace('save').finish(bad);
  assert.equal(calls, 1);
  await startTrace('save').finish(undefined);
  resetTraceFailureMemory();
});

test('file store round trip, newest first', async () => {
  resetTraceFailureMemory();
  const store = new FileLineupStore(mkdtempSync(join(tmpdir(), 'trace-')));
  const t1 = startTrace('lookup', { jobId: 'j1' }); t1.step('x', { status: 'ok' });
  await t1.finish(store);
  await new Promise((r) => setTimeout(r, 5));
  await startTrace('backfill').finish(store);
  const rows = await store.listIngestTraces(10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].trigger, 'backfill');
  assert.equal(rows[1].jobId, 'j1');
  assert.deepEqual(rows[1].steps[0].detail, { status: 'ok' });
});
