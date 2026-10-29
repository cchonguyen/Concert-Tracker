import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARTIST_MILESTONES, artistMilestoneLine, highestMilestoneCrossed, milestoneCounts, milestoneLine } from '../src/services/milestones';
import type { LoggedEvent } from '../src/server/events/types.ts';

const TODAY = '2026-10-29';

const ev = (id: string, patch: Partial<LoggedEvent>): LoggedEvent => ({
  id,
  input: id,
  name: id,
  sources: {},
  details: { status: 'resolved', candidates: [], notes: [] },
  seen: [],
  daysAttended: [],
  companions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...patch,
});

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

test('the artist milestone fires once at 100 seen acts', () => {
  assert.equal(highestMilestoneCrossed(99, 100, ARTIST_MILESTONES), 100);
  assert.equal(highestMilestoneCrossed(100, 101, ARTIST_MILESTONES), null);
  assert.equal(artistMilestoneLine(100), "100 artists seen! That's a lineup you built yourself.");
});

test('artists count distinct acts at attended shows only', () => {
  const events = [
    ev('went', { startDate: '2026-01-01', seen: [{ key: 'x', name: 'X', from: 'you' }, { key: 'y', name: 'Y', from: 'you' }] }),
    ev('again', { startDate: '2026-02-01', seen: [{ key: 'x', name: 'X', from: 'you' }] }),
    ev('missed', { startDate: '2026-03-01', attendance: 'missed', seen: [{ key: 'z', name: 'Z', from: 'you' }] }),
    ev('ahead', { startDate: '2026-12-01', seen: [{ key: 'w', name: 'W', from: 'you' }] }),
    ev('planned', { startDate: '2026-11-01', attendance: 'planned', seen: [{ key: 'v', name: 'V', from: 'you' }] }),
  ];
  assert.deepEqual(milestoneCounts(events, TODAY), { shows: 5, artists: 2 });
});
