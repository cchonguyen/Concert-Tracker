import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoggedEvent } from '../src/server/events/types.ts';
import {
  actsInOrder,
  EMPTY_FILTERS,
  filterEvents,
  filterOptions,
  filtersFromQuery,
  filtersToQuery,
  needsOf,
  summarize,
  tableDate,
  TableFilters,
} from '../src/services/table.ts';

const ev = (id: string, patch: Partial<LoggedEvent>): LoggedEvent => ({
  id,
  input: patch.name ?? id,
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

const events = [
  ev('a', {
    name: 'Porter Robinson',
    startDate: '2024-10-05',
    venue: 'Greek Theatre',
    city: 'Los Angeles, CA',
    seen: [{ key: 'porter robinson', name: 'Porter Robinson', from: 'you' }],
    companions: ['Sam'],
    rating: 5,
    ticketPrice: 80,
  }),
  ev('b', {
    name: 'Coachella',
    startDate: '2023-04-14',
    endDate: '2023-04-16',
    city: 'Indio, CA',
    seen: [
      { key: 'porter robinson', name: 'Porter Robinson', from: 'lineup' },
      { key: 'fred again', name: 'Fred again..', from: 'lineup' },
    ],
    editionId: 'ed1',
    sources: { startDate: { sourceType: 'email', sourceUrl: 'https://mail.google.com/x' } },
  }),
  ev('c', { name: 'Some show', year: 2023, details: { status: 'choose', candidates: [], notes: [] } }),
  ev('d', { name: 'Mystery night', details: { status: 'needs_date', candidates: [], notes: [] } }),
];

const f = (patch: Partial<TableFilters>): TableFilters => ({ ...EMPTY_FILTERS, ...patch });
const ids = (list: LoggedEvent[]) => list.map((e) => e.id);

test('table sorts newest first by default, with undated events last', () => {
  assert.deepEqual(ids(filterEvents(events, EMPTY_FILTERS)), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(filterEvents(events, f({ desc: false }))), ['c', 'b', 'a', 'd']);
  // Missing ratings sort last in both directions; they are gaps, not zeros.
  assert.deepEqual(ids(filterEvents(events, f({ sort: 'rating', desc: false }))).slice(0, 1), ['a']);
});

test('table search folds case and accents across acts, people and places', () => {
  assert.deepEqual(ids(filterEvents(events, f({ q: 'fred' }))), ['b']);
  assert.deepEqual(ids(filterEvents(events, f({ q: 'sam greek' }))), ['a']);
  assert.deepEqual(ids(filterEvents(events, f({ q: 'INDIO' }))), ['b']);
});

test('table filters by year, artist, rating and missing fields', () => {
  assert.deepEqual(ids(filterEvents(events, f({ yearFrom: 2023, yearTo: 2023 }))), ['b', 'c']);
  assert.deepEqual(ids(filterEvents(events, f({ artist: 'porter robinson' }))), ['a', 'b']);
  assert.deepEqual(ids(filterEvents(events, f({ minRating: 4 }))), ['a']);
  assert.deepEqual(ids(filterEvents(events, f({ has: { rating: 'no' } }))), ['b', 'c', 'd']);
  assert.deepEqual(ids(filterEvents(events, f({ has: { lineup: 'yes' } }))), ['b']);
  assert.deepEqual(ids(filterEvents(events, f({ origin: 'email' }))), ['b']);
  assert.deepEqual(ids(filterEvents(events, f({ origin: 'typed' }))), ['a', 'c', 'd']);
});

test('table needs filter matches the hints, including a lineup to review', () => {
  const lineups = { a: { jobId: 'j', status: 'needs_review' as const, actCount: 12 } };
  assert.equal(needsOf(events[3]), 'date');
  assert.equal(needsOf(events[2]), 'pick');
  assert.equal(needsOf(events[0], lineups.a), 'review');
  assert.equal(needsOf(events[1]), null);
  assert.deepEqual(ids(filterEvents(events, f({ needs: 'review' }), lineups)), ['a']);
});

test('table summary counts only what is set', () => {
  assert.deepEqual(summarize(events), {
    events: 4,
    acts: 2,
    venues: 1,
    firstYear: 2023,
    lastYear: 2024,
    rated: 1,
    averageRating: 5,
    priced: 1,
    totalPrice: 80,
    upcoming: 0,
    toConfirm: 0,
  });
  const empty = summarize([events[3]]);
  assert.equal(empty.averageRating, undefined);
  assert.equal(empty.firstYear, undefined);
  // Upcoming and unconfirmed events are counted apart, never in the figures.
  const planned = [
    ...events,
    ev('u', { startDate: '2026-12-01', attendance: 'planned', rating: 1, seen: [{ key: 'x', name: 'X', from: 'you' }] }),
    ev('p', { startDate: '2026-10-01', attendance: 'planned', venue: 'Shrine' }),
    ev('m', { startDate: '2026-09-01', attendance: 'missed', ticketPrice: 50 }),
  ];
  const s = summarize(planned, '2026-10-21');
  assert.equal(s.events, 4);
  assert.equal(s.acts, 2);
  assert.equal(s.venues, 1);
  assert.equal(s.averageRating, 5);
  assert.equal(s.totalPrice, 80);
  assert.equal(s.upcoming, 1);
  assert.equal(s.toConfirm, 1);
});

test('table pick lists come from your own log, most used first', () => {
  const o = filterOptions(events);
  assert.deepEqual(o.artists, [
    { key: 'porter robinson', name: 'Porter Robinson' },
    { key: 'fred again', name: 'Fred again..' },
  ]);
  assert.deepEqual(o.years, [2024, 2023]);
  assert.deepEqual(o.companions, ['Sam']);
});

test('table filters round-trip through the page address and ignore junk', () => {
  const filters = f({ q: 'porter', yearFrom: 2020, artist: 'porter robinson', has: { rating: 'no' }, needs: 'pick', sort: 'name', desc: false });
  const unset = { yearFrom: undefined, yearTo: undefined, minRating: undefined };
  assert.deepEqual(filtersFromQuery(filtersToQuery(filters)), { ...unset, ...filters });
  assert.equal(filtersToQuery(EMPTY_FILTERS), '');
  assert.deepEqual(filtersFromQuery('rating=9&needs=everything&sort=bogus&from=abc'), { ...EMPTY_FILTERS, ...unset });
});

test('table dates split into aligned parts and never fill what is missing', () => {
  assert.deepEqual(tableDate({ startDate: '2024-10-05' }), { day: '5', month: 'Oct', year: '2024', note: 'Sat' });
  assert.deepEqual(tableDate({ startDate: '2023-04-14', endDate: '2023-04-16' }), {
    day: '14',
    month: 'Apr',
    year: '2023',
    note: '3 days, to 16 Apr',
  });
  assert.deepEqual(tableDate({ startDate: '2024-12-30', endDate: '2025-01-01' })?.note, '3 days, to 1 Jan 2025');
  assert.deepEqual(tableDate({ startDate: '2024-06-01', endDate: '2024-06-01' })?.note, 'Sat');
  assert.deepEqual(tableDate({ year: 2024, month: 10 }), { month: 'Oct', year: '2024', note: 'Day not known' });
  assert.deepEqual(tableDate({ year: 2023 }), { year: '2023', note: 'Month not known' });
  assert.equal(tableDate({}), null);
});

test('table cells list headliners first, then your favourite set', () => {
  const act = (name: string, patch: Partial<LoggedEvent['seen'][number]> = {}) => ({ key: name, name, from: 'you' as const, ...patch });
  const order = actsInOrder([act('a'), act('b', { favourite: true }), act('c', { role: 'headliner' }), act('d')]);
  assert.deepEqual(
    order.map((s) => s.name),
    ['c', 'b', 'a', 'd'],
  );
});

test('format holds several values, and the format filter matches any of them', async () => {
  const { formatsOf, joinFormats } = await import('../src/services/format.ts');
  assert.deepEqual(formatsOf(' Club night, Rave ,, club night'), ['Club night', 'Rave']);
  assert.deepEqual(formatsOf(undefined), []);
  assert.equal(joinFormats(['Club night', 'Rave', 'rave']), 'Club night, Rave');
  assert.equal(joinFormats([]), null);
  const list = [ev('x', { format: 'Club night, Rave' }), ev('y', { format: 'Rave' }), ev('z', {})];
  assert.deepEqual(ids(filterEvents(list, f({ format: 'rave', sort: 'name', desc: false }))), ['x', 'y']);
  assert.deepEqual(filterOptions(list).formats, ['Rave', 'Club night']);
});
