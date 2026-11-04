import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// Cloudflare Workers Builds installs with bun 1.2.15 when bun.lock exists. That
// bun cannot read lockfile v2, so a stray bun.lock breaks every build. The npm
// lockfile is the only one the project uses.
const root = path.resolve(import.meta.dirname, '..');

test('package-lock.json is the only lockfile, and bun.lock stays out of the repo', () => {
  assert.equal(existsSync(path.join(root, 'package-lock.json')), true);
  assert.equal(existsSync(path.join(root, 'bun.lock')), false);
});
