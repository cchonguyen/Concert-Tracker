import type { Fetcher } from '../lineup/types';
import { parseJson } from '../lineup/http';
import { decodeEntities, normalizeName } from '../lineup/text';
import { eventWords } from '../lineup/search';
import { NORTH_AMERICA, regionCode } from './regions';

export { regionCode, regionCountry } from './regions';

// Where an event was held, read in code from structured data: schema.org
// Event markup on a page, or the address fields an API returns. Cities are
// written "City, ST" for the US and Canada, the way you'd type them.


// "Las Vegas, NV" in the US and Canada; just the city elsewhere.
export function cityLabel(city: string | undefined, region?: string, country?: string): string | undefined {
  const name = city?.replace(/[\s,;]+$/, '').trim();
  if (!name) return undefined;
  if (country && !NORTH_AMERICA.has(normalizeName(country))) return name;
  const code = regionCode(region);
  return code ? `${name}, ${code}` : name;
}

export interface PagePlace {
  venue?: string;
  city?: string;
  country?: string;
  quote: string;
}

interface PageEvent {
  names: string[];
  startDate?: string;
  venue?: string;
  city?: string;
  country?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? decodeEntities(v.trim()) : undefined);
const first = (v: unknown): any => (Array.isArray(v) ? v[0] : v);
const isEventType = (t: unknown) =>
  (Array.isArray(t) ? t : [t]).some((x) => typeof x === 'string' && /(Event|Festival)$/.test(x));

function collect(node: unknown, out: PageEvent[], depth = 0): void {
  if (!node || typeof node !== 'object' || depth > 6) return;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out, depth + 1);
    return;
  }
  const o = node as Record<string, any>;
  if (o['@graph']) collect(o['@graph'], out, depth + 1);
  if (!isEventType(o['@type'])) return;
  const loc = first(o.location);
  const address = first(loc?.address);
  const country = str(address?.addressCountry) ?? str(address?.addressCountry?.name);
  const performers = (Array.isArray(o.performer) ? o.performer : [o.performer]).map((p: any) => str(p?.name)).filter(Boolean);
  out.push({
    names: [str(o.name), ...performers].filter((n): n is string => Boolean(n)),
    startDate: str(o.startDate)?.match(/^\d{4}-\d{2}-\d{2}/)?.[0],
    venue: str(loc?.name),
    city: typeof address === 'object' ? cityLabel(str(address?.addressLocality), str(address?.addressRegion), country) : undefined,
    country: country && country.length > 3 ? country : undefined,
  });
}

function pageEvents(html: string): PageEvent[] {
  const out: PageEvent[] = [];
  const re = /<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      collect(JSON.parse(m[1]), out);
    } catch {
      // Broken markup on someone else's page; skip it.
    }
  }
  return out;
}

// The venue and city a page's event markup gives for this event: an event
// whose name (or a performer) has every word of yours, on a day the
// candidate covers. Several matching events at different places is
// ambiguous, so nothing is taken.
export function placeFromPage(html: string, eventName: string, startDate: string, endDate?: string): PagePlace | null {
  const words = eventWords(eventName);
  if (!words.length) return null;
  const hits = pageEvents(html).filter((e) => {
    if (!e.startDate || e.startDate < startDate || e.startDate > (endDate ?? startDate)) return false;
    if (!e.venue && !e.city) return false;
    return e.names.some((n) => {
      const norm = ` ${normalizeName(n)} `;
      return words.every((w) => norm.includes(` ${w} `));
    });
  });
  const places = new Set(hits.map((h) => `${normalizeName(h.venue ?? '')}|${normalizeName(h.city ?? '')}`));
  if (places.size !== 1) return null;
  const h = hits[0];
  return {
    venue: h.venue,
    city: h.city,
    country: h.country,
    quote: [h.venue, h.city].filter(Boolean).join(', '),
  };
}

const cityCache = new Map<string, string[]>();

// City suggestions while you type, from the Open-Meteo geocoding API (free,
// no key, GeoNames data). Only populated places, biggest first, as "City, ST".
export async function citySuggestions(query: string, fetcher: Fetcher): Promise<string[]> {
  const q = query.split(',')[0].trim();
  if (q.length < 2) return [];
  const key = q.toLowerCase();
  const cached = cityCache.get(key);
  if (cached) return cached;
  const res = await fetcher.get(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=10&language=en&format=json`,
    { timeoutMs: 5000 },
  );
  const results: any[] = parseJson<any>(res)?.results ?? [];
  const out = [
    ...new Set(
      results
        .filter((r) => typeof r.feature_code === 'string' && r.feature_code.startsWith('PPL'))
        .sort((a, b) => (b.population ?? 0) - (a.population ?? 0))
        .map((r) => {
          const city = cityLabel(str(r.name), str(r.admin1), str(r.country_code));
          return city === str(r.name) && r.country ? `${city}, ${r.country}` : city;
        })
        .filter((c): c is string => Boolean(c)),
    ),
  ].slice(0, 6);
  if (cityCache.size > 500) cityCache.clear();
  cityCache.set(key, out);
  return out;
}

export interface CityPoint {
  lat: number;
  lon: number;
  // exact: the state or country you wrote matched; name: only the name did,
  // so the biggest place by that name is shown and the map says so.
  match: 'exact' | 'name';
}

const pointCache = new Map<string, CityPoint | null>();

// Where a city you stored is, for the map: "City, ST" or "City, Country" from
// the Open-Meteo geocoder. Shown on the map only; never stored on an event.
export async function cityPoint(city: string, country: string | undefined, fetcher: Fetcher): Promise<CityPoint | null> {
  const [name, qualifier] = city.split(',').map((s) => s.trim());
  if (!name || name.length < 2) return null;
  const key = `${normalizeName(city)}|${normalizeName(country ?? '')}`;
  if (pointCache.has(key)) return pointCache.get(key)!;
  const res = await fetcher.get(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=20&language=en&format=json`,
    { timeoutMs: 5000 },
  );
  const places: any[] = (parseJson<any>(res)?.results ?? [])
    .filter((r: any) => typeof r.feature_code === 'string' && r.feature_code.startsWith('PPL'))
    .filter((r: any) => typeof r.latitude === 'number' && typeof r.longitude === 'number')
    .sort((a: any, b: any) => (b.population ?? 0) - (a.population ?? 0));
  const want = normalizeName(qualifier ?? country ?? '');
  const exact = want
    ? places.find((r) =>
        [regionCode(str(r.admin1)), str(r.admin1), str(r.country), str(r.country_code)].some((v) => v && normalizeName(v) === want),
      )
    : undefined;
  const hit = exact ?? (qualifier ? undefined : places[0]);
  const point: CityPoint | null = hit ? { lat: hit.latitude, lon: hit.longitude, match: exact ? 'exact' : 'name' } : null;
  if (pointCache.size > 2000) pointCache.clear();
  if (res.status === 200) pointCache.set(key, point);
  return point;
}
