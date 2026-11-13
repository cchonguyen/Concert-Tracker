import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { PipelineDeps, enqueueArtistResolution, isRequeueTime, requeueFailedResolveArtists, runJob } from '../src/server/lineup/pipeline.ts';
import { Fetcher, FetchResponse } from '../src/server/lineup/types.ts';

const T0 = new Date('2026-11-13T12:00:00Z');

async function setup(respond: (url: string) => Partial<FetchResponse> | Error, artists = ['Kaskade', 'Dom Dolla']) {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'mbretry-')));
  for (const name of artists) await store.upsertArtist({ key: name.toLowerCase(), name });
  let clock = T0;
  const calls: string[] = [];
  const fetcher: Fetcher = {
    async get(url) {
      calls.push(url);
      const r = respond(url);
      if (r instanceof Error) throw r;
      return { url, status: 200, headers: {}, body: '{"artists":[]}', ...r };
    },
  };
  const deps = { store, fetcher, quota: null, search: null, now: () => clock } as unknown as PipelineDeps;
  return { store, deps, calls, setClock: (d: Date) => (clock = d) };
}

async function jobOf(deps: PipelineDeps) {
  await enqueueArtistResolution(deps);
  return (await deps.store.listJobs(10))[0];
}

test('a MusicBrainz 503 parks the job with a retry time and does not fail it', async () => {
  const { deps, store } = await setup(() => ({ status: 503, body: '' }));
  const job = await jobOf(deps);
  const out = (await runJob(deps, job.id))!;
  assert.equal(out.status, 'waiting_quota');
  assert.equal(out.attempts, 0);
  assert.equal(out.nextAttemptAt, new Date(T0.getTime() + 5 * 60_000).toISOString());
  assert.match(out.waitingReason ?? '', /503/);
  assert.equal((await store.listUnresolvedArtists(10)).length, 2);
});

test('502, 504 and a network timeout also park', async () => {
  for (const r of [{ status: 502 }, { status: 504 }, new Error('Could not reach musicbrainz.org (ETIMEDOUT)')]) {
    const { deps } = await setup(() => r as Error);
    const out = (await runJob(deps, (await jobOf(deps)).id))!;
    assert.equal(out.status, 'waiting_quota');
    assert.ok(out.nextAttemptAt);
  }
});

test('429 honors a longer Retry-After', async () => {
  const { deps } = await setup(() => ({ status: 429, headers: { 'retry-after': '1200' }, body: '' }));
  const out = (await runJob(deps, (await jobOf(deps)).id))!;
  assert.equal(out.nextAttemptAt, new Date(T0.getTime() + 1200_000).toISOString());
});

test('repeated 503 backs off and success resets', async () => {
  let down = true;
  const { deps, setClock } = await setup(() => (down ? { status: 503, body: '' } : { status: 200 }));
  const id = (await jobOf(deps)).id;
  const gaps: number[] = [];
  let at = T0;
  for (let i = 0; i < 3; i++) {
    setClock(at);
    const out = (await runJob(deps, id))!;
    assert.equal(out.status, 'waiting_quota');
    const next = new Date(out.nextAttemptAt!);
    gaps.push(next.getTime() - at.getTime());
    at = next;
  }
  assert.deepEqual(gaps, [5 * 60_000, 10 * 60_000, 20 * 60_000]);
  down = false;
  setClock(at);
  const ok = (await runJob(deps, id))!;
  assert.equal(ok.status, 'confirmed');
  assert.equal(ok.attempts, 0);
});

test('progress already saved is kept when a later artist hits a 503', async () => {
  const { deps, store } = await setup((url) => (url.includes('Dom%20Dolla') ? { status: 503, body: '' } : { status: 200 }));
  const out = (await runJob(deps, (await jobOf(deps)).id))!;
  assert.equal(out.status, 'waiting_quota');
  assert.equal((await store.listUnresolvedArtists(10)).length, 1);
});

test('a 404 does not park: it fails through the normal retry path', async () => {
  const { deps } = await setup(() => ({ status: 404, body: '' }));
  const out = (await runJob(deps, (await jobOf(deps)).id))!;
  assert.equal(out.status, 'queued');
  assert.equal(out.attempts, 1);
  assert.match(out.lastError ?? '', /404/);
});

test('re-queue is idempotent and touches only failed 503 resolve_artists jobs', async () => {
  const { deps, store } = await setup(() => ({ status: 200 }));
  const seen = new Set<string>();
  const mk = async (over: Record<string, unknown>) => {
    await enqueueArtistResolution(deps);
    const j = (await store.listJobs(50)).find((x) => !seen.has(x.id))!;
    seen.add(j.id);
    Object.assign(j, over);
    await store.updateJob(j);
    return j.id;
  };
  const target = await mk({ status: 'failed', attempts: 3, lastError: 'HTTP 503 for https://musicbrainz.org/ws/2/artist/' });
  const other404 = await mk({ status: 'failed', attempts: 3, lastError: 'HTTP 404 for https://musicbrainz.org/x' });
  const queued = await mk({ status: 'queued' });
  const lineup = await mk({ status: 'failed', kind: 'lineup', lastError: 'HTTP 503 from somewhere' });

  assert.deepEqual(await requeueFailedResolveArtists(deps), [target]);
  const t = (await store.getJob(target))!;
  assert.equal(t.status, 'waiting_quota');
  assert.ok(t.nextAttemptAt);
  assert.equal((await store.getJob(other404))!.status, 'failed');
  assert.equal((await store.getJob(queued))!.status, 'queued');
  assert.equal((await store.getJob(lineup))!.status, 'failed');

  // Fails again on a 503 later: still never re-queued a second time.
  t.status = 'failed';
  t.lastError = 'HTTP 503 again';
  await store.updateJob(t);
  assert.deepEqual(await requeueFailedResolveArtists(deps), []);
  assert.equal((await store.getJob(target))!.status, 'failed');
});

test('the hourly re-queue runs only on the minute-0 cron run', () => {
  assert.equal(isRequeueTime(new Date('2026-11-13T12:00:30Z')), true);
  assert.equal(isRequeueTime(new Date('2026-11-13T12:01:00Z')), false);
  assert.equal(isRequeueTime(new Date('2026-11-13T12:59:00Z')), false);
});
