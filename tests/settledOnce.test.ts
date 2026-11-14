import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settledOnce } from '../src/server/settledOnce.ts';

test('settledOnce: runs the start-up once and returns the finished value afterwards', async () => {
  let calls = 0;
  const once = settledOnce(async (n: number) => {
    calls++;
    return n * 2;
  });
  assert.equal(await once.get(2), 4);
  assert.equal(await once.get(9), 4);
  assert.equal(calls, 1);
});

test('settledOnce: never hands back a promise another request is running', async () => {
  let release!: () => void;
  const once = settledOnce(() => new Promise<string>((r) => (release = () => r('ready'))), { pollMs: 1 });
  const first = once.get();
  // A second caller must get its own promise, not the first caller's.
  const second = once.get();
  assert.notStrictEqual(first, second);
  release();
  assert.equal(await first, 'ready');
  assert.equal(await second, 'ready');
});

test('settledOnce: a start whose request has ended is taken over, not waited on forever', async () => {
  let calls = 0;
  const once = settledOnce(
    () => {
      calls++;
      return calls === 1 ? new Promise<string>(() => {}) : Promise.resolve('second');
    },
    { pollMs: 1, staleMs: 10 },
  );
  void once.get(); // never settles, like a request that ended
  assert.equal(await once.get(), 'second');
});

test('settledOnce: a failed start is retried by the next caller', async () => {
  let calls = 0;
  const once = settledOnce(async () => {
    if (++calls === 1) throw new Error('boom');
    return 'ok';
  });
  await assert.rejects(once.get(), /boom/);
  assert.equal(await once.get(), 'ok');
});
