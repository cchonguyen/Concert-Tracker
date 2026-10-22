import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoggedEvent } from '../src/server/events/types.ts';
import { homeSummary } from '../src/services/home.ts';

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

const TODAY = '2026-10-21';

test('home splits upcoming, recent and on this day by the date you gave', () => {
  const events = [
    ev('next', { startDate: '2026-12-01' }),
    ev('soon', { startDate: '2026-11-02' }),
    ev('today', { startDate: '2026-10-21', venue: 'Shrine' }),
    ev('anniv', { startDate: '2023-10-21', venue: 'shrine', seen: [{ key: 'x', name: 'X', from: 'you' }] }),
    ev('old', { startDate: '2019-05-01', seen: [{ key: 'x', name: 'X', from: 'you' }, { key: 'y', name: 'Y', from: 'you' }] }),
    ev('undated', { details: { status: 'needs_date', candidates: [], notes: [] } }),
  ];
  const s = homeSummary(events, {}, TODAY, 2);
  assert.deepEqual(s.upcoming.map((e) => e.id), ['soon', 'next']);
  assert.deepEqual(s.recent.map((e) => e.id), ['today', 'anniv']);
  assert.deepEqual(s.onThisDay.map((e) => e.id), ['anniv']);
  assert.equal(s.events, 4); // shows still ahead are not counted yet
  assert.equal(s.artists, 2);
  assert.equal(s.venues, 1); // "Shrine" and "shrine" are one venue
  assert.equal(s.thisYear, 1); // shows still ahead are not counted yet
  assert.deepEqual(s.needs, { date: 1, pick: 0, review: 0 });
});

test('home counts lineups waiting for review', () => {
  const s = homeSummary([ev('a', { startDate: '2025-01-01' })], { a: { jobId: 'j', status: 'needs_review', actCount: 3 } }, TODAY);
  assert.deepEqual(s.needs, { date: 0, pick: 0, review: 1 });
});

test('home leaves out events you have not confirmed going to, and asks about the ones that are over', () => {
  const events = [
    ev('ahead', { startDate: '2026-11-02', attendance: 'planned', seen: [{ key: 'z', name: 'Z', from: 'you' }] }),
    ev('over', { startDate: '2026-10-10', attendance: 'planned', venue: 'Echo', seen: [{ key: 'y', name: 'Y', from: 'you' }] }),
    ev('older', { startDate: '2026-09-01', endDate: '2026-09-03', attendance: 'planned' }),
    ev('missed', { startDate: '2026-08-01', attendance: 'missed', venue: 'Fonda' }),
    ev('went', { startDate: '2026-07-01', venue: 'Shrine', seen: [{ key: 'x', name: 'X', from: 'you' }] }),
  ];
  const s = homeSummary(events, {}, TODAY);
  assert.equal(s.events, 1);
  assert.equal(s.artists, 1);
  assert.equal(s.venues, 1);
  assert.equal(s.thisYear, 1);
  assert.deepEqual(s.upcoming.map((e) => e.id), ['ahead']);
  assert.deepEqual(s.toConfirm.map((e) => e.id), ['over', 'older']);
  assert.deepEqual(s.recent.map((e) => e.id), ['went']);
});
