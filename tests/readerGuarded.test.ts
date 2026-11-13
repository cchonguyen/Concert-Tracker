import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { QuotaExhaustedError } from '../src/server/lineup/quota.ts';
import { readReaderConfig } from '../src/server/reader/config.ts';
import { createGuardedReader } from '../src/server/reader/guardedReader.ts';
import type { ReaderClient, ReaderUsage } from '../src/server/reader/types.ts';
import { BREAKER_KEY } from '../src/server/reader/guard.ts';

const now = new Date('2026-11-13T12:00:00Z');
const usage: ReaderUsage = { provider: 'gemini', model: 'gemini-3.5-flash-lite', inputTokens: 1000, outputTokens: 200, durationMs: 5 };

function fake(opts: { failAdd?: boolean } = {}) {
  const m = new Map<string, any>();
  const rows: any[] = [];
  const store: any = {
    async getQuota(k: string) { return m.get(k) ?? null; },
    async setQuota(u: any) { m.set(u.key, u); },
    async addAiCall(r: any) { if (opts.failAdd) throw new Error('db down'); rows.push(r); },
  };
  return { store, m, rows };
}

function client(behavior: () => Promise<any>): ReaderClient & { calls: number } {
  const c: any = {
    provider: 'gemini', model: 'gemini-3.5-flash-lite', calls: 0,
    async extractPerformers() { c.calls++; return behavior(); },
    async extractEventDetails() { c.calls++; return behavior(); },
  };
  return c;
}

const mk = (f: ReturnType<typeof fake>, c: ReaderClient, env: Record<string, string> = {}) =>
  createGuardedReader({ client: c, store: f.store, config: readReaderConfig(env), now: () => now });
const args = { text: 'x'.repeat(3000), input: { eventName: 'Fest', year: 2026 }, examples: [] };
const ctx = (extra: object = {}) => ({ feature: 'lineup_extract' as const, jobKey: 'j1', jobId: 'job-1', ...extra });

test('success logs one row with counts and cost', async () => {
  const f = fake();
  const names = [{ name: 'A', quote: 'A' }, { name: 'B', quote: 'B' }];
  const r = mk(f, client(async () => ({ ok: true, value: names, usage })));
  const res = await r.extractPerformers(args, ctx({ afterRead: () => ({ returned: 2, verbatim: 1 }) }));
  assert.equal(res.ok, true);
  assert.equal(f.rows.length, 1);
  const row = f.rows[0];
  assert.equal(row.outcome, 'ok');
  assert.deepEqual([row.namesReturned, row.namesVerbatim, row.namesRejected], [2, 1, 1]);
  assert.equal(row.inputChars, 3000);
  assert.equal(row.jobId, 'job-1');
  assert.ok(row.estCostUsd > 0);
  assert.ok(!JSON.stringify(row).includes('xxx'));
});

test('guard block logs blocked_by_guard, makes no provider call, rethrows', async () => {
  const f = fake();
  const c = client(async () => ({ ok: true, value: [], usage }));
  await assert.rejects(mk(f, c, { READER_ENABLED: 'off' }).extractPerformers(args, ctx()), (e: any) => e instanceof QuotaExhaustedError && e.reason === 'kill_switch');
  assert.equal(c.calls, 0);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].outcome, 'blocked_by_guard');
  assert.equal(f.rows[0].guardReason, 'kill_switch');
});

test('oversized input is a returned result with one blocked row', async () => {
  const f = fake();
  const c = client(async () => ({ ok: true, value: [], usage }));
  const res = await mk(f, c, { READER_MAX_INPUT_CHARS: '100' }).extractPerformers(args, ctx());
  assert.equal(res.ok, false);
  assert.equal((res as any).reason, 'input_too_large');
  assert.equal(c.calls, 0);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].guardReason, 'input_too_large');
});

test('invalid_json is logged and returned', async () => {
  const f = fake();
  const r = mk(f, client(async () => ({ ok: false, reason: 'invalid_json', usage })));
  const res = await r.extractPerformers(args, ctx());
  assert.equal(res.ok, false);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].outcome, 'invalid_json');
  assert.equal(f.m.get(BREAKER_KEY).used, 1);
});

test('provider quota error logs quota, opens the breaker and rethrows', async () => {
  const f = fake();
  const until = new Date(now.getTime() + 3600_000);
  const r = mk(f, client(async () => { throw new QuotaExhaustedError(until, 'rate'); }));
  await assert.rejects(r.extractPerformers(args, ctx()), QuotaExhaustedError);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].outcome, 'quota');
  assert.equal(f.m.get(BREAKER_KEY).exhaustedUntil, until.toISOString());
});

test('a log write failure does not fail the read and bumps the logfail counter', async () => {
  const f = fake({ failAdd: true });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const res = await mk(f, client(async () => ({ ok: true, value: [], usage }))).extractPerformers(args, ctx());
    assert.equal(res.ok, true);
  } finally {
    console.warn = warn;
  }
  assert.equal(f.m.get('reader:logfail:2026-11-13').used, 1);
});

test('only src/server/reader/ and lineup/gemini.ts import @google/genai', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts)$/.test(name) && /['"]@google\/genai['"]/.test(readFileSync(p, 'utf8'))) offenders.push(p);
    }
  };
  walk('src');
  const allowed = offenders.filter((p) => p.includes('src/server/reader/') || p.endsWith('src/server/lineup/gemini.ts'));
  assert.deepEqual(offenders, allowed);
});
