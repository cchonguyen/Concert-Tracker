import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEmailDate } from '../src/dates.ts';

test('a weekday fixes the year from the sending day', () => {
  // Sat Aug 29 falls on a Saturday in 2026.
  const d = readEmailDate('Sat Aug 29, 10:00 PM', '2026-06-01T12:00:00Z');
  assert.equal(d?.startDate, '2026-08-29');
});

test('no weekday and no year leaves the date missing', () => {
  const d = readEmailDate('Aug 29', '2026-06-01T12:00:00Z');
  assert.equal(d?.startDate, undefined);
  assert.equal(d?.quote, 'Aug 29');
});

test('a weekday that does not match the date is rejected', () => {
  const d = readEmailDate('Mon Aug 29, 2026', '2026-06-01T12:00:00Z');
  assert.equal(d?.startDate, undefined);
});
