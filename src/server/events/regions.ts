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
export const NORTH_AMERICA = new Set(['us', 'usa', 'united states', 'united states of america', 'ca', 'can', 'canada']);

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

