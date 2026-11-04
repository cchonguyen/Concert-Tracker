import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const history = readFileSync(path.join(root, '.spec', 'archive', 'HISTORY.md'), 'utf8');

test('finished slices are archived in HISTORY.md', () => {
  assert.match(history, /\*\*Slice 8\.10\*\*/);
  assert.match(history, /\*\*Slice M6\*\*/);
});
