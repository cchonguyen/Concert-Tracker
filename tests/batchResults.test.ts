import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchResultsWaiting } from '../src/services/table.ts';
import { newEvent } from '../src/server/events/service.ts';
import type { LoggedEvent } from '../src/server/events/types.ts';

const NOW = new Date('2026-11-18T12:00:00Z');
const cand = { id: 'c1', name: 'Test Fest', startDate: '2024-10-05', venue: 'Greek Theatre', sources: [{ sourceType: 'setlistfm' as const, sourceUrl: 'https://www.setlist.fm/x', fields: ['startDate' as const] }] };
const withState = (e: LoggedEvent, status: LoggedEvent['details']['status'], candidates = [cand]): LoggedEvent => ({
  ...e,
  details: { ...e.details, status, candidates },
});

test('Slice 3.2: a year and a city with research waiting for a tap is listed; a dated or city-less one is not', () => {
  const waiting = { ...withState(newEvent('Test Fest 2024', NOW), 'choose'), city: 'Los Angeles' };
  const dated = { ...withState(newEvent('Test Fest 2024 Oct 5', NOW), 'choose'), city: 'Los Angeles', startDate: '2024-10-05' };
  const noCity = withState(newEvent('Other Fest 2024', NOW), 'choose');
  const nothingFound = { ...withState(newEvent('Third Fest 2024', NOW), 'choose', []), city: 'Los Angeles' };
  const pending = { ...withState(newEvent('Fourth Fest 2024', NOW), 'pending'), city: 'Los Angeles' };
  assert.deepEqual(batchResultsWaiting([waiting, dated, noCity, nothingFound, pending]).map((e) => e.id), [waiting.id]);
});
