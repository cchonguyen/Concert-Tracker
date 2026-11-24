import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// Code comments explain the code as it is. Slice numbers point at old work that a reader cannot look up,
// and a doc path in a comment must still lead somewhere (docs cleanup, 2026-11-23).
const root = path.resolve(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

const files = [...sourceFiles(path.join(root, 'src')), ...sourceFiles(path.join(root, 'worker')), path.join(root, 'server.ts')];

function commentLines(file: string): { line: number; text: string }[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => /^\s*(\/\/|\*|\/\*)/.test(text) || /\s\/\/\s/.test(text));
}

test('no code comment cites a slice number', () => {
  const offenders = files.flatMap((file) =>
    commentLines(file)
      .filter(({ text }) => /\b[Ss]lices? [0-9M][\w.]*/.test(text))
      .map(({ line }) => `${path.relative(root, file)}:${line}`),
  );
  assert.deepEqual(offenders, []);
});

test('every docs/ path named in source exists', () => {
  const missing = files.flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/\bdocs\/[\w/.-]+\.md/g)]
      .map((match) => match[0])
      .filter((doc) => !existsSync(path.join(root, doc)))
      .map((doc) => `${path.relative(root, file)} -> ${doc}`),
  );
  assert.deepEqual(missing, []);
});
