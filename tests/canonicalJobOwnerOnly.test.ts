import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { lineupRouter } from '../src/server/lineup/routes.ts';
import { createLookup } from '../src/server/lineup/pipeline.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';

// A lookup with no saved event (canonical ingest) can be run or confirmed by the owner only.
async function withApp(member: { role: string; uid: string }, fn: (base: string, jobId: string, kicks: string[]) => Promise<void>) {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'canon-job-owner-')));
  const now = () => new Date('2026-11-03T12:00:00Z');
  const deps = { store, now } as any;
  const kicks: string[] = [];
  const runner = { kick: async (id: string) => void kicks.push(id) } as any;
  const job = await createLookup(deps, { eventName: 'Portola Music Festival', year: 2024, startDate: '2024-09-28' } as any);
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runAsMember(member as any, store as any, next));
  app.use('/api', lineupRouter(deps, runner));
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`, job.id, kicks);
  } finally {
    server.close();
  }
}

test('member cannot run an event-less lookup', async () => {
  await withApp({ role: 'member', uid: 'u1' }, async (base, id, kicks) => {
    const res = await fetch(`${base}/api/lookups/${id}/run`, { method: 'POST' });
    assert.equal(res.status, 403);
    assert.deepEqual(kicks, []);
  });
});

test('member cannot confirm an event-less lookup', async () => {
  await withApp({ role: 'member', uid: 'u1' }, async (base, id) => {
    const res = await fetch(`${base}/api/lookups/${id}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403);
  });
});

test('owner can run an event-less lookup', async () => {
  await withApp({ role: 'owner', uid: 'u0' }, async (base, id, kicks) => {
    const res = await fetch(`${base}/api/lookups/${id}/run`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(kicks, [id]);
  });
});
