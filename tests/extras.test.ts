import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLineup } from '../src/server/lineup/merge.ts';
import { mergeSeen } from '../src/server/lineup/learning.ts';
import { PerformerClaim } from '../src/server/lineup/types.ts';
import { actSets, setLabel } from '../src/server/events/sets.ts';
import { applyPatch, newEvent } from '../src/server/events/service.ts';
import { lookupWeather, placesFor, weatherDays } from '../src/server/events/weather.ts';
import { eventsToCsv, weatherLine, weatherText } from '../src/services/format.ts';
import { hasGap } from '../src/services/table.ts';
import { parseCsv } from '../src/services/listImport.ts';
import { LoggedEvent } from '../src/server/events/types.ts';
import { fakeFetcher } from './fakes.ts';

const NOW = new Date('2026-10-21T12:00:00Z');

let n = 0;
const claim = (partial: Partial<PerformerClaim>): PerformerClaim => ({
  id: String(++n),
  jobId: 'j',
  documentId: 'd',
  sourceType: 'clashfinder',
  sourceUrl: 'https://clashfinder.com/s/edc25/',
  name: 'Kaskade',
  quotedSpan: 'Kaskade',
  evidence: 'crowd',
  extractor: 'clashfinder',
  extractorVersion: '1',
  createdAt: '2025-01-01',
  ...partial,
});

test('set times from Clashfinder are kept on the source, every set of the act', () => {
  const lineup = mergeLineup({
    input: { eventName: 'EDC Las Vegas', year: 2025 },
    editionKey: 'edc-las-vegas/2025',
    seriesSlug: 'edc-las-vegas',
    facts: {},
    aliases: {},
    blocklist: [],
    stats: [],
    claims: [
      claim({ day: '2025-05-17', stage: 'kineticFIELD', startTime: '2025-05-17 23:30', endTime: '2025-05-18 00:45' }),
      claim({ day: '2025-05-16', stage: 'circuitGROUNDS', startTime: '2025-05-16 21:00', endTime: '2025-05-16 22:00' }),
      claim({ sourceType: 'promoter', sourceUrl: 'https://edc.example/lineup', evidence: 'billed' }),
    ],
  });
  const p = lineup.performers[0];
  assert.equal(p.sources.length, 2);
  const sets = actSets(p);
  assert.deepEqual(sets.map((s) => s.stage), ['circuitGROUNDS', 'kineticFIELD']); // in time order
  assert.equal(setLabel(sets[1], true), 'kineticFIELD · Sat 23:30–00:45');
  assert.equal(setLabel(sets[1], false), 'kineticFIELD · 23:30–00:45');
  // An untimed source has no sets.
  assert.equal(p.sources.find((s) => s.sourceType === 'promoter')!.sets, undefined);
});

test('one favourite set per event, and it outlives a lineup review', () => {
  const ev = newEvent('Porter Robinson 2024', NOW);
  const next = applyPatch(
    ev,
    { seen: [{ name: 'Porter Robinson', favourite: true }, { name: 'Wavedash', favourite: true }, { name: 'Jai Wolf' }] },
    NOW,
  );
  assert.deepEqual(next.seen.map((s) => Boolean(s.favourite)), [true, false, false]);
  const merged = mergeSeen(next.seen, [{ key: 'porter robinson', name: 'Porter Robinson', from: 'lineup' }], new Set(['porter robinson']));
  assert.equal(merged.find((s) => s.key === 'porter robinson')!.favourite, true);
});

const geocode = (results: unknown[]) => ({ 'https://geocoding-api.open-meteo.com/': { body: { results } } });
const VEGAS = { name: 'Las Vegas', admin1: 'Nevada', country_code: 'US', country: 'United States', feature_code: 'PPLA2', latitude: 36.17, longitude: -115.14 };
const VEGAS_NM = { ...VEGAS, admin1: 'New Mexico', latitude: 35.59, longitude: -105.22 };
const ARCHIVE = {
  'https://archive-api.open-meteo.com/': {
    body: {
      daily: {
        time: ['2025-05-16', '2025-05-17'],
        temperature_2m_max: [31.2, 33.8],
        temperature_2m_min: [21.9, 23.1],
        precipitation_sum: [0, 1.4],
        weather_code: [0, 61],
      },
    },
  },
};

test('a city is placed only when exactly one place matches it as written', () => {
  assert.equal(placesFor([VEGAS, VEGAS_NM], 'Las Vegas, NV').length, 1);
  assert.equal(placesFor([VEGAS, VEGAS_NM], 'Las Vegas').length, 2); // ambiguous
  assert.equal(placesFor([VEGAS, VEGAS_NM], 'Las Vegas', 'United States').length, 2);
  assert.equal(placesFor([{ ...VEGAS, feature_code: 'ADM2' }], 'Las Vegas, NV').length, 0);
  const berlin = { name: 'Berlin', admin1: 'Land Berlin', country_code: 'DE', country: 'Germany', feature_code: 'PPLC', latitude: 52.5, longitude: 13.4 };
  assert.equal(placesFor([berlin], 'Berlin, Germany').length, 1);
  assert.equal(placesFor([berlin], 'Berlin').length, 1);
});

test('weather comes from the archive for the event days, with its URL', async () => {
  const ev: LoggedEvent = { ...newEvent('EDC Las Vegas 2025', NOW), startDate: '2025-05-16', endDate: '2025-05-17', city: 'Las Vegas, NV' };
  const { fetcher, calls } = fakeFetcher({ ...geocode([VEGAS, VEGAS_NM]), ...ARCHIVE });
  const { weather, note } = await lookupWeather(ev, fetcher, NOW);
  assert.equal(note, undefined);
  assert.equal(weather!.place, 'Las Vegas, NV');
  assert.equal(weather!.days.length, 2);
  assert.match(calls[1], /start_date=2025-05-16&end_date=2025-05-17/);
  assert.equal(weather!.sourceUrl, calls[1]);
  assert.equal(weatherLine(weather!.days[0]), 'Clear · 31°/22°C (88°/71°F)');
  assert.equal(weatherLine(weather!.days[1]), 'Rain · 34°/23°C (93°/74°F) · 1.4 mm');
  assert.match(weatherText({ ...ev, weather }), /^May 16: Clear/);
});

test('no weather without a past date and a city it can place', async () => {
  const base = { ...newEvent('Show', NOW), city: 'Las Vegas' };
  const { fetcher, calls } = fakeFetcher({ ...geocode([VEGAS, VEGAS_NM]), ...ARCHIVE });
  assert.match((await lookupWeather({ ...base, city: undefined, startDate: '2025-01-01' }, fetcher, NOW)).note!, /city/);
  assert.match((await lookupWeather({ ...base, startDate: '2026-12-01' }, fetcher, NOW)).note!, /passed/);
  assert.match((await lookupWeather({ ...base, startDate: '2026-10-19' }, fetcher, NOW)).note!, /fills in/);
  assert.equal(calls.length, 0);
  const ambiguous = await lookupWeather({ ...base, startDate: '2025-01-01' }, fetcher, NOW);
  assert.equal(ambiguous.weather, undefined);
  assert.match(ambiguous.note!, /More than one place/);
  assert.equal(weatherDays({}).length, 0);
});

test('Fill gaps finds a missing favourite and weather; CSV has both', () => {
  const ev: LoggedEvent = {
    ...newEvent('Show', NOW),
    startDate: '2024-10-05',
    city: 'Los Angeles, CA',
    seen: [{ key: 'porter robinson', name: 'Porter Robinson', from: 'you' }],
  };
  assert.equal(hasGap(ev, 'favourite'), true);
  assert.equal(hasGap(ev, 'weather'), true);
  assert.equal(hasGap({ ...ev, city: undefined }, 'weather'), false);
  assert.equal(hasGap({ ...ev, startDate: '2999-01-01' }, 'weather'), false);
  const fav = { ...ev, seen: [{ ...ev.seen[0], favourite: true }] };
  assert.equal(hasGap(fav, 'favourite'), false);
  const [cols, cells] = parseCsv(eventsToCsv([fav]));
  assert.equal(cells[cols.indexOf('Favourite set')], 'Porter Robinson');
  assert.ok(cols.includes('Weather'));
});
