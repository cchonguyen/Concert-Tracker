import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaExhaustedError, QuotaLedger } from '../src/server/lineup/quota.ts';
import { readReaderConfig } from '../src/server/reader/config.ts';
import { checkGuards, recordOutcome, BREAKER_KEY } from '../src/server/reader/guard.ts';
import { logCall } from '../src/server/reader/callLog.ts';
import { createGuardedReader } from '../src/server/reader/guardedReader.ts';
import type { ReaderClient } from '../src/server/reader/types.ts';

const now = new Date('2026-11-13T12:00:00Z');
const usage = { provider: 'gemini' as const, model: 'gemini-3.5-flash-lite', inputTokens: 1000, outputTokens: 200, durationMs: 5 };

// A store whose only guard/ledger path is the two RPCs: any getQuota/setQuota/addAiCall use is counted.
function rpcStore(opts: { reply?: any; failPreflight?: boolean; failSettle?: boolean } = {}) {
  const pre: any[] = [];
  const settle: any[] = [];
  const direct: string[] = [];
  const store: any = {
    async readerPreflight(a: any) {
      pre.push(a);
      if (opts.failPreflight) throw new Error('db down');
      return opts.reply ?? { ok: true };
    },
    async readerSettle(a: any) {
      settle.push(a);
      if (opts.failSettle) throw new Error('db down');
    },
    async getQuota(k: string) { direct.push(`get:${k}`); return null; },
    async setQuota(u: any) { direct.push(`set:${u.key}`); },
    async addAiCall() { direct.push('addAiCall'); },
  };
  return { store, pre, settle, direct };
}

const base = (s: ReturnType<typeof rpcStore>, env: Record<string, string> = {}, extra: object = {}) => ({
  store: s.store, config: readReaderConfig(env), provider: 'gemini' as const, model: 'gemini-3.5-flash-lite',
  inputChars: 3000, maxOutputTokens: 1000, jobKey: 'j1', now, ...extra,
});
const refusal = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as QuotaExhaustedError; }
  assert.fail('expected refusal');
};
const refuse = (reason: string, scope = 'global', retry = '2026-11-14T08:00:00Z') => ({ ok: false, kind: 'refuse', reason, retry_at: retry, scope });

test('allow: one preflight, no direct ledger reads, payload carries config and keys', async () => {
  const s = rpcStore();
  const r = await checkGuards(base(s));
  assert.equal(r.ok, true);
  assert.equal(s.pre.length, 1);
  assert.deepEqual(s.direct, []);
  const p = s.pre[0];
  assert.equal(p.enabled, true);
  assert.equal(p.job_key, 'j1');
  assert.equal(p.breaker_key, BREAKER_KEY);
  assert.equal(p.max_spend_day_micro, 500_000);
  assert.equal(p.quota, null);
  assert.ok(p.worst_micro > 0);
});

test('each deny reason from the database becomes the same QuotaExhaustedError', async () => {
  for (const [reason, scope] of [['kill_switch', 'global'], ['breaker_open', 'global'], ['unpinned_model', 'global'], ['job_cap', 'job'], ['spend_day', 'global'], ['spend_month', 'global'], ['calls_cap', 'global']] as const) {
    const e = await refusal(checkGuards(base(rpcStore({ reply: refuse(reason, scope) }))));
    assert.ok(e instanceof QuotaExhaustedError);
    assert.equal(e.reason, reason);
    assert.equal(e.scope, scope);
    assert.equal(e.retryAt.toISOString(), '2026-11-14T08:00:00.000Z');
  }
});

test('input_too_large is a result with zero usage, not a throw', async () => {
  const r = await checkGuards(base(rpcStore({ reply: { ok: false, kind: 'input_too_large' } })));
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual([r.reason, r.usage.inputTokens, r.usage.outputTokens, r.usage.durationMs], ['input_too_large', 0, 0, 0]);
});

test('member refusals keep user scope and their messages', async () => {
  const quota = new QuotaLedger({} as any, { provider: 'gemini', model: 'gemini-3.5-flash-lite', dailyLimit: 50, perMinute: 10, ownerReserve: 20, userDaily: 5, userBackfillDaily: 3 });
  const s = rpcStore({ reply: refuse('user_daily', 'user') });
  const e = await refusal(checkGuards(base(s, {}, { quota, quotaOptions: { userId: 'u1', lane: 'backfill' } })));
  assert.equal(e.scope, 'user');
  assert.match(e.reason, /daily limit of 3 background Gemini calls/);
  const q = s.pre[0].quota;
  assert.equal(q.user_key, 'gemini:gemini-3.5-flash-lite:2026-11-13:user:u1:backfill');
  assert.equal(q.user_daily, 3);
  assert.equal(q.owner_reserve, 20);
  const e2 = await refusal(checkGuards(base(rpcStore({ reply: refuse('owner_reserve', 'user') }), {}, { quota, quotaOptions: { userId: 'u1' } })));
  assert.match(e2.reason, /owner's reserve/);
});

test('per-minute window stays in memory: sent as minute_blocked_until, recorded after allow', async () => {
  const quota = new QuotaLedger({} as any, { provider: 'gemini', model: 'm', dailyLimit: 50, perMinute: 2 });
  const s = rpcStore();
  await checkGuards(base(s, {}, { quota }));
  assert.equal(s.pre[0].quota.minute_blocked_until, null);
  await checkGuards(base(s, {}, { quota }));
  await checkGuards(base(s, {}, { quota }));
  assert.equal(s.pre[2].quota.minute_blocked_until, new Date(now.getTime() + 61_000).toISOString());
});

test('database error parks the job as guard_unavailable, never falls back', async () => {
  const s = rpcStore({ failPreflight: true });
  const e = await refusal(checkGuards(base(s)));
  assert.equal(e.reason, 'guard_unavailable');
  assert.equal(e.retryAt.getTime(), now.getTime() + 5 * 60_000);
  assert.equal(s.pre.length, 1);
  assert.deepEqual(s.direct, []);
});

test('recordOutcome parks the ledger payload; logCall sends one settle with the row', async () => {
  const s = rpcStore();
  const cfg = readReaderConfig({});
  await recordOutcome({ store: s.store, config: cfg, provider: 'gemini', model: usage.model, outcome: 'success', usage, worstCaseMicroUsd: 999, now });
  assert.equal(s.settle.length, 0);
  const row: any = { id: 'r1', createdAt: now.toISOString(), feature: 'lineup_extract', jobId: 'j', eventId: null, userId: null, provider: 'gemini', model: usage.model, sourceDocumentId: null, inputChars: 3000, inputTokens: 1000, outputTokens: 200, estCostUsd: 0.0008, durationMs: 5, outcome: 'ok', errorCode: null, guardReason: null, namesReturned: 2, namesVerbatim: 2, namesRejected: 0 };
  await logCall(s.store, row, now);
  assert.equal(s.settle.length, 1);
  const p = s.settle[0];
  assert.equal(p.record_ledger, true);
  assert.equal(p.outcome, 'success');
  assert.equal(p.cost_micro, Math.ceil((1000 * 0.3 + 200 * 2.5)));
  assert.equal(p.row.id, 'r1');
  assert.equal(p.breaker_failures, cfg.breakerFailures);
  assert.deepEqual(s.direct, []);
});

test('quota outcome sends the provider retry time for the breaker', async () => {
  const s = rpcStore();
  const retryAt = new Date(now.getTime() + 90_000);
  await recordOutcome({ store: s.store, config: readReaderConfig({}), provider: 'gemini', model: usage.model, outcome: 'quota', usage: null, worstCaseMicroUsd: 999, retryAt, now });
  await logCall(s.store, { id: 'r2' } as any, now);
  assert.equal(s.settle[0].outcome, 'quota');
  assert.equal(s.settle[0].breaker_until, retryAt.toISOString());
  assert.equal(s.settle[0].cost_micro, 0);
});

test('refused call: settle writes the row only (record_ledger false)', async () => {
  const s = rpcStore();
  await logCall(s.store, { id: 'r3', outcome: 'blocked_by_guard', guardReason: 'kill_switch' } as any, now);
  assert.equal(s.settle.length, 1);
  assert.equal(s.settle[0].record_ledger, false);
  assert.equal(s.settle[0].row.guard_reason, 'kill_switch');
});

test('settle payload has only counts, sizes and ids: no page text', async () => {
  const s = rpcStore();
  const row: any = { id: 'r4', createdAt: now.toISOString(), feature: 'lineup_extract', jobId: null, eventId: null, userId: null, provider: 'gemini', model: 'm', sourceDocumentId: null, inputChars: 3000, inputTokens: 1, outputTokens: 1, estCostUsd: 0, durationMs: 1, outcome: 'ok', errorCode: null, guardReason: null, namesReturned: 1, namesVerbatim: 1, namesRejected: 0, pageText: 'SECRET PAGE TEXT', prompt: 'SECRET' };
  await logCall(s.store, row, now);
  assert.ok(!JSON.stringify(s.settle[0]).includes('SECRET'));
  assert.deepEqual(Object.keys(s.settle[0].row).sort(), ['created_at', 'duration_ms', 'error_code', 'est_cost_usd', 'event_id', 'feature', 'guard_reason', 'id', 'input_chars', 'input_tokens', 'job_id', 'model', 'names_rejected', 'names_returned', 'names_verbatim', 'outcome', 'output_tokens', 'provider', 'source_document_id', 'user_id']);
});

test('settle failure never fails the read and is counted as a log failure', async () => {
  const s = rpcStore({ failSettle: true });
  await logCall(s.store, { id: 'r5' } as any, now);
  assert.deepEqual(s.direct, ['get:reader:logfail:2026-11-13', 'set:reader:logfail:2026-11-13']);
});

test('end to end: a guarded call is 2 database requests plus the provider call', async () => {
  const s = rpcStore();
  let providerCalls = 0;
  const c: any = {
    provider: 'gemini', model: usage.model,
    async extractPerformers() { providerCalls++; return { ok: true, value: [{ name: 'A', quote: 'A' }], usage }; },
  };
  const reader = createGuardedReader({ client: c as ReaderClient, store: s.store, config: readReaderConfig({}), now: () => now });
  const res = await reader.extractPerformers({ text: 'x'.repeat(3000), input: { eventName: 'Fest', year: 2026 }, examples: [] }, { feature: 'lineup_extract', jobKey: 'j1', afterRead: () => ({ returned: 1, verbatim: 1 }) });
  assert.equal(res.ok, true);
  assert.equal(providerCalls, 1);
  assert.equal(s.pre.length + s.settle.length, 2); // 3 subrequests with the provider call (was about 16)
  assert.equal(s.settle[0].row.names_returned, 1);
  assert.deepEqual(s.direct, []);
});

test('quota error from the provider parks: settle opens the breaker, no second provider call', async () => {
  const s = rpcStore();
  let calls = 0;
  const retryAt = new Date(now.getTime() + 60_000);
  const c: any = { provider: 'gemini', model: usage.model, async extractPerformers() { calls++; throw new QuotaExhaustedError(retryAt, 'q'); } };
  const reader = createGuardedReader({ client: c, store: s.store, config: readReaderConfig({}), now: () => now });
  await assert.rejects(reader.extractPerformers({ text: 'x', input: { eventName: 'F', year: 2026 }, examples: [] }, { feature: 'lineup_extract', jobKey: 'j1' }), QuotaExhaustedError);
  assert.equal(calls, 1);
  assert.equal(s.settle.length, 1);
  assert.equal(s.settle[0].outcome, 'quota');
  assert.equal(s.settle[0].row.outcome, 'quota');
});
