import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const dir = path.resolve(import.meta.dirname, '..', 'supabase', 'migrations');
const files = readdirSync(dir).filter((name) => name.endsWith('.sql'));

test('migration number prefixes are unique', () => {
  const prefixes = files.map((name) => name.slice(0, 4));
  const duplicates = prefixes.filter((p, i) => prefixes.indexOf(p) !== i);
  assert.deepEqual(duplicates, []);
});

test('no migration is left as a DRAFT', () => {
  const drafts = files.filter((name) => readFileSync(path.join(dir, name), 'utf8').split('\n').slice(0, 3).some((line) => /DRAFT for|NOT applied/.test(line)));
  assert.deepEqual(drafts, []);
});
