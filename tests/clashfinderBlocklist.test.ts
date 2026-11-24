import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlocked } from '../src/server/lineup/merge.ts';

// Production (2026-11-24): Clashfinder rejections from other editions had
// blocked "Hausman", "Paul van Dyk" and "Alpha 9 Ilan Bluestone" on
// clashfinder.com, so the 2026 Dreamstate SoCal clash lost them (70 acts in, 57 out).
test('a Clashfinder rejection in one edition does not block the name in another', () => {
  const blocklist = [{ domain: 'clashfinder.com', normalized: 'hausman', rejections: 2 }] as any;
  assert.equal(isBlocked('Hausman', 'https://clashfinder.com/s/ds26/', blocklist), false);
  assert.equal(isBlocked('Paul van Dyk pres Essence of Acid', 'https://clashfinder.com/s/ds26/', [
    { domain: 'clashfinder.com', normalized: 'paul van dyk', rejections: 2 },
  ] as any), false);
});

test('other sites still block a name after two rejections', () => {
  const blocklist = [{ domain: 'press.example.com', normalized: 'hausman', rejections: 2 }] as any;
  assert.equal(isBlocked('Hausman', 'https://press.example.com/lineup', blocklist), true);
  assert.equal(isBlocked('Hausman', 'https://press.example.com/lineup', [
    { domain: 'press.example.com', normalized: 'hausman', rejections: 1 },
  ] as any), false);
});
