// A venue's known location (docs/specs/venue-location-fill.md). Read from the shared venue records that hold the
// venue's normalized name, never guessed: no map lookup, no model call, no venue list. One location fills empty
// fields; several are only offered as choices.
import type { CanonicalVenue } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';
import { normalizeName } from '../lineup/text';
import { regionCode, sameCountry, splitCity } from '../events/regions';

export interface VenueLocation {
  city: string;
  region?: string;
  country?: string;
}

export type VenueLocationResult =
  | { kind: 'one'; location: VenueLocation }
  | { kind: 'several'; choices: VenueLocation[] }
  | { kind: 'none' };

const clean = (v: string | undefined | null): string | undefined => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t ? t : undefined;
};

const sameRegion = (a: string, b: string) => (regionCode(a) ?? normalizeName(a)) === (regionCode(b) ?? normalizeName(b));

// Two locations are the same place when the city matches and neither state nor country disagrees. One that only
// adds a state or country to the same city is the same place.
export function samePlace(a: VenueLocation, b: VenueLocation): boolean {
  if (normalizeName(a.city) !== normalizeName(b.city)) return false;
  if (a.region && b.region && !sameRegion(a.region, b.region)) return false;
  if (a.country && b.country && !sameCountry(a.country, b.country)) return false;
  return true;
}

// The distinct locations held by these venue records. A record without a city adds nothing.
export function venueLocations(venues: readonly Pick<CanonicalVenue, 'city' | 'region' | 'country'>[]): VenueLocation[] {
  const out: VenueLocation[] = [];
  for (const raw of venues) {
    // A record saved with "City, ST" in its city is read as that city and state (splitCity, in code).
    const v = splitCity({ city: clean(raw.city), region: clean(raw.region), country: clean(raw.country) });
    const city = clean(v.city);
    if (!city) continue;
    const loc: VenueLocation = { city, ...(clean(v.region) ? { region: clean(v.region) } : {}), ...(clean(v.country) ? { country: clean(v.country) } : {}) };
    const held = out.find((o) => samePlace(o, loc));
    if (!held) {
      out.push(loc);
      continue;
    }
    if (!held.region && loc.region) held.region = loc.region;
    if (!held.country && loc.country) held.country = loc.country;
  }
  return out;
}

export function venueLocationOf(venues: readonly Pick<CanonicalVenue, 'city' | 'region' | 'country'>[]): VenueLocationResult {
  const locs = venueLocations(venues);
  if (locs.length === 1) return { kind: 'one', location: locs[0] };
  if (locs.length > 1) return { kind: 'several', choices: locs };
  return { kind: 'none' };
}

// The known location of the venue with this name, from every shared venue record holding the name.
export async function venueLocation(store: Pick<LineupStore, 'listVenuesByAlias'>, venueName: string | undefined): Promise<VenueLocationResult> {
  const name = clean(venueName);
  if (!name) return { kind: 'none' };
  return venueLocationOf(await store.listVenuesByAlias(normalizeName(name)));
}

export type PlaceFieldName = 'city' | 'region' | 'country';

// Only the empty fields, filled from the location. A field that has a value is never changed, even when it disagrees.
// When the city already has a value that is another place, nothing is filled: the state or country of a different
// city would be wrong.
export function emptyPlaceFields(
  current: Partial<Record<PlaceFieldName, string | undefined | null>>,
  location: VenueLocation,
): Partial<Record<PlaceFieldName, string>> {
  const city = clean(current.city);
  if (city && normalizeName(city) !== normalizeName(location.city)) return {};
  const out: Partial<Record<PlaceFieldName, string>> = {};
  for (const f of ['city', 'region', 'country'] as const) {
    if (!clean(current[f]) && location[f]) out[f] = location[f];
  }
  return out;
}
