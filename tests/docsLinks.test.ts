import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// Guards the docs hygiene fixes: no machine-specific file:// links, and every
// top-level spec in docs/ is listed in the docs index.
const root = path.resolve(import.meta.dirname, '..');
const docsDir = path.join(root, 'docs');

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

test('docs do not link to machine-specific file:// paths', () => {
  const offenders = markdownFiles(docsDir)
    .filter((file) => readFileSync(file, 'utf8').includes('file:///'))
    .map((file) => path.relative(root, file));
  assert.deepEqual(offenders, []);
});

test('every top-level doc in docs/ is listed in docs/README.md', () => {
  const index = readFileSync(path.join(docsDir, 'README.md'), 'utf8');
  const missing = readdirSync(docsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
    .map((entry) => entry.name)
    .filter((name) => !index.includes(name));
  assert.deepEqual(missing, []);
});
