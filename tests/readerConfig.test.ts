import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readReaderConfig } from '../src/server/reader/config.ts';
import { estimateCostUsd, worstCaseMicroUsd, PRICES } from '../src/server/reader/pricing.ts';

test('defaults', () => {
  const c = readReaderConfig({});
  assert.equal(c.provider, 'gemini');
  assert.equal(c.providerExplicit, false);
  assert.equal(c.enabled, true);
  assert.equal(c.thinkingLevel, 'LOW');
  assert.equal(c.geminiModel, 'gemini-3.5-flash-lite');
  assert.equal(c.workersAiModel, '@cf/zai-org/glm-4.7-flash');
  assert.equal(c.maxInputChars, 30000);
  assert.equal(c.windowChars, 30000);
  assert.equal(c.breakerFailures, 5);
  assert.equal(c.breakerCooldownMin, 30);
  assert.equal(c.maxCallsPerJob, 6);
  assert.equal(c.maxSpendDayUsd, 0.5);
  assert.equal(c.maxSpendMonthUsd, 5);
  assert.equal(c.maxOutputTokens, 8192);
  assert.equal(c.maxOutputTokensDetails, 1024);
});

test('overrides', () => {
  const c = readReaderConfig({
    READER_PROVIDER: 'workers-ai', READER_ENABLED: 'on', READER_THINKING_LEVEL: 'high',
    GEMINI_EXTRACTION_MODEL: 'gemini-4-hydrogen', WORKERS_AI_MODEL: '@cf/google/gemma-4-26b-a4b-it',
    READER_MAX_INPUT_CHARS: '1000', READER_MAX_SPEND_DAY_USD: '1.25', READER_MAX_CALLS_PER_JOB: '2',
  });
  assert.equal(c.provider, 'workers-ai');
  assert.equal(c.providerExplicit, true);
  assert.equal(c.enabled, true);
  assert.equal(c.thinkingLevel, 'HIGH');
  assert.equal(c.geminiModel, 'gemini-4-hydrogen');
  assert.equal(c.workersAiModel, '@cf/google/gemma-4-26b-a4b-it');
  assert.equal(c.maxInputChars, 1000);
  assert.equal(c.maxSpendDayUsd, 1.25);
  assert.equal(c.maxCallsPerJob, 2);
  assert.equal(readReaderConfig({ READER_THINKING_LEVEL: 'off' }).thinkingLevel, 'OFF');
});

test('invalid values fall back', () => {
  const c = readReaderConfig({
    READER_THINKING_LEVEL: 'extreme', READER_MAX_INPUT_CHARS: 'abc', READER_BREAKER_FAILURES: '0',
    READER_MAX_SPEND_MONTH_USD: '-3', READER_ENABLED: 'yes', READER_PROVIDER: 'openai',
  });
  assert.equal(c.thinkingLevel, 'LOW');
  assert.equal(c.maxInputChars, 30000);
  assert.equal(c.breakerFailures, 5);
  assert.equal(c.maxSpendMonthUsd, 5);
  assert.equal(c.enabled, false);
  assert.equal(c.provider, null);
  assert.equal(c.providerExplicit, true);
});

test('env is read on every call', () => {
  const env: Record<string, string> = {};
  assert.equal(readReaderConfig(env).maxCallsPerJob, 6);
  env.READER_MAX_CALLS_PER_JOB = '3';
  assert.equal(readReaderConfig(env).maxCallsPerJob, 3);
});

test('known model price', () => {
  const cost = estimateCostUsd('gemini', 'gemini-3.5-flash-lite', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.ok(Math.abs(cost! - 2.8) < 1e-9);
  assert.equal(PRICES['gemini:gemini-3.5-flash-lite'].checkedOn, '2026-11-13');
  assert.equal(worstCaseMicroUsd('gemini', 'gemini-3.5-flash-lite', 3, 0).isFallback, false);
});

test('unlisted model uses fallback', () => {
  const cost = estimateCostUsd('gemini', 'gemini-4-hydrogen', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.ok(Math.abs(cost! - 9) < 1e-9);
  const w = worstCaseMicroUsd('gemini', 'gemini-4-hydrogen', 200000, 8192);
  assert.equal(w.isFallback, true);
  assert.equal(w.micro, Math.ceil(66667 * 1.5 + 8192 * 7.5));
});

test('null usage gives null cost', () => {
  assert.equal(estimateCostUsd('gemini', 'x', { inputTokens: null, outputTokens: 5 }), null);
  assert.equal(estimateCostUsd('workers-ai', 'x', { inputTokens: 5, outputTokens: null }), null);
});
