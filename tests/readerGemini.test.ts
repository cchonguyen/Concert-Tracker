import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiReader, thinkingConfigFor } from '../src/server/reader/geminiAdapter.ts';
import { QuotaExhaustedError } from '../src/server/lineup/quota.ts';
import { SYSTEM, DETAILS_PROMPT_VERSION, DETAILS_SCHEMA, DETAILS_SYSTEM } from '../src/server/lineup/gemini.ts';

function fake(model: string, reply: any) {
  const calls: any[] = [];
  return {
    calls,
    client: {
      model,
      async generate(args: any) {
        calls.push(args);
        if (reply instanceof Error || (reply && reply.throw)) throw reply.throw ?? reply;
        return { text: '{"performers":[{"name":"A","quote":"A"}]}', finishReason: 'STOP', promptTokens: 10, candidatesTokens: 5, thoughtsTokens: 7, ...reply };
      },
    },
  };
}
const input = { eventName: 'Fest', year: 2026 } as any;
const run = (r: any, max = 500) => r.extractPerformers({ text: 'A plays', input, examples: [], maxOutputTokens: max });

test('usage sums candidates and thoughts; passes maxOutputTokens and prompts', async () => {
  const f = fake('gemini-3.5-flash-lite', {});
  const r: any = await run(createGeminiReader(f.client, 'LOW'), 321);
  assert.equal(r.ok, true);
  assert.deepEqual(r.usage.inputTokens, 10);
  assert.equal(r.usage.outputTokens, 12);
  assert.equal(r.usage.provider, 'gemini');
  assert.equal(f.calls[0].maxOutputTokens, 321);
  assert.equal(f.calls[0].systemInstruction, SYSTEM);
  assert.equal(typeof f.calls[0].contents, 'string');
  for (const k of ['temperature', 'topP', 'topK', 'frequencyPenalty', 'presencePenalty']) assert.ok(!(k in f.calls[0]));
});

test('usage is null when the provider reports nothing', async () => {
  const f = fake('m', { promptTokens: null, candidatesTokens: null, thoughtsTokens: null });
  const r: any = await run(createGeminiReader(f.client));
  assert.equal(r.usage.inputTokens, null);
  assert.equal(r.usage.outputTokens, null);
});

test('thinking config by model', () => {
  assert.deepEqual(thinkingConfigFor('gemini-2.5-flash', 'HIGH'), { thinkingBudget: 0 });
  assert.deepEqual(thinkingConfigFor('gemini-3.5-flash-lite', 'LOW'), { thinkingLevel: 'LOW' });
  assert.deepEqual(thinkingConfigFor('gemini-3.5-flash-lite', 'OFF'), { thinkingLevel: 'LOW' });
  assert.deepEqual(thinkingConfigFor('gemini-4-hydrogen', 'MEDIUM'), { thinkingLevel: 'MEDIUM' });
  assert.ok(!('thinkingBudget' in thinkingConfigFor('gemini-4-hydrogen', 'HIGH')));
});

test('config reaches the client', async () => {
  const f = fake('gemini-3.5-flash-lite', {});
  await run(createGeminiReader(f.client, 'OFF'));
  assert.deepEqual(f.calls[0].thinkingConfig, { thinkingLevel: 'LOW' });
});

test('bad JSON, wrong shape and MAX_TOKENS are invalid_json', async () => {
  for (const reply of [{ text: '{nope' }, { text: '{"x":1}' }, { finishReason: 'MAX_TOKENS' }]) {
    const r: any = await run(createGeminiReader(fake('m', reply).client));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_json');
    assert.equal(r.usage.outputTokens, 12);
  }
});

test('details: DETAILS_SYSTEM, only string fields and optional weekendQuotes string array', async () => {
  assert.equal(DETAILS_PROMPT_VERSION, 'details@3');
  assert.ok('weekendQuotes' in DETAILS_SCHEMA.properties);
  const f = fake('m', { text: '{"venue":"Hall","city":"Oslo"}' });
  const reader = createGeminiReader(f.client);
  const r: any = await reader.extractEventDetails({ text: 'x', eventName: 'E', year: 2026, maxOutputTokens: 100 });
  assert.deepEqual(r.value, { venue: 'Hall', city: 'Oslo' });
  assert.equal(f.calls[0].systemInstruction, DETAILS_SYSTEM);
  const bad: any = await createGeminiReader(fake('m', { text: '{"venue":5}' }).client).extractEventDetails({ text: 'x', eventName: 'E', maxOutputTokens: 100 });
  assert.equal(bad.reason, 'invalid_json');

  const withWeekends: any = await createGeminiReader(
    fake('m', { text: '{"dateQuote":"Apr 11-13, 2025","weekendQuotes":["Weekend 1: Apr 11-13, 2025","Weekend 2: Apr 18-20, 2025"]}' }).client,
  ).extractEventDetails({ text: 'x', eventName: 'Coachella', year: 2025, maxOutputTokens: 100 });
  assert.equal(withWeekends.ok, true);
  assert.deepEqual(withWeekends.value, {
    dateQuote: 'Apr 11-13, 2025',
    weekendQuotes: ['Weekend 1: Apr 11-13, 2025', 'Weekend 2: Apr 18-20, 2025'],
  });

  for (const invalidWq of ['{"weekendQuotes":"not-an-array"}', '{"weekendQuotes":["ok", 123]}', '{"weekendQuotes":[null]}']) {
    const res: any = await createGeminiReader(fake('m', { text: invalidWq }).client).extractEventDetails({ text: 'x', eventName: 'E', maxOutputTokens: 100 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'invalid_json');
  }
});

test('details: inferred keeps only well-formed items and drops the rest, not the whole answer', async () => {
  const good = { field: 'country', value: 'Norway', quote: 'Oslo, Norway', reason: 'the line names Norway' };
  const reply = {
    venue: 'Hall',
    inferred: [
      { field: 'city', value: 'Oslo' }, // missing keys
      'junk',
      null,
      { field: 'region', value: '', quote: 'q', reason: 'r' }, // empty value
      good,
    ],
  };
  const r: any = await createGeminiReader(fake('m', { text: JSON.stringify(reply) }).client).extractEventDetails({ text: 'x', eventName: 'E', maxOutputTokens: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.value.venue, 'Hall');
  assert.deepEqual(r.value.inferred, [good]);
  const absent: any = await createGeminiReader(fake('m', { text: '{"venue":"Hall"}' }).client).extractEventDetails({ text: 'x', eventName: 'E', maxOutputTokens: 100 });
  assert.equal('inferred' in absent.value, false);
  assert.ok(DETAILS_SCHEMA.properties.inferred);
});

test('402 and prepay-depleted 429 park for 6 hours', async () => {
  const t = new Date('2026-10-29T18:00:00Z');
  for (const err of [Object.assign(new Error('Payment required'), { status: 402 }), Object.assign(new Error('Your prepayment credits are depleted'), { status: 429 })]) {
    await assert.rejects(run(createGeminiReader(fake('m', { throw: err }).client, 'LOW', () => t)), (e: any) => {
      assert.ok(e instanceof QuotaExhaustedError);
      assert.equal(e.retryAt.getTime(), t.getTime() + 6 * 3600_000);
      assert.match(e.reason, /prepay balance is empty/);
      return true;
    });
  }
});

test('other 429 keeps the normal rate-limit path; other errors pass through', async () => {
  const t = new Date('2026-10-29T18:00:00Z');
  const rl = Object.assign(new Error('429 retryDelay: 30s'), { status: 429 });
  await assert.rejects(run(createGeminiReader(fake('m', { throw: rl }).client, 'LOW', () => t)), (e: any) => e instanceof QuotaExhaustedError && e.retryAt.getTime() === t.getTime() + 31_000);
  const boom = new Error('boom');
  await assert.rejects(run(createGeminiReader(fake('m', { throw: boom }).client)), (e: any) => e === boom);
});
