import type { LoggedEvent } from '../server/events/types';
import type { CityPoint } from '../server/events/place';
import { regionCountry } from '../server/events/regions';
import { eventYear } from './format';

// The Map view: your events grouped by the city you stored, placed with the
// geocoder's point for that city. Display only; nothing here is stored.

export type Points = Record<string, CityPoint | null>; // placeKey -> point, null = not found

export function placeKey(e: Pick<LoggedEvent, 'city' | 'country'>): string | null {
  const city = e.city?.trim();
  return city ? `${city}|${e.country?.trim() ?? ''}` : null;
}

export function placeQuery(key: string): { city: string; country?: string } {
  const [city, country] = key.split('|');
  return { city, country: country || undefined };
}

export interface MapPlace {
  key: string;
  city: string;
  point: CityPoint;
  events: LoggedEvent[]; // newest first
}

export interface MapData {
  places: MapPlace[]; // most events first
  noCity: number; // events without a city
  notFound: LoggedEvent[]; // the city could not be placed
  pending: number; // events whose city is still being looked up
}

export function mapData(events: LoggedEvent[], points: Points): MapData {
  const groups = new Map<string, MapPlace>();
  const out: MapData = { places: [], noCity: 0, notFound: [], pending: 0 };
  for (const e of events) {
    const key = placeKey(e);
    if (!key) out.noCity += 1;
    else if (!(key in points)) out.pending += 1;
    else if (points[key] === null) out.notFound.push(e);
    else {
      const g = groups.get(key) ?? { key, city: e.city!.trim(), point: points[key]!, events: [] };
      g.events.push(e);
      groups.set(key, g);
    }
  }
  const when = (e: LoggedEvent) => e.startDate ?? (e.year ? String(e.year) : '');
  out.places = [...groups.values()]
    .map((g) => ({ ...g, events: [...g.events].sort((a, b) => when(b).localeCompare(when(a))) }))
    .sort((a, b) => b.events.length - a.events.length || a.city.localeCompare(b.city));
  return out;
}

// Cities, states or provinces, and countries, from what you stored: the
// event's country, or the part after the comma ("Austin, TX", "Paris, France").
export interface Travel {
  cities: number;
  regions: number;
  countries: number;
}

export function travel(places: MapPlace[]): Travel {
  const regions = new Set<string>();
  const countries = new Set<string>();
  for (const p of places) {
    const suffix = p.city.split(',').slice(1).join(',').trim();
    const code = /^[A-Z]{2}$/.test(suffix) ? suffix : undefined;
    const fromCode = code ? regionCountry(code) : undefined;
    if (fromCode) regions.add(code!);
    const stored = p.events.map((e) => e.country?.trim()).find(Boolean);
    const country = fromCode ?? stored ?? (suffix && !code ? suffix : undefined);
    if (country) countries.add(country.toLowerCase() === 'usa' || country.toLowerCase() === 'us' ? 'United States' : country);
  }
  return { cities: places.length, regions: regions.size, countries: countries.size };
}

// Every time you saw an act, oldest first, where the city is on the map.
export interface TrailStop {
  event: LoggedEvent;
  point: CityPoint;
}

export function trail(events: LoggedEvent[], artistKey: string, points: Points): TrailStop[] {
  return events
    .filter((e) => e.seen.some((s) => s.key === artistKey))
    .flatMap((e) => {
      const key = placeKey(e);
      const point = key ? points[key] : null;
      return point ? [{ event: e, point }] : [];
    })
    .sort((a, b) => (a.event.startDate ?? String(eventYear(a.event) ?? '')).localeCompare(b.event.startDate ?? String(eventYear(b.event) ?? '')));
}

// The years to step through when playing the map, oldest first.
export function playbackYears(events: LoggedEvent[]): number[] {
  return [...new Set(events.map(eventYear).filter((y): y is number => y !== null))].sort((a, b) => a - b);
}
