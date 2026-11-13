import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReader, createDeps } from '../src/server/lineup/service.ts';
import type { LineupStore } from '../src/server/lineup/store/types.ts';

const store = {} as unknown as LineupStore;
const key = { GEMINI_API_KEY: 'real-key' };

test('createReader: defaults to gemini with the default model', () => {
  const r = createReader(store, key);
  assert.equal(r?.provider, 'gemini');
  assert.equal(r?.model, 'gemini-3.5-flash-lite');
  assert.equal(typeof r?.discoverLineupUrls, 'function');
});

test('createReader: model is read on every call', () => {
  const env: Record<string, unknown> = { ...key, GEMINI_EXTRACTION_MODEL: 'gemini-a' };
  assert.equal(createReader(store, env)?.model, 'gemini-a');
  env.GEMINI_EXTRACTION_MODEL = 'gemini-b';
  assert.equal(createReader(store, env)?.model, 'gemini-b');
});

test('createReader: no reader when unconfigured', () => {
  assert.equal(createReader(store, {}), null);
  assert.equal(createReader(store, { GEMINI_API_KEY: 'MY_GEMINI_API_KEY' }), null);
  assert.equal(createReader(store, { ...key, READER_PROVIDER: 'openai' }), null);
  assert.equal(createReader(store, { ...key, READER_PROVIDER: 'workers-ai' }), null);
});

test('createDeps: reader is optional and present only when gemini is configured', () => {
  const saved = { k: process.env.GEMINI_API_KEY, p: process.env.READER_PROVIDER };
  try {
    delete process.env.READER_PROVIDER;
    process.env.GEMINI_API_KEY = 'real-key';
    assert.equal(createDeps(store).reader?.provider, 'gemini');
    delete process.env.GEMINI_API_KEY;
    assert.equal(createDeps(store).reader, null);
  } finally {
    for (const [n, v] of [['GEMINI_API_KEY', saved.k], ['READER_PROVIDER', saved.p]] as const) {
      if (v === undefined) delete process.env[n]; else process.env[n] = v;
    }
  }
});
