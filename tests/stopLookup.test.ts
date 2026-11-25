import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLookup, runJob, stopJob, type PipelineDeps } from '../src/server/lineup/pipeline.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { fakeFetcher } from './fakes.ts';

async function deps(): Promise<PipelineDeps> {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'stop-')));
  const { fetcher } = fakeFetcher({});
  return { store, fetcher, adapters: [], lateAdapters: [], gemini: null, quota: null, reader: null, search: null, now: () => new Date('2026-11-25T07:00:00Z') };
}

test('a parked lookup can be stopped: it becomes failed with a note and never runs again on its own', async () => {
  const d = await deps();
  const job = await createLookup(d, { eventName: 'Together As One', year: 2024, startDate: '2024-12-31' });
  await d.store.updateJob({ ...job, status: 'waiting_quota', waitingReason: 'Paused: Brave Search limit reached.', nextAttemptAt: '2026-12-01T00:00:00Z' });
  const stopped = await stopJob(d, job.id);
  assert.equal(stopped?.status, 'failed');
  assert.equal(stopped?.lastError, 'Stopped by you.');
  assert.equal(stopped?.waitingReason, undefined);
  assert.equal(stopped?.nextAttemptAt, undefined);
  assert.ok(stopped?.log.at(-1)?.message.startsWith('Stopped by the owner'));
  const after = await runJob(d, job.id);
  assert.equal(after?.status, 'failed');
});

test('a queued lookup can be stopped; a finished one cannot; a missing one gives null', async () => {
  const d = await deps();
  const job = await createLookup(d, { eventName: 'Some Festival', year: 2024 });
  assert.equal((await stopJob(d, job.id))?.status, 'failed');
  await assert.rejects(() => stopJob(d, job.id), /queued or waiting/);
  assert.equal(await stopJob(d, 'nope'), null);
});
