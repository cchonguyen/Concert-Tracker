import { normalizeName } from '../lineup/text';
import { LoggedEvent } from '../events/types';
import { placeOf } from './link';
import { Entity, EntityLink } from './types';

// A venue in a place (an `in` link you set, or one worked out from your own
// events) gives every event at that venue its city, state and country,
// marked as coming from the venue. It is a relationship you entered, not a
// guess (REQUIREMENTS.md R1.9). A different city that a save brings (typed,
// researched or imported) is not lost: it is kept on the venue as an offer
// for Data health. Contracts: .spec/SYSTEM_SPEC.md section 3.

// What a venue's place is called, as event fields.
export function placeFields(place: Entity): { city: string; region?: string; country?: string } {
  const out: { city: string; region?: string; country?: string } = { city: String(place.attrs.city ?? place.name) };
  if (typeof place.attrs.region === 'string' && place.attrs.region) out.region = place.attrs.region;
  if (typeof place.attrs.country === 'string' && place.attrs.country) out.country = place.attrs.country;
  return out;
}

// Venue ID to the ID of the place it is in.
export const venuePlaces = (links: EntityLink[]): Map<string, string> =>
  new Map(links.filter((l) => l.role === 'in').map((l) => [l.fromId, l.toId]));

// A city a save brought that its venue's place replaced.
export interface PlaceOffer {
  city: string;
  region?: string;
  country?: string;
  eventId: string;
  from: string; // where the replaced value came from (a source type, or 'user')
  at: string;
}

export const MAX_PLACE_OFFERS = 20;

const VENUE = { sourceType: 'venue' as const };

// The event with its venue's place as its location. `offer` is the location
// it had before, when that was another place.
export function withVenuePlace(event: LoggedEvent, place: Entity, at: string): { event: LoggedEvent; offer?: PlaceOffer } {
  const want = placeFields(place);
  const sameCity = Boolean(event.city && normalizeName(event.city) === normalizeName(want.city));
  const matches = (a: string | undefined, b: string | undefined) => !a || !b || normalizeName(a) === normalizeName(b);
  // A place that only names a city (or city + state) does not wipe state or
  // country entered for that same place.
  const keepExtras = sameCity && matches(event.region, want.region) && matches(event.country, want.country);
  const fields = ['city', 'region', 'country'] as const;
  const same = fields.every((f) => (keepExtras && !want[f] ? true : (event[f] ?? undefined) === want[f]));
  const marked = fields.every((f) => !want[f] || event.sources[f]?.sourceType === 'venue');
  if (same && marked) return { event };
  const next: LoggedEvent = { ...event, sources: { ...event.sources } };
  for (const f of fields) {
    if (want[f]) {
      next[f] = want[f];
      next.sources[f] = VENUE;
    } else if (!keepExtras) {
      delete next[f];
      delete next.sources[f];
    }
  }
  const was = placeOf(event);
  const now = placeOf(next);
  const moved = Boolean(was && now && was.key !== now.key && !keepExtras);
  // Weather is never fetched on its own: an old lookup is kept and flagged.
  if (moved && next.weather && normalizeName(event.city ?? '') !== normalizeName(want.city)) {
    next.weather = { ...next.weather, cityChanged: true };
  }
  if (!moved || !was) return { event: next };
  const offer: PlaceOffer = {
    city: was.attrs.city,
    eventId: event.id,
    from: event.sources.city?.sourceType ?? 'user',
    at,
  };
  if (was.attrs.region) offer.region = was.attrs.region;
  if (was.attrs.country) offer.country = was.attrs.country;
  return { event: next, offer };
}

// The venue with these offers added: one per place, newest kept, at most
// MAX_PLACE_OFFERS.
export function addPlaceOffers(venue: Entity, offers: PlaceOffer[], at: string): Entity {
  const key = (o: PlaceOffer) => normalizeName([o.city, o.region, o.country].filter(Boolean).join(' '));
  const old = Array.isArray(venue.attrs.placeOffers) ? (venue.attrs.placeOffers as PlaceOffer[]) : [];
  const byKey = new Map(old.map((o) => [key(o), o]));
  for (const o of offers) {
    byKey.delete(key(o));
    byKey.set(key(o), o);
  }
  const placeOffers = [...byKey.values()].slice(-MAX_PLACE_OFFERS);
  return { ...venue, attrs: { ...venue.attrs, placeOffers }, updatedAt: at };
}

// Venues with no place whose events use more than one: you pick (Data
// health). Each place with how many events use it, most first.
export interface VenueConflict {
  venueId: string;
  places: Array<{ placeId: string; events: number }>;
}

// From linked events: venues without a place whose events all use the same
// one (`agree`, linked on their own) and those whose events disagree.
export function venuePlaceSplit(
  venues: Entity[],
  links: EntityLink[],
  events: LoggedEvent[],
): { agree: Array<{ venueId: string; placeId: string }>; conflicts: VenueConflict[] } {
  const placed = venuePlaces(links);
  const counts = new Map<string, Map<string, number>>();
  for (const e of events) {
    const v = e.refs?.venueId;
    const p = e.refs?.placeId;
    if (!v || !p || placed.has(v)) continue;
    const m = counts.get(v) ?? new Map<string, number>();
    m.set(p, (m.get(p) ?? 0) + 1);
    counts.set(v, m);
  }
  const agree: Array<{ venueId: string; placeId: string }> = [];
  const conflicts: VenueConflict[] = [];
  for (const venue of venues) {
    const m = counts.get(venue.id);
    if (venue.mergedIntoId || !m) continue;
    const places = [...m.entries()].map(([placeId, n]) => ({ placeId, events: n })).sort((a, b) => b.events - a.events);
    if (places.length === 1) agree.push({ venueId: venue.id, placeId: places[0].placeId });
    else conflicts.push({ venueId: venue.id, places });
  }
  return { agree, conflicts };
}
