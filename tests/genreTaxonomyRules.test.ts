import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The genre taxonomy rules (docs/specs/genre-taxonomy-phase-a.md, section 9) guard privacy and
// the owner's curated links. These checks keep their key clauses from being dropped.
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('AGENTS.md keeps the genre taxonomy guards', () => {
  const agents = read('AGENTS.md');
  for (const clause of [
    'never through a stored `parent`',
    'never add to a total',
    'computed only from shared tables (`artist_genres`, `performances`), never over a `curated` row',
    "No relation is computed from any member's events, attendance or companions.",
    'music-story and MusicBrainz weights stay as sent',
  ]) {
    assert.ok(agents.includes(clause), `AGENTS.md is missing: ${clause}`);
  }
});

test('REQUIREMENTS.md keeps relations away from members\' events', () => {
  assert.ok(read('REQUIREMENTS.md').includes("never from any member's events, so nothing about who went where reaches them"));
});

test('ARCHITECTURE.md points at the taxonomy spec', () => {
  assert.ok(read('ARCHITECTURE.md').includes('docs/specs/genre-taxonomy-phase-a.md'));
});
