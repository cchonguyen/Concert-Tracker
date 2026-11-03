import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { lineupRouter } from '../src/server/lineup/routes.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';

async function withApp(member: { role: string; uid: string }, fn: (base: string, store: FileLineupStore, kicks: string[]) => Promise<void>) {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'canon-ingest-')));
  const kicks: string[] = [];
  const deps = { store, now: () => new Date('2026-11-03T12:00:00Z') } as any;
  const runner = { kick: async (id: string) => void kicks.push(id) } as any;
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runAsMember(member as any, store as any, next));
  app.use('/api', lineupRouter(deps, runner));
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`, store, kicks);
  } finally {
    server.close();
  }
}

const body = { name: 'Portola Music Festival', year: 2024, startDate: '2024-09-28', venue: 'Pier 80', city: 'San Francisco, CA' };

test('owner starts a canonical lookup with no event: job has no eventId and is queued', async () => {
  await withApp({ role: 'owner', uid: 'u0' }, async (base, store, kicks) => {
    const res = await fetch(`${base}/api/manage/canonical/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 201);
    const { job } = (await res.json()) as any;
    assert.equal(job.eventId, undefined);
    assert.equal(job.input.eventName, 'Portola Music Festival');
    assert.equal(job.editionKey, 'portola-music-festival/2024-09-28');
    assert.deepEqual(kicks, [job.id]);
    assert.equal((await store.listEvents()).length, 0, 'no personal log entry is created');
  });
});

test('member gets 403 and no job is created', async () => {
  await withApp({ role: 'member', uid: 'u1' }, async (base, store, kicks) => {
    const res = await fetch(`${base}/api/manage/canonical/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 403);
    assert.deepEqual(kicks, []);
    assert.deepEqual(await store.listJobs(10), []);
  });
});

test('owner with a missing name or bad year gets 400', async () => {
  await withApp({ role: 'owner', uid: 'u0' }, async (base) => {
    const res = await fetch(`${base}/api/manage/canonical/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ year: 2024 }),
    });
    assert.equal(res.status, 400);
    const bad = await fetch(`${base}/api/manage/canonical/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', year: 1800 }),
    });
    assert.equal(bad.status, 400);
  });
});

test('members cannot start an event-less lookup through POST /api/lookups', async () => {
  await withApp({ role: 'member', uid: 'u1' }, async (base, store, kicks) => {
    const res = await fetch(`${base}/api/lookups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 403);
    assert.deepEqual(kicks, []);
    assert.deepEqual(await store.listJobs(10), []);
  });
});
