// The location your other events at a venue agree on (docs/specs/venue-location-fill.md). Read from what you
// saved, never guessed: one place gives the location, more than one or none gives nothing.
import type { LoggedEvent } from '../server/events/types';
import { venueLocationOf, type VenueLocation } from '../server/canon/venueLocation';

export function placeForVenue(events: readonly Pick<LoggedEvent, 'venue' | 'city' | 'region' | 'country'>[], venue: string): VenueLocation | undefined {
  const key = venue.trim().toLowerCase();
  if (!key) return undefined;
  const r = venueLocationOf(events.filter((e) => e.venue?.trim().toLowerCase() === key));
  return r.kind === 'one' ? r.location : undefined;
}
