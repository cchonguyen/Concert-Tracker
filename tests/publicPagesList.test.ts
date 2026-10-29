import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PUBLIC_EXACT_PATHS, isPublicPath } from '../src/server/site/publicPaths.ts';

// Every HTML page served from the base address must be on the public list, or the
// Worker refuses it once Access is on. See AGENTS.md (Public pages).
const root = path.resolve(import.meta.dirname, '..');

test('every base-address HTML page is on the public list', () => {
  const pages = [
    ...readdirSync(path.join(root, 'public')).filter((f) => f.endsWith('.html') && f !== '404.html'),
  ];
  const missing = pages.filter((f) => !isPublicPath(`/${f.replace(/\.html$/, '')}`) && !isPublicPath(`/${f}`));
  assert.deepEqual(missing, [], 'add these to PUBLIC_EXACT_PATHS in src/server/site/publicPaths.ts');
  assert.ok(PUBLIC_EXACT_PATHS.includes('/'), 'the marketing page at / must be public');
});

test('the app and API are never on the public list', () => {
  for (const p of PUBLIC_EXACT_PATHS) {
    assert.ok(!/^\/(app|api)([/.]|$)/.test(p), `${p} must stay behind Access`);
  }
});
