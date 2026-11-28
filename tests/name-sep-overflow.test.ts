import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The screen-reader comma between names is absolutely placed (sr-only). Inside a
// truncated line it escapes the clip unless a positioned parent holds it, and the
// page then scrolls sideways into empty space (Summary on phones, issue #1207).
test('NameSep keeps its sr-only comma inside a relative wrapper', () => {
  const src = readFileSync(new URL('../src/components/ui/NameList.tsx', import.meta.url), 'utf8');
  assert.match(src, /<span className="relative">\s*<span className="sr-only">, <\/span>\s*<\/span>/);
});
