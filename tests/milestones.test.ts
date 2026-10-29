import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARTIST_MILESTONES, artistMilestoneLine, highestMilestoneCrossed, milestoneLine } from '../src/services/milestones';

test('a single show crossing 1 earns the first milestone', () => {
  assert.equal(highestMilestoneCrossed(0, 1), 1);
});

test('no card when no milestone is crossed', () => {
  assert.equal(highestMilestoneCrossed(11, 12), null);
  assert.equal(highestMilestoneCrossed(50, 50), null);
});

test('a bulk jump shows only the highest milestone', () => {
  assert.equal(highestMilestoneCrossed(3, 120), 100);
});

test('a count that shrinks crosses nothing', () => {
  assert.equal(highestMilestoneCrossed(100, 40), null);
});

test('large milestones read with separators', () => {
  assert.equal(milestoneLine(1000), "1,000 shows! You're a legend of the floor.");
});

test('the artists milestone fires at 100 seen artists', () => {
  assert.equal(highestMilestoneCrossed(99, 100, ARTIST_MILESTONES), 100);
  assert.equal(highestMilestoneCrossed(100, 101, ARTIST_MILESTONES), null);
  assert.equal(artistMilestoneLine(100), '100 artists seen live!');
});
