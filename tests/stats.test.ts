import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoggedEvent } from '../src/server/events/types.ts';
import { allTime, facts, pastEvents, perYear, top, yearInReview } from '../src/services/stats.ts';

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
const act = (name: string) => ({ key: name.toLowerCase(), name, from: 'you' as const });

const events = [
  ev('a', { startDate: '2021-03-01', venue: 'The Shrine', city: 'Los Angeles', seen: [act('Odesza')], companions: ['Sam'] }),
  ev('b', { startDate: '2021-03-20', venue: 'the shrine', city: 'Los Angeles', seen: [act('Odesza'), act('Bonobo')], rating: 4 }),
  ev('c', { startDate: '2023-06-01', endDate: '2023-06-03', venue: 'The Shrine', seen: [act('Bonobo'), act('Fred again..')], companions: ['Sam'], rating: 5 }),
  ev('d', { year: 2023, city: 'Indio' }),
  ev('e', { name: 'Undated' }),
  ev('ahead', { startDate: '2026-12-01', seen: [act('Odesza')] }),
];
const past = pastEvents(events, '2026-10-21');

test('stats leave out events still ahead', () => {
  assert.deepEqual(past.map((e) => e.id), ['a', 'b', 'c', 'd', 'e']);
});

test('stats count events per year with empty years as gaps', () => {
  const { years, undated } = perYear(past);
  assert.deepEqual(years, [
    { year: 2021, events: 2, newArtists: 2 },
    { year: 2022, events: 0, newArtists: 0 },
    { year: 2023, events: 2, newArtists: 1 },
  ]);
  assert.equal(undated, 1);
});

test('stats rank by events and count spellings together', () => {
  assert.deepEqual(top(past, 'artist', 2), [
    { key: 'bonobo', label: 'Bonobo', count: 2 },
    { key: 'odesza', label: 'Odesza', count: 2 },
  ]);
  assert.deepEqual(top(past, 'venue'), [{ key: 'The Shrine', label: 'The Shrine', count: 3 }]);
  assert.deepEqual(top(past, 'companion'), [{ key: 'Sam', label: 'Sam', count: 2 }]);
});

test('year in review uses only that year and says how many are rated', () => {
  const r = yearInReview(past, 2021);
  assert.equal(r.events, 2);
  assert.equal(r.artists, 2);
  assert.deepEqual(r.newArtists, ['Bonobo', 'Odesza']);
  assert.deepEqual(r.topArtist, { key: 'odesza', label: 'Odesza', count: 2 });
  assert.equal(r.topVenue?.count, 2);
  assert.deepEqual(r.busiestMonth, { month: 3, events: 2 });
  assert.equal(r.rated, 1);
  assert.equal(r.averageRating, 4);
  const empty = yearInReview(past, 2022);
  assert.equal(empty.events, 0);
  assert.equal(empty.averageRating, undefined);
  assert.equal(empty.topArtist, undefined);
});

test('fun facts: first event, longest break, busiest stretch, acts per event', () => {
  const f = facts(past);
  assert.equal(f.first?.id, 'a');
  assert.equal(f.longestGap?.from.id, 'b');
  assert.equal(f.longestGap?.to.id, 'c');
  assert.equal(f.longestGap?.days, 803);
  assert.deepEqual(f.busiestStretch, { events: 2, from: '2021-03-01', to: '2021-03-20' });
  assert.deepEqual(f.actsPerEvent, { average: 1.7, events: 3 });
  assert.equal(facts([]).first, undefined);
});

test('All time counts shows, acts, venues, cities, years, rating and spend over events you went to', () => {
  const all = [...events, ev('priced', { startDate: '2024-02-02', venue: 'Pier 70', city: 'San Francisco', region: 'CA', ticketPrice: 80, seen: [act('Bonobo')] })];
  const t = allTime(all, '2026-10-21');
  assert.equal(t.events, 6, 'the show still ahead is left out');
  assert.equal(t.upcoming, 1);
  assert.equal(t.acts, 3);
  assert.equal(t.venues, 2, 'The Shrine is one venue however it is spelled');
  assert.equal(t.cities, 3);
  assert.equal(t.firstYear, 2021);
  assert.equal(t.lastYear, 2024);
  assert.equal(t.rated, 2);
  assert.equal(t.averageRating, 4.5);
  assert.equal(t.priced, 1);
  assert.equal(t.totalPrice, 80);
});

test('All time over nothing is all zeros with no rating, spend or years', () => {
  const t = allTime([], '2026-10-21');
  assert.deepEqual([t.events, t.acts, t.venues, t.cities, t.rated, t.priced], [0, 0, 0, 0, 0, 0]);
  assert.equal(t.averageRating, undefined);
  assert.equal(t.totalPrice, undefined);
  assert.equal(t.firstYear, undefined);
});
