import type { Fetcher } from '../lineup/types';
import { parseJson } from '../lineup/http';
import { decodeEntities, normalizeName } from '../lineup/text';
import { eventWords } from '../lineup/search';

// Where an event was held, read in code from structured data: schema.org
// Event markup on a page, or the address fields an API returns. Cities are
// written "City, ST" for the US and Canada, the way you'd type them.

// Postal abbreviations, used only to write a region the source already gave
// in the short form people type. Address formatting, not event knowledge.
const REGION_CODES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'puerto rico': 'PR', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN',
  texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', alberta: 'AB', 'british columbia': 'BC', manitoba: 'MB', 'new brunswick': 'NB',
  'newfoundland and labrador': 'NL', 'nova scotia': 'NS', ontario: 'ON', 'prince edward island': 'PE', quebec: 'QC',
  saskatchewan: 'SK',
};
const CODES = new Set(Object.values(REGION_CODES));
const NORTH_AMERICA = new Set(['us', 'usa', 'united states', 'united states of america', 'ca', 'can', 'canada']);

export function regionCode(region: string | undefined): string | undefined {
  const r = region?.trim();
  if (!r) return undefined;
  if (CODES.has(r.toUpperCase()) && r.length === 2) return r.toUpperCase();
  return REGION_CODES[normalizeName(r)];
}

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

// How a geocoding result is written: "Las Vegas, NV", "Berlin, Germany".
export function geocodeLabel(r: any): string | undefined {
  const city = cityLabel(str(r?.name), str(r?.admin1), str(r?.country_code));
  return city && city === str(r?.name) && str(r?.country) ? `${city}, ${str(r.country)}` : city;
}

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
        .map(geocodeLabel)
        .filter((c): c is string => Boolean(c)),
    ),
  ].slice(0, 6);
  if (cityCache.size > 500) cityCache.clear();
  cityCache.set(key, out);
  return out;
}
