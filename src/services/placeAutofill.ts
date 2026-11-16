import { cityWithRegion } from '../server/events/regions';

export interface PlaceFields {
  city: string;
  region?: string;
  country?: string;
}

export interface PlaceInput {
  city?: string | null;
  region?: string | null;
  country?: string | null;
}

export interface CityPickPatch {
  city: string | null;
  region: string | null;
  country?: string;
}

export interface UnanimousPlaceResult {
  city?: string;
  region?: string;
  country?: string;
  label: string;
}

/**
 * Formats a city/region/country into a concise display label like "Indio, CA, US".
 */
export function formatPlaceLabel(place: PlaceInput): string {
  const city = place.city?.trim() || undefined;
  const region = place.region?.trim() || undefined;
  const country = place.country?.trim() || undefined;
  const cityPart = cityWithRegion(city, region);
  return [cityPart ?? region, country].filter(Boolean).join(', ');
}

/**
 * Builds deduplicated past place suggestions sorted by frequency then alphabetically,
 * keyed by `cityWithRegion(city, region)`.
 */
export function buildPastPlaces(items: readonly PlaceInput[]): {
  places: Map<string, PlaceFields>;
  cities: string[];
} {
  const places = new Map<string, PlaceFields>();
  const counts = new Map<string, number>();

  for (const item of items) {
    const city = item.city?.trim();
    const region = item.region?.trim() || undefined;
    const country = item.country?.trim() || undefined;
    const label = cityWithRegion(city, region);
    if (!label || !city) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    const existing = places.get(label);
    if (!existing) {
      places.set(label, { city, ...(region ? { region } : {}), ...(country ? { country } : {}) });
    } else if (country && !existing.country) {
      places.set(label, { ...existing, country });
    }
  }

  const cities = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label]) => label);

  return { places, cities };
}

/**
 * Computes the city/region/country patch when a city is typed or picked from suggestions.
 * Matches `pastPlaces` entries to preserve region and fill a missing country; otherwise clears region.
 */
export function cityPickPatch(
  typed: string | null | undefined,
  pastPlaces: Map<string, PlaceFields>,
  currentCountry?: string | null,
): CityPickPatch {
  const clean = typeof typed === 'string' ? typed.trim() : '';
  const past = clean ? pastPlaces.get(clean) : undefined;
  if (past) {
    return {
      city: past.city,
      region: past.region ?? null,
      ...(currentCountry?.trim() || !past.country ? {} : { country: past.country }),
    };
  }
  return { city: clean || null, region: null };
}

function unanimousField(items: readonly PlaceInput[], key: keyof PlaceInput): { ok: boolean; value?: string } {
  let chosen: string | undefined;
  let chosenNorm: string | undefined;
  for (const item of items) {
    const raw = item[key]?.trim();
    if (!raw) continue;
    const norm = raw.toLowerCase();
    if (chosenNorm === undefined) {
      chosen = raw;
      chosenNorm = norm;
    } else if (chosenNorm !== norm) {
      return { ok: false };
    }
  }
  return { ok: true, value: chosen };
}

/**
 * Returns a combined place when at least one place field is populated across items
 * and all non-empty values for each field agree (case-insensitive trimmed).
 */
export function unanimousPlace(items: readonly PlaceInput[]): UnanimousPlaceResult | null {
  const city = unanimousField(items, 'city');
  const region = unanimousField(items, 'region');
  const country = unanimousField(items, 'country');
  if (!city.ok || !region.ok || !country.ok) return null;
  if (!city.value && !region.value && !country.value) return null;
  const label = formatPlaceLabel({ city: city.value, region: region.value, country: country.value });
  return {
    ...(city.value ? { city: city.value } : {}),
    ...(region.value ? { region: region.value } : {}),
    ...(country.value ? { country: country.value } : {}),
    label,
  };
}
