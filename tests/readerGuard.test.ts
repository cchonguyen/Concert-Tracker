import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaExhaustedError, QuotaLedger } from '../src/server/lineup/quota.ts';
import { readReaderConfig } from '../src/server/reader/config.ts';
import { BREAKER_KEY, checkGuards, dayKey, monthKey, recordOutcome } from '../src/server/reader/guard.ts';

const now = new Date('2026-11-13T12:00:00Z');

function fake(opts: { failRead?: boolean; failWrite?: boolean } = {}) {
  const m = new Map<string, { key: string; used: number; exhaustedUntil?: string }>();
  const writes: string[] = [];
  const store: any = {
    async getQuota(k: string) {
      if (opts.failRead) throw new Error('db down');
      return m.get(k) ?? null;
    },
    async setQuota(u: { key: string; used: number; exhaustedUntil?: string }) {
      if (opts.failWrite) throw new Error('db down');
      writes.push(u.key);
      m.set(u.key, u);
    },
  };
  return { store, m, writes };
}

const cfg = (env: Record<string, string> = {}) => readReaderConfig(env);
const base = (f: ReturnType<typeof fake>, env: Record<string, string> = {}, extra: object = {}) => ({
  store: f.store, config: cfg(env), provider: 'gemini' as const, model: 'gemini-3.5-flash-lite',
  inputChars: 3000, maxOutputTokens: 1000, jobKey: 'j1', now, ...extra,
});
const refusal = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as QuotaExhaustedError; }
  assert.fail('expected refusal');
};

test('guard 1 kill switch', async () => {
  const e = await refusal(checkGuards(base(fake(), { READER_ENABLED: 'off' })));
  assert.equal(e.reason, 'kill_switch');
  assert.equal(e.scope, 'global');
});

test('guard 2 breaker open parks until open-until', async () => {
  const f = fake();
  const until = new Date(now.getTime() + 600_000);
  f.m.set(BREAKER_KEY, { key: BREAKER_KEY, used: 5, exhaustedUntil: until.toISOString() });
  const e = await refusal(checkGuards(base(f)));
  assert.equal(e.reason, 'breaker_open');
  assert.equal(e.retryAt.getTime(), until.getTime());
  f.m.set(BREAKER_KEY, { key: BREAKER_KEY, used: 5, exhaustedUntil: new Date(now.getTime() - 1).toISOString() });
  assert.equal((await checkGuards(base(f))).ok, true);
});

test('guard 3 -latest refused only when provider explicit', async () => {
  const args = (env: Record<string, string>) => ({ ...base(fake(), env), model: 'gemini-flash-latest' });
  assert.equal((await refusal(checkGuards(args({ READER_PROVIDER: 'gemini' })))).reason, 'unpinned_model');
  assert.equal((await checkGuards(args({}))).ok, true);
  assert.equal((await checkGuards({ ...args({ READER_PROVIDER: 'gemini' }), model: 'gemini-4-hydrogen' })).ok, true);
});

test('guard 5 returns input_too_large, no throw, breaker untouched', async () => {
  const f = fake();
  const r = await checkGuards({ ...base(f), inputChars: 200001 });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'input_too_large');
    assert.deepEqual([r.usage.inputTokens, r.usage.outputTokens, r.usage.durationMs], [0, 0, 0]);
  }
  assert.equal(f.writes.length, 0);
  assert.equal(f.m.has(BREAKER_KEY), false);
});

test('guard 6 job cap throws job scope, breaker untouched', async () => {
  const f = fake();
  const env = { READER_MAX_CALLS_PER_JOB: '2' };
  await checkGuards(base(f, env));
  await checkGuards(base(f, env));
  const e = await refusal(checkGuards(base(f, env)));
  assert.equal(e.reason, 'job_cap');
  assert.equal(e.scope, 'job');
  assert.equal(f.m.has(BREAKER_KEY), false);
  assert.equal((await checkGuards({ ...base(f, env), jobKey: 'j2' })).ok, true);
});

test('guards 7 and 8 refuse on used + worst case > cap and open the breaker', async () => {
  const f = fake();
  f.m.set(dayKey(now), { key: dayKey(now), used: 499_000 });
  const e = await refusal(checkGuards(base(f)));
  assert.equal(e.reason, 'spend_day');
  assert.equal(e.scope, 'global');
  assert.ok(f.m.get(BREAKER_KEY)?.exhaustedUntil);
  const g = fake();
  g.m.set(monthKey(now), { key: monthKey(now), used: 4_999_000 });
  const e2 = await refusal(checkGuards(base(g)));
  assert.equal(e2.reason, 'spend_month');
  assert.equal(e2.retryAt.toISOString(), '2026-12-01T00:00:00.000Z');
  assert.ok(g.m.get(BREAKER_KEY)?.exhaustedUntil);
});

test('guard 9 calls cap opens the breaker; user scope does not', async () => {
  const f = fake();
  const quota = new QuotaLedger(f.store, { provider: 'gemini', model: 'm', dailyLimit: 1, perMinute: 10 });
  await checkGuards({ ...base(f), quota });
  const e = await refusal(checkGuards({ ...base(f), quota }));
  assert.equal(e.reason, 'calls_cap');
  assert.ok(f.m.get(BREAKER_KEY)?.exhaustedUntil);
  const g = fake();
  const q2 = new QuotaLedger(g.store, { provider: 'gemini', model: 'm', dailyLimit: 100, perMinute: 10, userDaily: 1 });
  const a = { ...base(g), quota: q2, quotaOptions: { userId: 'u1' } };
  await checkGuards(a);
  const e2 = await refusal(checkGuards(a));
  assert.equal(e2.scope, 'user');
  assert.equal(g.m.has(BREAKER_KEY), false);
});

test('force does not bypass guards 1 to 8', async () => {
  assert.equal((await refusal(checkGuards({ ...base(fake(), { READER_ENABLED: 'no' }), force: true }))).reason, 'kill_switch');
  const f = fake();
  f.m.set(dayKey(now), { key: dayKey(now), used: 499_000 });
  assert.equal((await refusal(checkGuards({ ...base(f), force: true }))).reason, 'spend_day');
});

test('pre-call spend check writes no spend keys; post-call writes once per key', async () => {
  const f = fake();
  const g = await checkGuards(base(f));
  assert.equal(g.ok, true);
  assert.ok(!f.writes.includes(dayKey(now)) && !f.writes.includes(monthKey(now)));
  f.writes.length = 0;
  await recordOutcome({
    store: f.store, config: cfg(), provider: 'gemini', model: 'gemini-3.5-flash-lite',
    outcome: 'success', usage: { inputTokens: 1_000_000, outputTokens: 0 }, worstCaseMicroUsd: 1, now,
  });
  assert.deepEqual(f.writes, [dayKey(now), monthKey(now)]);
  assert.equal(f.m.get(dayKey(now))?.used, 300_000);
  assert.equal(f.m.get(monthKey(now))?.used, 300_000);
});

test('post-call cost: worst case for success with null usage, 0 for failure', async () => {
  const f = fake();
  const a = { store: f.store, config: cfg(), provider: 'gemini' as const, model: 'm', usage: null, worstCaseMicroUsd: 777, now };
  await recordOutcome({ ...a, outcome: 'error' });
  assert.equal(f.m.has(dayKey(now)), false);
  await recordOutcome({ ...a, outcome: 'success' });
  assert.equal(f.m.get(dayKey(now))?.used, 777);
});

test('breaker opens at N consecutive failures; success resets', async () => {
  const f = fake();
  const a = { store: f.store, config: cfg({ READER_BREAKER_FAILURES: '3' }), provider: 'gemini' as const, model: 'm', usage: null, worstCaseMicroUsd: 1, now };
  for (const o of ['error', 'invalid_json'] as const) await recordOutcome({ ...a, outcome: o });
  assert.equal(f.m.get(BREAKER_KEY)?.exhaustedUntil, undefined);
  await recordOutcome({ ...a, outcome: 'success' });
  assert.equal(f.m.get(BREAKER_KEY)?.used, 0);
  for (const o of ['error', 'busy', 'error'] as const) await recordOutcome({ ...a, outcome: o });
  assert.equal(f.m.get(BREAKER_KEY)?.exhaustedUntil, new Date(now.getTime() + 30 * 60_000).toISOString());
});

test('provider quota error opens the breaker at once until retryAt', async () => {
  const f = fake();
  const retryAt = new Date(now.getTime() + 6 * 3600_000);
  await recordOutcome({ store: f.store, config: cfg(), provider: 'gemini', model: 'm', outcome: 'quota', usage: null, worstCaseMicroUsd: 1, retryAt, now });
  assert.equal(f.m.get(BREAKER_KEY)?.exhaustedUntil, retryAt.toISOString());
});

test('fail closed on ledger read and write errors', async () => {
  const e = await refusal(checkGuards(base(fake({ failRead: true }))));
  assert.equal(e.reason, 'guard_unavailable');
  assert.equal(e.scope, 'global');
  const w = await refusal(checkGuards(base(fake({ failWrite: true }))));
  assert.equal(w.reason, 'guard_unavailable');
  const r = await refusal(recordOutcome({ store: fake({ failWrite: true }).store, config: cfg(), provider: 'gemini', model: 'm', outcome: 'success', usage: null, worstCaseMicroUsd: 5, now }));
  assert.equal(r.reason, 'guard_unavailable');
});
