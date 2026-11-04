import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

// The root ARCHITECTURE.md plus every docs/architecture/*.md section, joined.
function architectureDoc(): string {
  const dir = path.join(root, 'docs/architecture');
  const parts = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => read(path.join('docs/architecture', f)));
  return [read('ARCHITECTURE.md'), ...parts].join('\n');
}

function releaseSection(): string {
  const doc = architectureDoc();
  const start = doc.indexOf('# Release checks (S4)');
  assert.ok(start >= 0, 'ARCHITECTURE docs have a Release checks (S4) section');
  const rest = doc.slice(start + 1);
  const next = rest.search(/\n#{1,2} /);
  return next < 0 ? doc.slice(start) : doc.slice(start, start + 1 + next);
}

test('release checks name the Access settings the Worker reads', () => {
  const section = releaseSection();
  const access = read('src/server/share/access.ts');
  assert.match(section, /ACCESS_TEAM_DOMAIN/);
  assert.match(section, /ACCESS_AUD/);
  assert.match(access, /env\.ACCESS_TEAM_DOMAIN/);
  assert.match(access, /env\.ACCESS_AUD/);
});

test('release checks cite the share page rule that is enforced in code', () => {
  const section = releaseSection();
  const page = read('src/server/share/page.ts');
  assert.match(section, /default-src 'none'/);
  assert.match(page, /default-src 'none'/);
});

test('release checks name migration files that exist, and the next free number', () => {
  const section = releaseSection();
  assert.ok(fs.existsSync(path.join(root, 'supabase/migrations/0015_share_links.sql')));
  assert.match(section, /0015/);
  assert.match(section, /0036/);
  const taken = fs.readdirSync(path.join(root, 'supabase/migrations')).filter((f) => f.startsWith('0036_'));
  assert.equal(taken.length, 0, 'migration 0036 is still free');
});
