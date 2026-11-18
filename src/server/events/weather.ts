import { cityWithRegion, regionCode } from './regions';
import type { Fetcher } from '../lineup/types';
import { parseJson } from '../lineup/http';
import { normalizeName } from '../lineup/text';
import { geocodeLabel } from './place';
import type { EventWeather, LoggedEvent, WeatherDay } from './types';

// The weather on the days of an event, from the Open-Meteo historical archive
// (free, no key). The city is placed with the Open-Meteo geocoder only when
// one place matches it as you wrote it ("Las Vegas, NV"); a bare name shared
// by several places gets no weather rather than a guess.

const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
// The archive fills in a few days after the fact.
const ARCHIVE_LAG_DAYS = 5;
const MAX_DAYS = 14;

export interface WeatherResult {
  weather?: EventWeather;
  note?: string; // why there is none
}

interface Place {
  label: string;
  latitude: number;
  longitude: number;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// The places a geocoder result list holds for your city. More than one
// distinct place means it is ambiguous.
export function placesFor(results: any[], city: string, country?: string): Place[] {
  const want = normalizeName(city);
  const bare = !city.includes(',');
  const wantCountry = country ? normalizeName(country) : undefined;
  const out: Place[] = [];
  for (const r of results) {
    if (typeof r?.feature_code !== 'string' || !r.feature_code.startsWith('PPL')) continue;
    const lat = num(r.latitude);
    const lon = num(r.longitude);
    const label = geocodeLabel(r);
    if (lat === undefined || lon === undefined || !label) continue;
    const exact = normalizeName(label) === want;
    const byName =
      bare &&
      normalizeName(String(r.name ?? '')) === want &&
      (!wantCountry || [r.country, r.country_code].some((c) => typeof c === 'string' && normalizeName(c) === wantCountry));
    if (!exact && !byName) continue;
    // Two entries a few km apart are the same town.
    if (out.some((p) => Math.abs(p.latitude - lat) < 0.1 && Math.abs(p.longitude - lon) < 0.1)) continue;
    out.push({ label, latitude: lat, longitude: lon });
  }
  return out;
}

export function weatherDays(json: any): WeatherDay[] {
  const d = json?.daily;
  const times: unknown[] = Array.isArray(d?.time) ? d.time : [];
  return times
    .map((t, i): WeatherDay | null =>
      typeof t === 'string'
        ? {
            date: t,
            high: num(d.temperature_2m_max?.[i]),
            low: num(d.temperature_2m_min?.[i]),
            precipitation: num(d.precipitation_sum?.[i]),
            code: num(d.weather_code?.[i]),
          }
        : null,
    )
    .filter((x): x is WeatherDay => x !== null && (x.high !== undefined || x.low !== undefined || x.code !== undefined));
}

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// The ways a city is commonly typed that the geocoder files differently: a
// trailing "City" ("New York City"), the NYC short name, and a full state name
// after the comma ("Austin, Texas" becomes "Austin, TX"). Only the wording
// changes. Each variant still has to match exactly one place, so a city that
// is ambiguous stays ambiguous.
export function cityVariants(city: string): string[] {
  const parts = city.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return [];
  const tail = parts.slice(1);
  const state = tail.length ? regionCode(tail[0]) : undefined;
  const writtenTail = state ? [state, ...tail.slice(1)] : tail;
  const names = [parts[0]];
  const bare = parts[0].replace(/\s+city$/i, '').trim();
  if (bare && bare !== parts[0]) names.push(bare);
  if (normalizeName(parts[0]) === 'nyc') names.push('New York');
  const out = new Set<string>();
  for (const n of names) out.add([n, ...writtenTail].join(', '));
  return [...out];
}

export async function lookupWeather(event: LoggedEvent, fetcher: Fetcher, now: Date): Promise<WeatherResult> {
  if (!event.startDate) return { note: 'Add the date first.' };
  if (!event.city) return { note: 'Add the city first.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event.startDate)) return { note: 'Weather needs a full date, not just a year or month.' };
  const today = now.toISOString().slice(0, 10);
  const last = event.endDate && event.endDate > event.startDate ? event.endDate : event.startDate;
  if (event.startDate > today) return { note: 'Weather is kept only for days that have passed.' };
  if (last > addDays(today, -ARCHIVE_LAG_DAYS)) return { note: `The weather archive fills in about ${ARCHIVE_LAG_DAYS} days after the event.` };
  const end = last > addDays(event.startDate, MAX_DAYS - 1) ? addDays(event.startDate, MAX_DAYS - 1) : last;

  // A US or Canadian state is matched as "City, ST"; elsewhere the country decides.
  const city = (regionCode(event.region) ? cityWithRegion(event.city, event.region) : undefined) ?? event.city;
  // Try the city as written first, then its common variants. The first variant
  // that matches exactly one place wins; one that matches several stops the search.
  const results = new Map<string, any[]>();
  let place: Place | undefined;
  for (const candidate of cityVariants(city)) {
    const name = candidate.split(',')[0].trim();
    if (!results.has(name)) {
      const geo = await fetcher.get(`${GEOCODE}?name=${encodeURIComponent(name)}&count=20&language=en&format=json`, { timeoutMs: 8000 });
      results.set(name, geo.status === 200 ? parseJson<any>(geo)?.results ?? [] : []);
    }
    const places = placesFor(results.get(name)!, candidate, event.country);
    if (places.length > 1) return { note: `More than one place is called "${city}". Add the state or country.` };
    if (places.length === 1) {
      place = places[0];
      break;
    }
  }
  if (!place) return { note: `Couldn't find "${city}" on the map. Add the state or country.` };

  const url =
    `${ARCHIVE}?latitude=${place.latitude}&longitude=${place.longitude}&start_date=${event.startDate}&end_date=${end}` +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code&timezone=auto';
  const res = await fetcher.get(url, { timeoutMs: 10000 });
  if (res.status !== 200) return { note: `The weather archive answered ${res.status}.` };
  const days = weatherDays(parseJson<any>(res));
  if (!days.length) return { note: 'The weather archive has nothing for those days.' };
  return {
    weather: {
      place: place.label,
      latitude: place.latitude,
      longitude: place.longitude,
      days,
      sourceUrl: url,
      checkedAt: now.toISOString(),
    },
  };
}
