import { normalizeName } from '../lineup/text';
import { LineupStore } from '../lineup/store/types';
import { LoggedEvent } from '../events/types';
import { splitEventCity } from '../events/regions';
import { EntityIndex, linkEvent } from './link';
import { EntityAlias } from './types';

const LINKED = Symbol('entity links');

export const isLinking = (store: LineupStore): boolean => Boolean((store as any)[LINKED]);

// The store with dual-write (0014): every event save points the event's
// names at records first, adding records for names not seen before, so all
// the code that saves events (capture, edits, imports, email, lineups) links
// without knowing about it. Names are never changed here.
export function withEntityLinks(store: LineupStore): LineupStore {
  const link = async (events: LoggedEvent[]): Promise<LoggedEvent[]> => {
    if (!events.length) return events;
    const [entities, aliases, artistAliases] = await Promise.all([
      store.listEntities(),
      store.listEntityAliases(),
      store.getAliases(),
    ]);
    const index = new EntityIndex(entities, aliases, artistAliases);
    // Split "City, ST" first, as both stores do, so the place is the stored one.
    const linked = events.map((e) => linkEvent(splitEventCity(e), index));
    if (index.created.length) await store.addEntities(index.created);
    return linked;
  };
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === LINKED) return true;
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
  await store.putEvents(events);

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
