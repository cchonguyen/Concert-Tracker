import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoggedEvent } from '../src/server/events/types.ts';
import { cityPoint } from '../src/server/events/place.ts';
import { mapData, placeKey, placeQuery, playbackYears, trail, travel } from '../src/services/map.ts';
import { fakeFetcher } from './fakes.ts';

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
const odesza = { key: 'odesza', name: 'Odesza', from: 'you' as const };
const LA = { lat: 34, lon: -118, match: 'exact' as const };
const LV = { lat: 36, lon: -115, match: 'exact' as const };
const PARIS = { lat: 48, lon: 2, match: 'name' as const };

const events = [
  ev('a', { startDate: '2022-05-01', city: 'Los Angeles, CA', seen: [odesza] }),
  ev('b', { startDate: '2023-05-01', city: 'Los Angeles, CA' }),
  ev('c', { startDate: '2021-05-01', city: 'Las Vegas, NV', seen: [odesza] }),
  ev('d', { startDate: '2024-05-01', city: 'Paris', country: 'France', seen: [odesza] }),
  ev('e', { year: 2020, city: 'Atlantis' }),
  ev('f', { year: 2020 }),
  ev('g', { year: 2020, city: 'Springfield' }),
];
const points = {
  'Los Angeles, CA|': LA,
  'Las Vegas, NV|': LV,
  'Paris|France': PARIS,
  'Atlantis|': null,
};

test('map groups events by the city you stored and says what it could not place', () => {
  assert.equal(placeKey(events[3]), 'Paris|France');
  assert.deepEqual(placeQuery('Paris|France'), { city: 'Paris', country: 'France' });
  assert.deepEqual(placeQuery('Las Vegas, NV|'), { city: 'Las Vegas, NV', country: undefined });
  const d = mapData(events, points);
  assert.deepEqual(d.places.map((p) => [p.city, p.events.map((e) => e.id)]), [
    ['Los Angeles, CA', ['b', 'a']],
    ['Las Vegas, NV', ['c']],
    ['Paris', ['d']],
  ]);
  assert.equal(d.noCity, 1);
  assert.deepEqual(d.notFound.map((e) => e.id), ['e']);
  assert.equal(d.pending, 1);
});

test('map counts cities, states and countries from what you stored', () => {
  assert.deepEqual(travel(mapData(events, points).places), { cities: 3, regions: 2, countries: 2 });
});

test('artist trail runs oldest first through placed cities', () => {
  assert.deepEqual(trail(events, 'odesza', points).map((s) => s.event.id), ['c', 'a', 'd']);
  assert.deepEqual(playbackYears(events), [2020, 2021, 2022, 2023, 2024]);
});

test('city points match the state or country you wrote, else the biggest place by name', async () => {
  const { fetcher, calls } = fakeFetcher({
    'https://geocoding-api.open-meteo.com/': {
      body: {
        results: [
          { name: 'Springfield', admin1: 'Missouri', country_code: 'US', country: 'United States', feature_code: 'PPLA2', population: 169000, latitude: 37.2, longitude: -93.3 },
          { name: 'Springfield', admin1: 'Illinois', country_code: 'US', country: 'United States', feature_code: 'PPLA', population: 114000, latitude: 39.8, longitude: -89.6 },
          { name: 'Springfield Creek', admin1: 'Illinois', country_code: 'US', feature_code: 'STM', latitude: 1, longitude: 1 },
        ],
      },
    },
  });
  assert.deepEqual(await cityPoint('Springfield, IL', undefined, fetcher), { lat: 39.8, lon: -89.6, match: 'exact' });
  assert.deepEqual(await cityPoint('Springfield', 'United States', fetcher), { lat: 37.2, lon: -93.3, match: 'exact' });
  assert.deepEqual(await cityPoint('Springfield', undefined, fetcher), { lat: 37.2, lon: -93.3, match: 'name' });
  assert.equal(await cityPoint('Springfield, OR', undefined, fetcher), null, 'a state that does not match is not guessed');
  assert.equal(calls.length, 4);
  await cityPoint('Springfield, IL', undefined, fetcher);
  assert.equal(calls.length, 4, 'cached');
});
