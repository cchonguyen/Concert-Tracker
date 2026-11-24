// App text rules from docs/specs/docs-and-text-cleanup.md: no AI brand name on
// member screens, and the deep search button keeps its plain name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');

test('the deep search button names no AI brand', () => {
  const check = read('src/components/CheckDetails.tsx');
  assert.ok(check.includes('Deep search with AI'));
  assert.ok(!/Read with Gemini|Look again with Gemini|read by Gemini|Gemini reads left/.test(check));
  assert.ok(!read('src/components/ui/SourceIcon.tsx').includes("'(read by Gemini)'"));
});

test('member screens say Edition, not Canonical edition', () => {
  assert.ok(!read('src/components/EventDetail.tsx').includes('Canonical edition'));
});

test('member screens never show server setting names', () => {
  assert.ok(!/GOOGLE_CLIENT_(ID|SECRET)/.test(read('src/components/SheetSync.tsx').replace(/^\s*\/\/.*$/gm, '')));
});
