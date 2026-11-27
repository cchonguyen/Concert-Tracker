import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STUB_STYLES, STUB_STYLE_LABELS } from '../src/services/theme.ts';

const css = readFileSync(new URL('../src/styles/ticket-styles.css', import.meta.url), 'utf8');
const blocks = new Set([...css.matchAll(/\[data-stub='([a-z-]+)'\]/g)].map((m) => m[1]));

test('every ticket style in the list has a block in the module, and back', () => {
  const listed = STUB_STYLES.filter((s) => s !== 'original');
  assert.deepEqual([...blocks].sort(), [...listed].sort());
});

test('every ticket style has a label', () => {
  for (const s of STUB_STYLES) assert.ok(STUB_STYLE_LABELS[s]);
});

test('index.css loads the module', () => {
  const index = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  assert.match(index, /@import "\.\/styles\/ticket-styles\.css";/);
});
