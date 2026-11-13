import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SupabaseLineupStore } from '../src/server/lineup/store/supabaseStore.ts';
import type { AiCallRow } from '../src/server/lineup/store/types.ts';

const sql = readFileSync(new URL('../supabase/migrations/0038_ai_calls.sql', import.meta.url), 'utf8');
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

test('0038 creates ai_calls with checks, index, RLS and an owner read policy', () => {
  assert.match(code, /create table if not exists ai_calls/);
  assert.match(code, /feature text not null check \(feature in \('lineup_extract','details_extract','discovery'\)\)/);
  assert.match(code, /outcome text not null check \(outcome in \('ok','invalid_json','quota','busy','blocked_by_guard','error'\)\)/);
  assert.match(code, /create index if not exists ai_calls_created_idx on ai_calls \(created_at desc\)/);
  assert.match(code, /alter table ai_calls enable row level security/);
  assert.match(code, /create policy "owner_read" on ai_calls for select to authenticated using \(auth\.uid\(\) = owner_user_id\(\)\)/);
  assert.doesNotMatch(code, /for (insert|update|delete|all)/i, 'no member write policy');
  assert.doesNotMatch(code, /references/i, 'no foreign keys');
  assert.match(sql, /drop table ai_calls/, 'rollback comment');
});

test('0038 stores no page text, prompts, quotes or names, and no recall columns', () => {
  for (const bad of ['page_text', 'prompt', 'quote', 'text_body', 'content', 'recall', 'names text', 'names jsonb']) {
    assert.ok(!code.includes(bad), `no ${bad} column`);
  }
});

const row: AiCallRow = {
  id: 'a1', createdAt: '2026-11-01T00:00:00.000Z', feature: 'lineup_extract', jobId: 'j1', eventId: null, userId: null,
  provider: 'gemini', model: 'm', sourceDocumentId: 'd1', inputChars: 10, inputTokens: 5, outputTokens: 2, estCostUsd: 0.001,
  durationMs: 40, outcome: 'ok', errorCode: null, guardReason: null, namesReturned: 3, namesVerbatim: 2, namesRejected: 1,
};

function fakeDb(result: any) {
  const log: any[] = [];
  const db = {
    from(table: string) {
      const e: any = { table, ops: [] };
      const b: any = new Proxy({}, {
        get: (_t, op: string) => {
          if (op === 'then') return (res: any, rej: any) => (log.push(e), Promise.resolve(result).then(res, rej));
          return (...args: any[]) => (e.ops.push([op, ...args]), b);
        },
      });
      return b;
    },
  };
  return { db, log };
}

test('addAiCall is one insert with snake_case columns', async () => {
  const { db, log } = fakeDb({ data: null, error: null });
  await new SupabaseLineupStore(db as any).addAiCall(row);
  assert.equal(log.length, 1);
  assert.equal(log[0].table, 'ai_calls');
  const [op, ins] = log[0].ops[0];
  assert.equal(op, 'insert');
  assert.equal(ins.created_at, row.createdAt);
  assert.equal(ins.names_rejected, 1);
  assert.equal(ins.est_cost_usd, 0.001);
  assert.equal(ins.source_document_id, 'd1');
});

test('listAiCalls reads newest first and maps back to camelCase', async () => {
  const dbRow = {
    id: 'a1', created_at: row.createdAt, feature: 'lineup_extract', job_id: 'j1', event_id: null, user_id: null, provider: 'gemini',
    model: 'm', source_document_id: 'd1', input_chars: 10, input_tokens: 5, output_tokens: 2, est_cost_usd: '0.001000',
    duration_ms: 40, outcome: 'ok', error_code: null, guard_reason: null, names_returned: 3, names_verbatim: 2, names_rejected: 1,
  };
  const { db, log } = fakeDb({ data: [dbRow], error: null });
  const out = await new SupabaseLineupStore(db as any).listAiCalls(20);
  assert.deepEqual(out, [row]);
  const ops = log[0].ops;
  assert.deepEqual(ops.find((o: any[]) => o[0] === 'order'), ['order', 'created_at', { ascending: false }]);
  assert.deepEqual(ops.find((o: any[]) => o[0] === 'limit'), ['limit', 20]);
});

test('deleteAiCallsBefore deletes older rows and returns the count', async () => {
  const { db, log } = fakeDb({ data: null, error: null, count: 7 });
  const n = await new SupabaseLineupStore(db as any).deleteAiCallsBefore(new Date('2026-05-01T00:00:00.000Z'));
  assert.equal(n, 7);
  assert.deepEqual(log[0].ops.find((o: any[]) => o[0] === 'lt'), ['lt', 'created_at', '2026-05-01T00:00:00.000Z']);
});

test('a database error throws', async () => {
  const { db } = fakeDb({ data: null, error: { message: 'boom' } });
  await assert.rejects(() => new SupabaseLineupStore(db as any).addAiCall(row), /boom/);
});
