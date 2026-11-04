import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const handoff = readFileSync(path.resolve(import.meta.dirname, '..', '.spec', 'SESSION_HANDOFF.md'), 'utf8');

test('the session handoff names the fields the external agent rules expect', () => {
  for (const field of ['Last Active Platform', 'Active Branch / State', 'Verification Status', 'Open gaps', 'Immediate Next Step']) {
    assert.match(handoff, new RegExp(`\\*\\*${field}:\\*\\*`), `missing field: ${field}`);
  }
});
