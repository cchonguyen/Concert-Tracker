import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setlistfmFinder } from '../src/server/events/details.ts';
import type { Fetcher, FetchResponse } from '../src/server/lineup/types.ts';

// Stage 2.2: setlist.fm keeps a show when its venue is the one typed, its city is the
// typed city, or it is within the metro radius. Pages are routed by their p= parameter.
const LA_POINT = { results: [{ name: 'Los Angeles', latitude: 34.0522, longitude: -118.2437, feature_code: 'PPLA2', country_code: 'US', admin1: 'California', country: 'United States', population: 3898747 }] };

const show = (venue: string, city: string, lat: number | null, lon: number | null, date = '10-10-2026', artist = 'Gryffin') => ({
  eventDate: date,
  url: `https://www.setlist.fm/setlist/${venue.replace(/\W+/g, '-').toLowerCase()}`,
  artist: { name: artist },
  venue: {
    name: venue,
    city: {
      name: city,
      stateCode: 'CA',
      country: { code: 'US', name: 'United States' },
      ...(lat !== null && lon !== null ? { coords: { lat, long: lon } } : {}),
    },
  },
});

function router(pages: Record<string, unknown>) {
  const calls: string[] = [];
  const fetcher: Fetcher = {
    async get(url: string): Promise<FetchResponse> {
      calls.push(url);
      if (url.startsWith('https://geocoding-api.open-meteo.com/')) {
        return { url, status: 200, headers: {}, body: JSON.stringify(LA_POINT) };
      }
      const page = new URL(url).searchParams.get('p') ?? '1';
      const body = pages[page];
      if (!body) return { url, status: 404, headers: {}, body: '' };
      return { url, status: 200, headers: {}, body: JSON.stringify(body) };
    },
  };
  return { fetcher, calls };
}

async function withKey<T>(fn: () => Promise<T>): Promise<T> {
  process.env.SETLISTFM_API_KEY = 'k';
  try {
    return await fn();
  } finally {
    delete process.env.SETLISTFM_API_KEY;
  }
}

test('setlist.fm with a city: keeps the typed venue, the city and a suburb in the radius, drops a distant city', () =>
  withKey(async () => {
    const { fetcher } = router({
      1: {
        setlist: [
          show('Shrine Expo Hall', 'Los Angeles', 34.03, -118.26),
          show('Fonda Theatre', 'Los Angeles', 34.1, -118.33),
          show('The Forum', 'Inglewood', 33.9617, -118.3531),
          show('Open Air Stage', 'San Diego', 32.7157, -117.1611),
        ],
      },
    });

    const found = await setlistfmFinder.find({ name: 'Gryffin', year: 2026, city: 'Los Angeles, CA', venue: 'Shrine Expo Hall' }, fetcher);

    assert.deepEqual(found.map((c) => c.venue).sort(), ['Fonda Theatre', 'Shrine Expo Hall', 'The Forum']);
  }));

test('setlist.fm with a city: a full page that keeps nothing is followed by page 2', () =>
  withKey(async () => {
    const full = Array.from({ length: 20 }, (_, i) => show(`Far Hall ${i}`, 'San Diego', 32.7157, -117.1611, `${String((i % 28) + 1).padStart(2, '0')}-09-2026`));
    const { fetcher, calls } = router({
      1: { setlist: full },
      2: { setlist: [show('Wiltern', 'Los Angeles', 34.06, -118.32)] },
    });

    const found = await setlistfmFinder.find({ name: 'Gryffin', year: 2026, city: 'Los Angeles' }, fetcher);

    assert.deepEqual(found.map((c) => c.venue), ['Wiltern']);
    assert.ok(calls.some((u) => u.includes('p=2')), 'page 2 was requested');
  }));

test('setlist.fm without a city: every show by the act in the year is kept, as before', () =>
  withKey(async () => {
    const { fetcher, calls } = router({
      1: { setlist: [show('Shrine Expo Hall', 'Los Angeles', 34.03, -118.26), show('Open Air Stage', 'San Diego', 32.7157, -117.1611)] },
    });

    const found = await setlistfmFinder.find({ name: 'Gryffin', year: 2026 }, fetcher);

    assert.equal(found.length, 2);
    assert.equal(calls.some((u) => u.includes('open-meteo')), false, 'no city lookup without a city');
    assert.equal(calls.some((u) => u.includes('p=2')), false, 'no page 2 without a city');
  }));
