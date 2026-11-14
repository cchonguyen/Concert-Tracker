// US states and Canadian provinces, kept apart from place.ts so the browser can
// use them without the server's fetching code.

// Region names are plain words, so lowercasing and collapsing spaces is enough.
const normalizeName = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

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
export const CODES = new Set(Object.values(REGION_CODES));

const COUNTRY_ALIASES: Record<string, string[]> = {
  'united states': ['us', 'usa', 'united states', 'united states of america', 'u s', 'u s a'],
  canada: ['ca', 'can', 'canada'],
  'united kingdom': ['uk', 'gb', 'great britain', 'united kingdom', 'u k'],
};

const ALIAS_TO_CANONICAL = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(COUNTRY_ALIASES)) {
  for (const alias of aliases) {
    ALIAS_TO_CANONICAL.set(alias, canonical);
  }
}

export function canonicalCountry(name?: string | null): string {
  if (!name) return '';
  const norm = normalizeName(name);
  if (!norm) return '';
  return ALIAS_TO_CANONICAL.get(norm) ?? norm;
}

export function sameCountry(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const ca = canonicalCountry(a);
  const cb = canonicalCountry(b);
  return Boolean(ca && cb && ca === cb);
}

export const NORTH_AMERICA = new Set([...COUNTRY_ALIASES['united states'], ...COUNTRY_ALIASES['canada']]);

export function regionCode(region: string | undefined): string | undefined {
  const r = region?.trim();
  if (!r) return undefined;
  if (CODES.has(r.toUpperCase()) && r.length === 2) return r.toUpperCase();
  return REGION_CODES[normalizeName(r)];
}

const CANADA = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'ON', 'PE', 'QC', 'SK']);

// The country a "City, ST" code belongs to, for counting countries on the map.
export function regionCountry(code: string): 'United States' | 'Canada' | undefined {
  if (!CODES.has(code)) return undefined;
  return CANADA.has(code) ? 'Canada' : 'United States';
}

const COUNTRY_NAMES: Record<'United States' | 'Canada', string[]> = {
  'United States': COUNTRY_ALIASES['united states'],
  Canada: COUNTRY_ALIASES['canada'],
};
const isNorthAmerican = (country: string | undefined) => !country || NORTH_AMERICA.has(normalizeName(country));

// "Las Vegas, NV", or the city alone when no state is stored: how a city is
// shown and searched. Outside the US and Canada a state is written in full
// ("London, England").
export function cityWithRegion(city: string | undefined, region?: string): string | undefined {
  const c = city?.trim();
  if (!c) return undefined;
  const r = region?.trim();
  return r ? `${c}, ${regionCode(r) ?? r}` : c;
}

export interface PlaceParts {
  city?: string;
  region?: string;
  country?: string;
}

// A city written with its state in one box ("Las Vegas, NV", "Austin, TX,
// USA"), split into city and state, and the country the state code belongs
// to when no country is stored. Only rearranges what was written: a part
// after the comma that is not a US or Canadian postal code stays in the city
// (the Fill gaps lookup can place it). With `replace`, the state in the city
// box wins over a stored one, because both were just written together.
// Without `withCountry` the country is left as it was (a file read back only
// says what it says).
export function splitCity(place: PlaceParts, replace = false, withCountry = true): PlaceParts {
  const parts = place.city?.split(',').map((s) => s.trim()) ?? [];
  if (parts.length < 2 || parts.length > 3 || !parts[0]) return place;
  let country: string | undefined;
  if (parts.length === 3) {
    country = (Object.keys(COUNTRY_NAMES) as Array<keyof typeof COUNTRY_NAMES>).find((c) =>
      COUNTRY_NAMES[c].includes(normalizeName(parts[2])),
    );
    if (!country) return place;
  }
  const code = parts[1].length === 2 && parts[1] === parts[1].toUpperCase() ? regionCode(parts[1]) : undefined;
  if (!code || !isNorthAmerican(place.country ?? country)) return place;
  if (!replace && place.region && regionCode(place.region) !== code) return place;
  const inferred = regionCountry(code);
  if (country && country !== inferred) return place;
  return {
    city: parts[0],
    region: replace || !place.region ? code : place.region,
    country: place.country || (withCountry ? inferred : undefined),
  };
}

// The same split on an event, with each part sourced like the city it came
// from. The country is filled only when none is stored.
export function splitEventCity<
  T extends PlaceParts & { sources: Partial<Record<'city' | 'region' | 'country', unknown>> },
>(e: T, replace = false): T {
  const split = splitCity(e, replace);
  if (split === e || split.city === e.city) return e;
  const next = { ...e, ...split, sources: { ...e.sources } };
  const src = e.sources.city;
  if (src && next.region !== e.region) next.sources.region = src;
  if (src && next.country !== e.country) next.sources.country = src;
  return next;
}
