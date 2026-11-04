import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

// Relative links in root and docs/ must point at files that exist. Code spans
// are skipped, anchors and query strings are ignored, external links and
// mailto: are not checked.
test('every relative Markdown link in root and docs/ resolves', () => {
  const rootDocs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(root, entry.name));
  const linkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const dead: string[] = [];
  for (const file of [...rootDocs, ...markdownFiles(docsDir)]) {
    const text = readFileSync(file, 'utf8').replace(/`[^`\n]*`/g, '');
    const targets = [...text.matchAll(linkPattern)].map((match) => match[1]);
    for (const raw of targets) {
      if (/^(https?:|mailto:|#)/.test(raw)) continue;
      const target = raw.split(/[#?]/)[0];
      if (!target) continue;
      const resolved = target.startsWith('/')
        ? path.join(root, target)
        : path.resolve(path.dirname(file), target);
      if (!existsSync(resolved)) dead.push(`${path.relative(root, file)} -> ${target}`);
    }
  }
  assert.deepEqual(dead, []);
});

test('closed tickets are not also in the open ticket bank', () => {
  const ticketId = /^### \[([A-Z0-9-]+)\]/gm;
  const openIds = [
    ...readFileSync(path.join(docsDir, 'engineering-ticket-bank.md'), 'utf8').matchAll(ticketId),
  ].map((match) => match[1]);
  const closedIds = [
    ...readFileSync(path.join(docsDir, 'archive', 'engineering-ticket-bank-closed.md'), 'utf8').matchAll(ticketId),
  ].map((match) => match[1]);
  assert.ok(closedIds.length > 0);
  const overlap = closedIds.filter((id) => openIds.includes(id));
  assert.deepEqual(overlap, []);
});

test('every top-level doc in docs/ is listed in docs/README.md', () => {
  const index = readFileSync(path.join(docsDir, 'README.md'), 'utf8');
  const missing = readdirSync(docsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
    .map((entry) => entry.name)
    .filter((name) => !index.includes(name));
  assert.deepEqual(missing, []);
});

test('every closed ticket carries a Closed verdict line', () => {
  const text = readFileSync(path.join(docsDir, 'archive', 'engineering-ticket-bank-closed.md'), 'utf8');
  const matches = [...text.matchAll(/^### \[([A-Z0-9-]+)\]/gm)];
  const missing: string[] = [];
  matches.forEach((match, i) => {
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const section = text.slice(match.index, end);
    if (!section.includes('- **Closed**:')) missing.push(match[1]);
  });
  const count = matches.length;
  assert.deepEqual(missing, []);
  assert.ok(count > 0);
});
