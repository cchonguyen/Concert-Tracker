import { createHash } from 'node:crypto';
import { normalizeName } from '../lineup/text';
import { EventRefs, LoggedEvent } from '../events/types';
import { checkEventRefs } from './integrity';
import { Entity, EntityAlias, EntityKind } from './types';

// Dual-write (0014): an event's names stay the source of truth, and every
// save points them at records, creating a record for a name not seen
// before. Matching uses the app's normalizer on the record's name and its
// aliases within the same kind. Names that only look alike are never
// joined here; possibleDuplicates lists them for you to decide.

// The ID a new record gets: the same kind and name always give the same ID,
// so two saves racing to create one record agree, and a re-run backfill
// creates nothing twice. Shaped as a version 5 UUID.
export function entityIdFor(kind: EntityKind, nameNormalized: string): string {
  const h = createHash('sha1').update(`livearchive:${kind}:${nameNormalized}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// A place is a city with whatever state and country the event has.
export function placeOf(e: Pick<LoggedEvent, 'city' | 'region' | 'country'>): { name: string; key: string; attrs: Record<string, string> } | null {
  const city = e.city?.trim();
  if (!city || !normalizeName(city)) return null;
  const region = e.region?.trim() || undefined;
  const country = e.country?.trim() || undefined;
  const attrs: Record<string, string> = { city };
  if (region) attrs.region = region;
  if (country) attrs.country = country;
  return { name: city, key: normalizeName([city, region, country].filter(Boolean).join(' ')), attrs };
}

// Lookup over stored records: a kind and normalized name to a live record.
export class EntityIndex {
  readonly byId = new Map<string, Entity>();
  private readonly byName = new Map<string, string>();
  readonly created: Entity[] = [];

  constructor(
    entities: Entity[],
    aliases: EntityAlias[],
    // The lineup pipeline's learned spellings (artist_aliases): alias to
    // canonical display name. An artist found under its canonical name is
    // found under the alias too.
    private readonly artistAliases: Record<string, string> = {},
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    for (const e of entities) this.byId.set(e.id, e);
    for (const e of entities) if (!e.mergedIntoId) this.byName.set(slot(e.kind, e.nameNormalized), e.id);
    for (const a of aliases) {
      const key = slot(a.kind, a.aliasNormalized);
      if (!this.byName.has(key)) this.byName.set(key, a.entityId);
    }
  }

  // Follows a merge once; merges are flattened, so once is enough.
  private live(id: string): string {
    return this.byId.get(id)?.mergedIntoId ?? id;
  }

  find(kind: EntityKind, normalized: string): Entity | undefined {
    let id = this.byName.get(slot(kind, normalized));
    if (!id && kind === 'artist') {
      const canonical = this.artistAliases[normalized];
      if (canonical) id = this.byName.get(slot(kind, normalizeName(canonical)));
    }
    return id ? this.byId.get(this.live(id)) : undefined;
  }

  // The live record for this name, made (and remembered in `created`) when
  // there is none. Null for a name with no letters or digits.
  resolve(kind: EntityKind, name: string, opts: { key?: string; attrs?: Record<string, unknown> } = {}): Entity | null {
    const display = name.trim();
    const key = opts.key ?? normalizeName(display);
    if (!key) return null;
    const found = this.find(kind, key);
    if (found) return found;
    const at = this.now();
    const entity: Entity = {
      id: entityIdFor(kind, key),
      kind,
      name: display,
      nameNormalized: key,
      attrs: opts.attrs ?? {},
      createdAt: at,
      updatedAt: at,
    };
    // Same ID as an existing record (made for this name, then renamed):
    // that record, not a second one.
    const existing = this.byId.get(entity.id);
    if (existing) return this.byId.get(this.live(existing.id)) ?? existing;
    this.byId.set(entity.id, entity);
    this.byName.set(slot(kind, key), entity.id);
    this.created.push(entity);
    return entity;
  }
}

const slot = (kind: EntityKind, normalized: string) => `${kind}\u0000${normalized}`;

// The event with every name pointed at its record. Names are not changed.
export function linkEvent(event: LoggedEvent, index: EntityIndex): LoggedEvent {
  const id = (e: Entity | null) => e?.id ?? null;
  const place = placeOf(event);
  const refs: EventRefs = {
    venueId: event.venue ? id(index.resolve('venue', event.venue)) : null,
    placeId: place ? id(index.resolve('place', place.name, { key: place.key, attrs: place.attrs })) : null,
    seriesId: event.series ? id(index.resolve('series', event.series)) : null,
    companionIds: event.companions.map((name) => id(index.resolve('person', name))),
  };
  const seen = event.seen.map((act) => {
    const artist = index.resolve('artist', act.name, { key: act.key || undefined });
    const next = { ...act };
    if (artist) next.artistId = artist.id;
    else delete next.artistId;
    return next;
  });
  const linked = { ...event, refs, seen };
  checkEventRefs(index.byId, linked);
  return linked;
}

// Live records whose names match once spacing, a leading "the" and "and"
// are ignored (a place: once state and country are ignored). Offers for
// you to merge, never merged here.
export function possibleDuplicates(entities: Entity[]): Entity[][] {
  const groups = new Map<string, Entity[]>();
  for (const e of entities) {
    if (e.mergedIntoId) continue;
    const base = e.kind === 'place' ? normalizeName(String(e.attrs.city ?? e.name)) : e.nameNormalized;
    const loose = base.replace(/^the /, '').replace(/\band\b/g, '').replace(/\s+/g, '');
    if (!loose) continue;
    const key = `${e.kind}\u0000${loose}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

// Normalized name or alias to the live record's ID, per kind, for code that
// only has names (the list import in the browser). Merged records' names
// lead to their target.
export type NameIndex = Partial<Record<EntityKind, Record<string, string>>>;

export function nameIndex(entities: Entity[], aliases: EntityAlias[], kinds: EntityKind[]): NameIndex {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const live = (id: string) => byId.get(id)?.mergedIntoId ?? id;
  const out: NameIndex = {};
  for (const kind of kinds) out[kind] = {};
  for (const e of entities) {
    const names = out[e.kind];
    if (names && !e.mergedIntoId && e.nameNormalized) names[e.nameNormalized] = e.id;
  }
  for (const e of entities) {
    const names = out[e.kind];
    if (names && e.mergedIntoId && e.nameNormalized) names[e.nameNormalized] ??= live(e.id);
  }
  for (const a of aliases) {
    const names = out[a.kind];
    if (names && byId.has(a.entityId)) names[a.aliasNormalized] ??= live(a.entityId);
  }
  return out;
}
