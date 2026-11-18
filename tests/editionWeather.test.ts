import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Edition } from '../src/server/lineup/types.ts';
import type { EventWeather } from '../src/server/events/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';

const weather: EventWeather = {
  place: 'Las Vegas, NV',
  latitude: 36.17,
  longitude: -115.14,
  days: [{ date: '2026-10-10', high: 27, low: 15, precipitation: 0, code: 1 }],
  sourceUrl: 'https://archive-api.open-meteo.com/v1/archive?latitude=36.17',
  checkedAt: '2026-11-18T00:00:00.000Z',
};

const edition = (weatherField?: EventWeather | null): Edition => ({
  id: 'ed-1',
  key: 'fest-2026',
  year: 2026,
  name: 'Fest 2026',
  status: 'verified',
  updatedAt: '2026-11-18T00:00:00.000Z',
  performances: [],
  ...(weatherField !== undefined ? { weather: weatherField } : {}),
});

test('edition weather: an upsert without weather keeps the stored record', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'edition-weather-'));
  try {
    const store = new FileLineupStore(dir);
    await store.upsertEdition(edition(weather));
    await store.upsertEdition(edition());
    assert.deepEqual((await store.getEdition('ed-1'))?.weather, weather);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('edition weather: a value replaces the record and null clears it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'edition-weather-'));
  try {
    const store = new FileLineupStore(dir);
    await store.upsertEdition(edition());
    assert.equal((await store.getEdition('ed-1'))?.weather, undefined);
    await store.upsertEdition(edition(weather));
    assert.deepEqual((await store.getEdition('ed-1'))?.weather, weather);
    await store.upsertEdition(edition(null));
    assert.equal((await store.getEdition('ed-1'))?.weather, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Slice 2: a save from an edition copies the edition's record, or looks it up once and keeps it there.
import { weatherForEdition } from '../src/server/events/editionWeather.ts';
import { writeEdition } from '../src/server/canon/editions.ts';
import { lookupWeather } from '../src/server/events/weather.ts';
import type { LoggedEvent } from '../src/server/events/types.ts';
import { fakeFetcher } from './fakes.ts';

const NOW = new Date('2026-10-21T12:00:00Z');
const VEGAS = { name: 'Las Vegas', admin1: 'Nevada', country_code: 'US', country: 'United States', feature_code: 'PPLA2', latitude: 36.17, longitude: -115.14 };
const ROUTES = {
  'https://geocoding-api.open-meteo.com/': { body: { results: [VEGAS] } },
  'https://archive-api.open-meteo.com/': {
    body: { daily: { time: ['2025-05-16'], temperature_2m_max: [31.2], temperature_2m_min: [21.9], precipitation_sum: [0], weather_code: [0] } },
  },
};
const event = { id: 'ev-1', city: 'Las Vegas, NV', startDate: '2025-05-16', endDate: '2025-05-16', sources: {} } as unknown as LoggedEvent;

test('edition weather: a save copies the edition record without a lookup', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'edition-weather-'));
  try {
    const store = new FileLineupStore(dir);
    await store.upsertEdition(edition(weather));
    const { fetcher, calls } = fakeFetcher(ROUTES);
    const got = await weatherForEdition(store, (await store.getEdition('ed-1'))!, event, fetcher, NOW);
    assert.equal(got.source, 'edition');
    assert.deepEqual(got.weather, weather);
    assert.equal(calls.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('edition weather: with no record, one lookup fills the edition, is recorded, and is reused', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'edition-weather-'));
  try {
    const store = new FileLineupStore(dir);
    await store.upsertEdition(edition());
    const { fetcher, calls } = fakeFetcher(ROUTES);
    const first = await weatherForEdition(store, (await store.getEdition('ed-1'))!, event, fetcher, NOW);
    assert.equal(first.source, 'lookup');
    assert.equal((await store.getEdition('ed-1'))?.weather?.place, 'Las Vegas, NV');
    const callsAfterFirst = calls.length;
    const second = await weatherForEdition(store, (await store.getEdition('ed-1'))!, event, fetcher, NOW);
    assert.equal(second.source, 'edition');
    assert.equal(calls.length, callsAfterFirst);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('edition weather: a change to the record is recorded in the edition history', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'edition-weather-'));
  try {
    const store = new FileLineupStore(dir);
    const before = edition();
    await store.upsertEdition(before);
    const res = await writeEdition(store, { edition: { ...before, weather }, before, actor: 'test', reason: 'check' });
    assert.equal(res.changed, true);
    assert.equal(res.change?.after?.weather !== undefined, true);
    const unchanged = await writeEdition(store, { edition: { ...before, name: before.name }, actor: 'test', reason: 'no weather key' });
    assert.equal(unchanged.changed, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('edition weather: a month-only event gets no weather and no fetch', async () => {
  const { fetcher, calls } = fakeFetcher(ROUTES);
  const got = await lookupWeather({ ...event, startDate: '2025-05' } as LoggedEvent, fetcher, NOW);
  assert.match(got.note!, /full date/);
  assert.equal(calls.length, 0);
});

// Slice 3: a member's own record for the edition's place and days is promoted when the event is linked.
import { promotableWeather } from '../src/server/events/editionWeather.ts';

const linkEdition = (over: Partial<Edition> = {}): Edition => ({
  ...edition(),
  city: 'Las Vegas',
  region: 'NV',
  startDate: '2025-05-16',
  endDate: '2025-05-17',
  ...over,
});
const withWeather = (w: EventWeather | undefined) => ({ ...event, weather: w }) as LoggedEvent;

test('edition weather: a member record for the same place and inside the dates is promoted without a lookup', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'edition-weather-'));
  try {
    const store = new FileLineupStore(dir);
    const ed = linkEdition();
    await store.upsertEdition(ed);
    const { fetcher, calls } = fakeFetcher(ROUTES);
    const member = withWeather({ ...weather, place: 'Las Vegas, NV', days: [{ date: '2025-05-16', high: 30, low: 20, precipitation: 0, code: 0 }] });
    const got = await weatherForEdition(store, (await store.getEdition('ed-1'))!, member, fetcher, NOW);
    assert.equal(got.source, 'promoted');
    assert.equal(calls.length, 0);
    assert.equal((await store.getEdition('ed-1'))?.weather?.days[0].date, '2025-05-16');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('edition weather: promotion refuses another place, days outside the dates, and cityChanged records', () => {
  const ed = linkEdition();
  const inside = { place: 'Las Vegas, NV', latitude: 1, longitude: 1, days: [{ date: '2025-05-16', high: 1, low: 1, precipitation: 0, code: 0 }], sourceUrl: 'u', checkedAt: 'c' };
  assert.ok(promotableWeather(withWeather(inside), ed));
  assert.equal(promotableWeather(withWeather({ ...inside, place: 'Reno, NV' }), ed), undefined);
  assert.equal(promotableWeather(withWeather({ ...inside, days: [{ date: '2025-06-01', high: 1, low: 1, precipitation: 0, code: 0 }] }), ed), undefined);
  assert.equal(promotableWeather(withWeather({ ...inside, cityChanged: true }), ed), undefined);
  assert.equal(promotableWeather(withWeather(undefined), ed), undefined);
});

// Slice 4: the owner's refresh replaces the record, is in the edition history, and can be undone.
import { refreshEditionWeather } from '../src/server/events/editionWeather.ts';
import { undoEditionChange } from '../src/server/canon/editions.ts';

test('edition weather: owner refresh replaces the record and the change can be undone', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'edition-weather-'));
  try {
    const store = new FileLineupStore(dir);
    const before = linkEdition({ weather });
    await store.upsertEdition(before);
    const { fetcher } = fakeFetcher(ROUTES);
    const out = await refreshEditionWeather(store, before, fetcher, NOW, 'owner');
    assert.equal(out.changed, true);
    assert.equal((await store.getEdition('ed-1'))?.weather?.days[0].high, 31.2);
    const changes = await store.listEditionChanges?.('ed-1');
    const change = changes?.[0];
    assert.ok(change, 'the refresh is in the edition history');
    const undone = await undoEditionChange(store, 'ed-1', change!.id, 'owner');
    assert.equal(undone.ok, true);
    assert.equal((await store.getEdition('ed-1'))?.weather?.days[0].high, 27);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('edition weather: a refresh the archive cannot answer keeps the stored record', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'edition-weather-'));
  try {
    const store = new FileLineupStore(dir);
    const before = linkEdition({ weather });
    await store.upsertEdition(before);
    const { fetcher } = fakeFetcher({});
    const out = await refreshEditionWeather(store, before, fetcher, NOW, 'owner');
    assert.equal(out.changed, false);
    assert.equal((await store.getEdition('ed-1'))?.weather?.days[0].high, 27);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
