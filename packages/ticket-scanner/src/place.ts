// Region table vendored from the host app so this package has no host imports.
import { normalizeName } from './names.ts';

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
