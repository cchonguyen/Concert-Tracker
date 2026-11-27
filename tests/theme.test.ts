import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccent, parseMode, parseStubStyle, resolveMode, STUB_STYLE_LABELS, STUB_STYLES } from '../src/services/theme.ts';

test('unknown or missing stored values fall back to the dark violet theme', () => {
  assert.equal(parseMode(null), 'dark');
  assert.equal(parseMode('sepia'), 'dark');
  assert.equal(parseMode('light'), 'light');
  assert.equal(parseAccent(undefined), 'violet');
  assert.equal(parseAccent('chartreuse'), 'violet');
  assert.equal(parseAccent('teal'), 'teal');
});

test('system mode follows the device setting; dark and light ignore it', () => {
  assert.equal(resolveMode('system', true), 'light');
  assert.equal(resolveMode('system', false), 'dark');
  assert.equal(resolveMode('dark', true), 'dark');
  assert.equal(resolveMode('light', false), 'light');
});

test('the ticket style falls back to the original stub for unknown values', () => {
  assert.equal(parseStubStyle(null), 'original');
  assert.equal(parseStubStyle('glitter'), 'original');
  assert.equal(parseStubStyle('riso'), 'riso');
  for (const s of STUB_STYLES) assert.ok(STUB_STYLE_LABELS[s]);
});
