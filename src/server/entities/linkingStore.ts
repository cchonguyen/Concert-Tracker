import { normalizeName } from '../lineup/text';
import { LineupStore, type UserScope } from '../lineup/store/types';
import { LoggedEvent } from '../events/types';
import { splitEventCity } from '../events/regions';
import { EntityIndex, linkEvent } from './link';
import { Entity, EntityAlias, EntityLink } from './types';
import { addPlaceOffers, PlaceOffer, venuePlaces, withVenuePlace } from './venuePlace';
import { linkVenuePlaces } from './manage';

const LINKED = Symbol('entity links');
// putEvents for the first backfill: new venues are not put in a city by one
// event, since their events may disagree (backfillVenuePlaces decides).
const BACKFILL_PUT = Symbol('backfill put');

export const isLinking = (store: LineupStore): boolean => Boolean((store as any)[LINKED]);

// The store with dual-write (0014): every event save points the event's
// names at records first, adding records for names not seen before, so all
// the code that saves events (capture, edits, imports, email, lineups) links
// without knowing about it. Names are never changed here. An event at a
// venue that is in a place takes the place as its location (venuePlace.ts);
// a new venue saved with a city is put in that city.
export function withEntityLinks(store: LineupStore): LineupStore {
  const link = async (events: LoggedEvent[], placeNewVenues = true): Promise<LoggedEvent[]> => {
    if (!events.length) return events;
    const [entities, aliases, artistAliases, links] = await Promise.all([
      store.listEntities(),
      store.listEntityAliases(),
      store.getAliases(),
      store.listEntityLinks(),
    ]);
    const at = new Date().toISOString();
    const index = new EntityIndex(entities, aliases, artistAliases, () => at);
    const placed = venuePlaces(links);
    const fresh: EntityLink[] = [];
    const offers = new Map<string, PlaceOffer[]>();
    const live = (id: string | undefined): Entity | undefined => {
      const e = id ? index.byId.get(id) : undefined;
      return e?.mergedIntoId ? index.byId.get(e.mergedIntoId) : e;
    };
    const linked = events.map((raw) => {
      // Split "City, ST" first, as both stores do, so the place is the stored one.
      let event = splitEventCity(raw);
      const venue = event.venue ? index.find('venue', normalizeName(event.venue)) : undefined;
      const place = venue ? live(placed.get(venue.id)) : undefined;
      if (venue && place) {
        const r = withVenuePlace(event, place, at);
        event = r.event;
        if (r.offer) offers.set(venue.id, [...(offers.get(venue.id) ?? []), r.offer]);
      }
      const out = linkEvent(event, index);
      const { venueId, placeId } = out.refs ?? {};
      if (placeNewVenues && !venue && venueId && placeId && !placed.has(venueId)) {
        placed.set(venueId, placeId);
        fresh.push({ fromId: venueId, toId: placeId, role: 'in', createdAt: at });
      }
      return out;
    });
    if (index.created.length) await store.addEntities(index.created);
    if (fresh.length) await store.addEntityLinks(fresh);
    if (offers.size) {
      await store.putEntities([...offers].map(([id, list]) => addPlaceOffers(index.byId.get(id)!, list, at)));
    }
    return linked;
  };
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === LINKED) return true;
      // Multi-user: each member's saves link into their own records
      // (user_entities), as the single-owner app does into the shared ones.
      if (prop === 'forUser' && target.forUser) return (scope: UserScope) => withEntityLinks(target.forUser!(scope));
      if (prop === BACKFILL_PUT) return async (events: LoggedEvent[]) => target.putEvents(await link(events, false));
      if (prop === 'putEvent') return async (event: LoggedEvent) => target.putEvents(await link([event]));
      if (prop === 'putEvents') return async (events: LoggedEvent[]) => target.putEvents(await link(events));
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export const BACKFILL_SETTING = 'entities_backfill';

export interface BackfillResult {
  events: number;
  entities: number;
  aliases: number;
  at: string;
}

// Links every saved event once (the minute cron on the Worker, startup
// locally), then remembers it was done. Saves already link on their own, so
// this only catches events saved before 0014. It also copies the lineup
// pipeline's learned artist spellings onto the artist records.
// Does nothing on a store without the entity tables.
export async function backfillEntities(store: LineupStore, now = () => new Date().toISOString()): Promise<BackfillResult | null> {
  if (!isLinking(store)) return null;
  if (await store.getSetting<BackfillResult>(BACKFILL_SETTING)) return null;
  const before = (await store.listEntities()).length;
  const events = await store.listEvents();
  await (store as any)[BACKFILL_PUT](events);

  const entities = await store.listEntities();
  const artists = new Map(entities.filter((e) => e.kind === 'artist' && !e.mergedIntoId).map((e) => [e.nameNormalized, e]));
  const held = new Set((await store.listEntityAliases()).map((a) => `${a.kind}\u0000${a.aliasNormalized}`));
  const aliases: EntityAlias[] = [];
  for (const [alias, canonical] of Object.entries(await store.getAliases())) {
    const artist = artists.get(normalizeName(canonical));
    if (!artist || alias === artist.nameNormalized || artists.has(alias) || held.has(`artist\u0000${alias}`)) continue;
    held.add(`artist\u0000${alias}`);
    aliases.push({ entityId: artist.id, kind: 'artist', aliasNormalized: alias });
  }
  if (aliases.length) await store.addEntityAliases(aliases);

  const result: BackfillResult = { events: events.length, entities: entities.length - before, aliases: aliases.length, at: now() };
  await store.putSetting(BACKFILL_SETTING, result);
  return result;
}

export const VENUE_PLACES_SETTING = 'venue_places_backfill';

export interface VenuePlacesResult {
  venues: number; // put in a place
  events: number; // whose location changed
  historyId?: string;
  at: string;
}

// Once, after the first backfill: venues whose events all use one city are
// put in it (one undoable change); the rest wait for you in Data health.
export async function backfillVenuePlaces(store: LineupStore, now = () => new Date().toISOString()): Promise<VenuePlacesResult | null> {
  if (!isLinking(store)) return null;
  if (!(await store.getSetting(BACKFILL_SETTING))) return null;
  if (await store.getSetting<VenuePlacesResult>(VENUE_PLACES_SETTING)) return null;
  const at = now();
  const entry = await linkVenuePlaces(store, at);
  const result: VenuePlacesResult = { venues: entry?.touched.length ?? 0, events: entry?.events.length ?? 0, at };
  if (entry) result.historyId = entry.id;
  await store.putSetting(VENUE_PLACES_SETTING, result);
  return result;
}
