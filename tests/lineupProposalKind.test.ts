import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The owner review list accepts the lineup_proposal kind, and the shared type allows it.
// The database constraint for the kind is in migration 0050, held until applied.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the owner review list accepts the lineup_proposal kind', () => {
  const routes = read('src/server/canon/reviewRoutes.ts');
  const kinds = routes.split('\n').find((line) => line.startsWith('const KINDS')) ?? '';
  assert.match(kinds, /'lineup_proposal'/);
});

test('the review queue kind type includes lineup_proposal', () => {
  const types = read('src/server/lineup/types.ts');
  const line = types.split('\n').find((l) => l.startsWith('export type ReviewQueueKind')) ?? '';
  assert.match(line, /'lineup_proposal'/);
});
