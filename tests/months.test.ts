import assert from 'node:assert/strict';
import test from 'node:test';
import { isoDate, MONTH_NAMES, MONTH_PATTERN, MONTH_SHORT, monthIndex } from '../src/server/lineup/months.ts';

// The one month table and date check every date reader uses.
test('month words read by their first three letters; anything else is 0', () => {
  assert.equal(monthIndex('January'), 1);
  assert.equal(monthIndex('sept'), 9);
  assert.equal(monthIndex('DEC'), 12);
  assert.equal(monthIndex('Smarch'), 0);
  assert.equal(MONTH_NAMES[4], 'May');
  assert.equal(MONTH_SHORT[8], 'Sep');
});

test('the month pattern finds long, short and dotted forms', () => {
  const re = new RegExp(`^${MONTH_PATTERN}$`, 'i');
  for (const w of ['Jan', 'January', 'Sept.', 'june', 'Jul']) assert.ok(re.test(w), w);
  assert.ok(!re.test('Janu'));
});

test('a day that does not exist gives no date', () => {
  assert.equal(isoDate(2024, 2, 29), '2024-02-29');
  assert.equal(isoDate(2025, 2, 29), undefined);
  assert.equal(isoDate(2025, 13, 1), undefined);
  assert.equal(isoDate(2025, 4, 0), undefined);
});
