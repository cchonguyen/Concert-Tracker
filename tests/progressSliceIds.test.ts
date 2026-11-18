import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Slice ids must be unique in .spec/PROGRESS.md: two slices with one id block every harness gate.
test('every slice id in .spec/PROGRESS.md is unique', async () => {
  const text = await readFile(new URL('../.spec/PROGRESS.md', import.meta.url), 'utf8');
  const ids = [...text.matchAll(/\*\*Slice (\d+\.\d+)[:.]/g)].map((m) => m[1]);
  assert.ok(ids.length > 0, 'expected slice lines in .spec/PROGRESS.md');
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  assert.deepEqual([...dupes], [], 'duplicate slice ids');
});
