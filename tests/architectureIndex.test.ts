import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const archDir = path.join(root, 'docs', 'architecture');
const index = readFileSync(path.join(root, 'ARCHITECTURE.md'), 'utf8');
const parts = readdirSync(archDir).filter((name) => name.endsWith('.md'));

test('every section file is linked from the ARCHITECTURE.md index', () => {
  const unlinked = parts.filter((name) => !index.includes(`docs/architecture/${name}`));
  assert.deepEqual(unlinked, []);
});

test('every relative link in ARCHITECTURE.md and its sections resolves', () => {
  const files = [path.join(root, 'ARCHITECTURE.md'), ...parts.map((name) => path.join(archDir, name))];
  const broken: string[] = [];
  for (const file of files) {
    for (const [, target] of readFileSync(file, 'utf8').matchAll(/\]\(([^)#\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      if (!existsSync(path.resolve(path.dirname(file), target))) broken.push(`${path.relative(root, file)} -> ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});
