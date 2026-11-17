import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLineupRequest } from '../src/server/lineup/canonicalIngest.ts';
import type { Edition } from '../src/server/lineup/types.ts';

function edition(over: Partial<Edition> = {}): Edition {
  return {
    id: 'e1',
    key: 'edc/2026',
    seriesKind: 'festival',
    year: 2026,
    name: 'EDC Las Vegas',
    startDate: '2026-05-15',
    endDate: '2026-05-17',
    venue: 'Speedway',
    city: 'Las Vegas',
    country: 'US',
    status: 'verified',
    performances: [],
    updatedAt: '2026-11-17T00:00:00Z',
    ...over,
  } as Edition;
}

test('a festival edition with no lineup builds the lookup from its own name, year and place', () => {
  const r = findLineupRequest(edition());
  assert.deepEqual(r, {
    ok: true,
    eventName: 'EDC Las Vegas',
    year: 2026,
    startDate: '2026-05-15',
    endDate: '2026-05-17',
    venue: 'Speedway',
    city: 'Las Vegas',
    country: 'US',
  });
});

test('tours and editions with no series kind are refused', () => {
  assert.equal(findLineupRequest(edition({ seriesKind: 'tour' })).ok, false);
  assert.equal(findLineupRequest(edition({ seriesKind: undefined })).ok, false);
});

test('an edition that already has acts is refused', () => {
  const r = findLineupRequest(edition({ performances: [{ artistKey: 'a', name: 'A' } as Edition['performances'][number]] }));
  assert.deepEqual(r, { ok: false, error: 'This edition already has a lineup.' });
});

test('a missing edition is reported as missing', () => {
  assert.deepEqual(findLineupRequest(null), { ok: false, error: 'No such edition.' });
});

test('a blank name or missing year is refused before any lookup', () => {
  assert.equal(findLineupRequest(edition({ name: '   ' })).ok, false);
  assert.equal(findLineupRequest(edition({ year: Number.NaN })).ok, false);
});
