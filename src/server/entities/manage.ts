import { randomUUID } from 'node:crypto';
import { normalizeName } from '../lineup/text';
import { LineupStore } from '../lineup/store/types';
import { LoggedEvent, SeenAct } from '../events/types';
import { splitEventCity } from '../events/regions';
import { withB2b } from '../events/seen';
import { EntityIndex, linkEvent } from './link';
import { ALLOWED_LINKS, Entity, EntityAlias, EntityKind, EntityLink, HistoryEntry, LinkRole } from './types';
import { venuePlaceSplit, withVenuePlace } from './venuePlace';
import { attrFields } from './attrs';

// The Manage operations (0014): rename, merge, AKA and links. Each one is
// planned in full from what is stored, written to entity_history first, and
// then applied, so it can be undone exactly. Event names stay the source of
// truth, so a rename or merge rewrites the names on every event that points
// at the record (dual-write); the linking store then points them at the
// record again. Contracts: .spec/SYSTEM_SPEC.md section 3.

export class ManageError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
    // A record that already has the name: merging into it is the way on.
    readonly conflict?: { id: string; name: string },
  ) {
    super(message);
  }
}

const EVENT_FIELDS = ['venue', 'series', 'city', 'region', 'country', 'companions', 'seen', 'sources', 'weather'] as const;
type EventField = (typeof EVENT_FIELDS)[number];

interface World {
  byId: Map<string, Entity>;
  aliases: EntityAlias[];
  links: EntityLink[];
  // Stored events, and the same events as linked now (split city, refs).
  stored: Map<string, LoggedEvent>;
  linked: LoggedEvent[];
}

async function load(store: LineupStore): Promise<World> {
  const [entities, aliases, links, artistAliases, events] = await Promise.all([
    store.listEntities(),
    store.listEntityAliases(),
    store.listEntityLinks(),
    store.getAliases(),
    store.listEvents(),
  ]);
  // Names not linked yet get records in memory only; none of them is the
  // record being changed.
  const index = new EntityIndex(entities, aliases, artistAliases);
  return {
    byId: new Map(entities.map((e) => [e.id, e])),
    aliases,
    links,
    stored: new Map(events.map((e) => [e.id, e])),
    linked: events.map((e) => linkEvent(splitEventCity(e), index)),
  };
}

function live(world: World, id: string, kind?: EntityKind, opts: { encrypted?: boolean } = {}): Entity {
  const e = world.byId.get(id);
  if (!e) throw new ManageError('No such record.', 404);
  if (e.nameEncrypted && !opts.encrypted) throw new ManageError('This person\'s name is encrypted. Unlock your vault and change them from the People list.', 400);
  if (e.mergedIntoId) throw new ManageError(`"${e.name}" was merged into another record.`, 409);
  if (kind && e.kind !== kind) throw new ManageError(`"${e.name}" is not a ${kind}.`, 400);
  return e;
}

// The live record (other than `self`) that has this name or alias.
function holder(world: World, kind: EntityKind, key: string, self?: string): Entity | undefined {
  for (const e of world.byId.values()) {
    if (e.id !== self && !e.mergedIntoId && e.kind === kind && e.nameNormalized === key) return e;
  }
  for (const a of world.aliases) {
    if (a.entityId === self || a.kind !== kind || a.aliasNormalized !== key) continue;
    const owner = world.byId.get(a.entityId);
    const target = owner?.mergedIntoId ? world.byId.get(owner.mergedIntoId) : owner;
    if (target && target.id !== self) return target;
  }
  return undefined;
}

const taken = (e: Entity, kind: EntityKind, what: string) =>
  new ManageError(`Another ${kind} is already called "${e.name}"${what}. Merge them instead.`, 409, { id: e.id, name: e.name });

// A place is keyed by city, state and country; the others by name.
function keyFor(entity: Entity, name: string): string {
  if (entity.kind !== 'place') return normalizeName(name);
  return normalizeName([name, entity.attrs.region, entity.attrs.country].filter(Boolean).join(' '));
}

export const cleanName = (name: unknown): string => {
  const out = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!normalizeName(out)) throw new ManageError('A name needs at least one letter or digit.', 400);
  return out;
};

// ---- Rewriting events -------------------------------------------------------

// Acts pointing at one of `ids` become one act named `name`, at the place of
// the first; the act already pointing at `primary` keeps its marks, the
// others fill what it lacks. B2B partners follow the new key.
function rewriteSeen(stored: SeenAct[], linked: SeenAct[], ids: Set<string>, primary: string, name: string): SeenAct[] {
  const key = normalizeName(name);
  const hits = linked.map((a, i) => (a.artistId && ids.has(a.artistId) ? i : -1)).filter((i) => i >= 0);
  if (!hits.length) return stored;
  const remap = new Map(hits.map((i) => [stored[i].key, key]));
  const order = [...hits].sort((a, b) => Number(linked[b].artistId === primary) - Number(linked[a].artistId === primary));
  let act: SeenAct = { ...stored[order[0]] };
  for (const i of order.slice(1)) act = combine(act, stored[i]);
  act = { ...act, name, key };
  const out: SeenAct[] = [];
  stored.forEach((s, i) => {
    if (i === hits[0]) out.push(act);
    else if (!hits.includes(i)) out.push(s);
  });
  const moved = out.map((s) => {
    if (!s.b2b) return s;
    const b2b = [...new Set(s.b2b.map((k) => remap.get(k) ?? k))].filter((k) => k !== s.key);
    return { ...s, b2b };
  });
  return withB2b(moved);
}

// One seen act from two of the same artist: yours wins over the lineup's,
// marks are kept, and `a`'s set, role and solo set win over `b`'s.
function combine(a: SeenAct, b: SeenAct): SeenAct {
  const out: SeenAct = { ...a, from: a.from === 'you' || b.from === 'you' ? 'you' : 'lineup' };
  if (a.favourite || b.favourite) out.favourite = true;
  if (!a.role && b.role) Object.assign(out, { role: b.role, roleFrom: b.roleFrom });
  if (!a.set && b.set) out.set = b.set;
  if (a.b2b?.length || b.b2b?.length) out.b2b = [...new Set([...(a.b2b ?? []), ...(b.b2b ?? [])])];
  if (a.solo || b.solo) out.solo = true;
  if (!a.soloSet && b.soloSet) out.soloSet = b.soloSet;
  return out;
}

// Companions pointing at one of `ids` take `name`; the same person twice is
// kept once, at the first place.
function rewriteCompanions(stored: string[], ids: Array<string | null>, hit: Set<string>, target: string, name: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  stored.forEach((c, i) => {
    const id = ids[i] && hit.has(ids[i]!) ? target : ids[i];
    if (id && seen.has(id)) return;
    if (id) seen.add(id);
    out.push(ids[i] && hit.has(ids[i]!) ? name : c);
  });
  return out;
}

const you = { sourceType: 'user' as const };

// Every event that points at one of `ids`, with its names rewritten for
// `target` (named `name`). Only the fields that change are kept.
function rewriteEvents(world: World, kind: EntityKind, ids: Set<string>, target: Entity, name: string): HistoryEntry['events'] {
  const out: HistoryEntry['events'] = [];
  for (const linked of world.linked) {
    const stored = world.stored.get(linked.id)!;
    const refs = linked.refs!;
    const next: Partial<Record<EventField, unknown>> = {};
    const sources = { ...stored.sources };
    if (kind === 'venue' && refs.venueId && ids.has(refs.venueId) && stored.venue !== name) {
      next.venue = name;
      sources.venue = you;
    }
    if (kind === 'series' && refs.seriesId && ids.has(refs.seriesId) && stored.series !== name) next.series = name;
    if (kind === 'place' && refs.placeId && ids.has(refs.placeId)) {
      const want = { city: name, region: target.attrs.region as string | undefined, country: target.attrs.country as string | undefined };
      for (const f of ['city', 'region', 'country'] as const) {
        if ((stored[f] ?? undefined) !== want[f]) {
          next[f] = want[f] ?? null;
          // Still the venue's place, under its new name.
          sources[f] = stored.sources[f]?.sourceType === 'venue' ? stored.sources[f]! : you;
        }
      }
    }
    if (kind === 'person' && refs.companionIds.some((id) => id && ids.has(id))) {
      const companions = rewriteCompanions(stored.companions, refs.companionIds, ids, target.id, name);
      if (JSON.stringify(companions) !== JSON.stringify(stored.companions)) next.companions = companions;
    }
    if (kind === 'artist') {
      const seen = rewriteSeen(stored.seen, linked.seen, ids, target.id, name);
      if (JSON.stringify(seen) !== JSON.stringify(stored.seen)) next.seen = seen;
    }
    if (!Object.keys(next).length) continue;
    if (JSON.stringify(sources) !== JSON.stringify(stored.sources)) next.sources = sources;
    const before: Record<string, unknown> = {};
    // null for a field that was empty, so the history keeps the key.
    for (const f of Object.keys(next) as EventField[]) before[f] = stored[f] ?? null;
    out.push({ id: stored.id, before, after: next });
  }
  return out;
}

// ---- Planning ---------------------------------------------------------------

type Plan = Omit<HistoryEntry, 'id' | 'createdAt' | 'aliases' | 'links'> & {
  aliases: EntityAlias[]; // after
  links: EntityLink[]; // after
};

/** A read-only entity change plan. It captures the same snapshot used by the
 * planner and is only persisted by applyEntityChangePlan. */
export interface EntityChangePlan {
  readonly world: World;
  readonly plan: Plan;
  readonly at: string;
}

const aliasesOf = (world: World, ids: string[]) => world.aliases.filter((a) => ids.includes(a.entityId));
const linksOf = (world: World, ids: string[]) => world.links.filter((l) => ids.includes(l.fromId) || ids.includes(l.toId));
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function planRename(world: World, id: string, newName: unknown, at: string): Plan {
  const entity = live(world, id);
  const name = cleanName(newName);
  const key = keyFor(entity, name);
  const other = holder(world, entity.kind, key, entity.id);
  if (other) throw taken(other, entity.kind, other.nameNormalized === key ? '' : ' (as an AKA)');
  if (name === entity.name) throw new ManageError(`It is already called "${name}".`, 400);
  const attrs = entity.kind === 'place' ? { ...entity.attrs, city: name } : entity.attrs;
  const after: Entity = { ...entity, name, nameNormalized: key, attrs, updatedAt: at };
  // The old name becomes an AKA (not for a place, which merges instead); the
  // new name stops being one.
  const aliases = aliasesOf(world, [id]).filter((a) => a.aliasNormalized !== key);
  if (entity.kind !== 'place' && entity.nameNormalized !== key && !aliases.some((a) => a.aliasNormalized === entity.nameNormalized)) {
    aliases.push({ entityId: id, kind: entity.kind, aliasNormalized: entity.nameNormalized });
  }
  const events = rewriteEvents(world, entity.kind, new Set([id]), after, name);
  return {
    operation: 'rename',
    summary: `Renamed ${entity.kind} "${entity.name}" to "${name}" (${plural(events.length, 'event')})`,
    sourceEntityId: id,
    entities: { before: [entity], after: [after] },
    touched: [id],
    aliases,
    links: linksOf(world, [id]),
    events,
  };
}

// A person's first and last name and your note (Manage step 4). The record's
// name becomes "First Last", renamed everywhere like any rename (the old name
// kept as an AKA); a note alone changes only the record.
export interface PersonDetails {
  first?: unknown;
  last?: unknown;
  note?: unknown;
}

export const MAX_NOTE = 2000;

function planPerson(world: World, id: string, details: PersonDetails, at: string): Plan {
  const entity = live(world, id, 'person');
  const part = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
  const first = part(details.first);
  const last = part(details.last);
  if (!normalizeName(first)) throw new ManageError('A first name needs at least one letter or digit.', 400);
  if (last && !normalizeName(last)) throw new ManageError('A last name needs at least one letter or digit.', 400);
  const note = typeof details.note === 'string' ? details.note.trim() : '';
  if (note.length > MAX_NOTE) throw new ManageError(`A note can be at most ${MAX_NOTE} characters.`, 400);
  const attrs: Record<string, unknown> = { ...entity.attrs, first };
  if (last) attrs.last = last;
  else delete attrs.last;
  if (note) attrs.note = note;
  else delete attrs.note;
  const name = last ? `${first} ${last}` : first;
  if (name !== entity.name) {
    const plan = planRename(world, id, name, at);
    plan.entities.after = [{ ...plan.entities.after[0], attrs }];
    return plan;
  }
  if (JSON.stringify(attrs) === JSON.stringify(entity.attrs)) throw new ManageError('Nothing changed.', 400);
  return {
    operation: 'details',
    summary: `Updated ${entity.name}'s details`,
    sourceEntityId: id,
    entities: { before: [entity], after: [{ ...entity, attrs, updatedAt: at }] },
    touched: [id],
    aliases: aliasesOf(world, [id]),
    links: linksOf(world, [id]),
    events: [],
  };
}

// The attributes a kind keeps (attrs.ts), in your words. An empty value
// removes it; other keys in attrs (a place's parts, a venue's place offers)
// are left alone.
function planAttrs(world: World, id: string, values: Record<string, unknown>, at: string): Plan {
  const entity = live(world, id);
  const fields = attrFields(entity.kind);
  if (!fields.length) throw new ManageError(`A ${entity.kind} has no details to set here.`, 400);
  const attrs: Record<string, unknown> = { ...entity.attrs };
  for (const [key, raw] of Object.entries(values ?? {})) {
    const field = fields.find((f) => f.key === key);
    if (!field) throw new ManageError(`A ${entity.kind} has no "${key}".`, 400);
    if (raw !== null && raw !== undefined && typeof raw !== 'string') throw new ManageError(`${field.label} must be text.`, 400);
    const value = typeof raw === 'string' ? (field.multiline ? raw.trim() : raw.trim().replace(/\s+/g, ' ')) : '';
    if (value.length > field.max) throw new ManageError(`${field.label} can be at most ${field.max} characters.`, 400);
    if (value) attrs[key] = value;
    else delete attrs[key];
  }
  if (JSON.stringify(attrs) === JSON.stringify(entity.attrs)) throw new ManageError('Nothing changed.', 400);
  return {
    operation: 'details',
    summary: `Updated ${entity.name}'s details`,
    sourceEntityId: id,
    entities: { before: [entity], after: [{ ...entity, attrs, updatedAt: at }] },
    touched: [id],
    aliases: aliasesOf(world, [id]),
    links: linksOf(world, [id]),
    events: [],
  };
}

function planMerge(world: World, sourceId: string, intoId: string, at: string): Plan {
  if (sourceId === intoId) throw new ManageError('A record cannot be merged into itself.', 400);
  const source = live(world, sourceId);
  const target = live(world, intoId, source.kind);
  // Records merged into the source move to the target (no chains).
  const folded = [...world.byId.values()].filter((e) => e.mergedIntoId === sourceId);
  const touched = [sourceId, intoId, ...folded.map((e) => e.id)];
  const afterEntities: Entity[] = [
    { ...source, mergedIntoId: intoId, updatedAt: at },
    { ...target, updatedAt: at },
    ...folded.map((e) => ({ ...e, mergedIntoId: intoId, updatedAt: at })),
  ];
  // Every name and AKA of the source becomes an AKA of the target.
  const names = new Set<string>();
  for (const a of aliasesOf(world, touched)) names.add(a.aliasNormalized);
  if (source.kind !== 'place') names.add(source.nameNormalized);
  names.delete(target.nameNormalized);
  const aliases = [...names].map((aliasNormalized) => ({ entityId: intoId, kind: target.kind, aliasNormalized }));
  // Links move to the target; duplicates and links to itself are dropped. A
  // venue is in one place: the target's own wins over the source's.
  const pk = (l: EntityLink) => `${l.fromId}\u0000${l.toId}\u0000${l.role}`;
  const links = new Map<string, EntityLink>();
  const targetIn = world.links.some((l) => l.fromId === intoId && l.role === 'in');
  for (const l of linksOf(world, touched)) {
    if (targetIn && l.fromId === sourceId && l.role === 'in') continue;
    const moved = { ...l, fromId: l.fromId === sourceId ? intoId : l.fromId, toId: l.toId === sourceId ? intoId : l.toId };
    if (moved.fromId !== moved.toId && !links.has(pk(moved))) links.set(pk(moved), moved);
  }
  const events = rewriteEvents(world, source.kind, new Set([sourceId, intoId]), target, target.name);
  return {
    operation: 'merge',
    summary: `Merged ${source.kind} "${source.name}" into "${target.name}" (${plural(events.length, 'event')})`,
    sourceEntityId: sourceId,
    targetEntityId: intoId,
    entities: { before: [source, target, ...folded], after: afterEntities },
    touched,
    aliases,
    links: [...links.values()],
    events,
  };
}

function planAlias(world: World, id: string, alias: unknown, add: boolean, at: string): Plan {
  const entity = live(world, id);
  if (entity.kind === 'place') throw new ManageError('A place has no AKA; merge places instead.', 400);
  const raw = typeof alias === 'string' ? alias : '';
  const key = normalizeName(raw);
  if (!key) throw new ManageError('An AKA needs at least one letter or digit.', 400);
  const current = aliasesOf(world, [id]);
  const has = current.some((a) => a.aliasNormalized === key);
  let aliases: EntityAlias[];
  if (add) {
    if (key === entity.nameNormalized) throw new ManageError(`"${raw.trim()}" is already its name.`, 400);
    const other = holder(world, entity.kind, key, id);
    if (other) throw taken(other, entity.kind, other.nameNormalized === key ? '' : ' (as an AKA)');
    if (has) throw new ManageError(`"${raw.trim()}" is already an AKA.`, 400);
    aliases = [...current, { entityId: id, kind: entity.kind, aliasNormalized: key }];
  } else {
    if (!has) throw new ManageError(`"${raw.trim()}" is not an AKA of "${entity.name}".`, 404);
    aliases = current.filter((a) => a.aliasNormalized !== key);
  }
  const after = { ...entity, updatedAt: at };
  return {
    operation: add ? 'alias-add' : 'alias-remove',
    summary: `${add ? 'Added' : 'Removed'} AKA "${raw.trim()}" ${add ? 'to' : 'from'} "${entity.name}"`,
    sourceEntityId: id,
    entities: { before: [entity], after: [after] },
    touched: [id],
    aliases,
    links: linksOf(world, [id]),
    events: [],
  };
}

const labelGroup = (label?: Entity): string => normalizeName(String(label?.attrs.group ?? ''));

function planLink(world: World, fromId: string, toId: string, role: unknown, add: boolean, at: string): Plan {
  // A link needs only ids, so a person whose name is encrypted can take part.
  const from = live(world, fromId, undefined, { encrypted: true });
  const to = live(world, toId, undefined, { encrypted: true });
  const label = (e: Entity) => (e.nameEncrypted ? 'a person' : `"${e.name}"`);
  const rule = ALLOWED_LINKS.find((a) => a.from === from.kind && a.role === role && a.to === to.kind);
  if (!rule) throw new ManageError(`A ${from.kind} cannot be "${String(role)}" a ${to.kind}.`, 400);
  const current = linksOf(world, [fromId]);
  const same = (l: EntityLink) => l.fromId === fromId && l.toId === toId && l.role === role;
  let links: EntityLink[];
  if (add) {
    if (current.some(same)) throw new ManageError('That link is already there.', 400);
    // A venue is in one place; a series can have several hosts; a record has
    // one label per group (Outdoor replaces Indoor).
    const group = role === 'has_label' ? labelGroup(to) : '';
    const replaced = (l: EntityLink) =>
      l.fromId === fromId &&
      l.role === role &&
      (role === 'in' || (role === 'has_label' && Boolean(group) && labelGroup(world.byId.get(l.toId)) === group));
    const kept = current.filter((l) => !replaced(l));
    links = [...kept, { fromId, toId, role: role as LinkRole, createdAt: at }];
  } else {
    if (!current.some(same)) throw new ManageError('There is no such link.', 404);
    links = current.filter((l) => !same(l));
  }
  const verb = role === 'in' ? 'in' : role === 'has_label' ? 'labeled' : role === 'introduced_me_to' ? 'introduced you to' : 'hosted by';
  // A venue's place becomes the location of every event there.
  const events = add && role === 'in' ? venueRewrite(world, new Map([[fromId, toId]]), at) : [];
  return {
    operation: add ? 'link-add' : 'link-remove',
    summary: `${add ? 'Set' : 'Removed'} ${label(from)} ${verb} ${label(to)}${events.length ? ` (${plural(events.length, 'event')})` : ''}`,
    sourceEntityId: fromId,
    targetEntityId: toId,
    entities: { before: [from], after: [{ ...from, updatedAt: at }] },
    touched: [fromId],
    aliases: aliasesOf(world, [fromId]),
    links,
    events,
  };
}

// Events at these venues (venue ID to place ID) with the place as their
// location. Only the fields that change are kept.
function venueRewrite(world: World, places: Map<string, string>, at: string): HistoryEntry['events'] {
  const out: HistoryEntry['events'] = [];
  for (const linked of world.linked) {
    const placeId = linked.refs?.venueId ? places.get(linked.refs.venueId) : undefined;
    const place = placeId ? world.byId.get(placeId) : undefined;
    if (!place) continue;
    const stored = world.stored.get(linked.id)!;
    const { event } = withVenuePlace(splitEventCity(stored), place, at);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const f of ['city', 'region', 'country', 'sources', 'weather'] as const) {
      if (JSON.stringify(stored[f]) === JSON.stringify(event[f])) continue;
      before[f] = stored[f] ?? null;
      after[f] = event[f] ?? null;
    }
    if (Object.keys(after).length) out.push({ id: stored.id, before, after });
  }
  return out;
}

// Venues with no place whose events all use the same city are put in it,
// and their events without a city get it: one change, undone as one.
// Venues whose events disagree are left for you (venuePlaceConflicts).
function planVenuePlaces(world: World, at: string): Plan | null {
  const venues = [...world.byId.values()].filter((e) => e.kind === 'venue');
  const { agree } = venuePlaceSplit(venues, world.links, world.linked);
  const usable = agree.filter((a) => world.byId.get(a.placeId) && !world.byId.get(a.placeId)!.mergedIntoId);
  if (!usable.length) return null;
  const touched = usable.map((a) => a.venueId);
  const before = touched.map((id) => world.byId.get(id)!);
  const links = [
    ...linksOf(world, touched),
    ...usable.map((a) => ({ fromId: a.venueId, toId: a.placeId, role: 'in' as const, createdAt: at })),
  ];
  const events = venueRewrite(world, new Map(usable.map((a) => [a.venueId, a.placeId])), at);
  return {
    operation: 'link-add',
    summary: `Put ${plural(usable.length, 'venue')} in the city their events share (${plural(events.length, 'event')} filled)`,
    sourceEntityId: touched[0],
    entities: { before, after: before.map((e) => ({ ...e, updatedAt: at })) },
    touched,
    aliases: aliasesOf(world, touched),
    links,
    events,
  };
}

// ---- Applying and undoing ----------------------------------------------------

function applyFields(event: LoggedEvent, fields: Record<string, unknown>, keys: string[], at: string): LoggedEvent {
  const next: Record<string, unknown> = { ...event, updatedAt: at };
  for (const k of keys) {
    if (fields[k] === undefined || fields[k] === null) delete next[k];
    else next[k] = fields[k];
  }
  return next as unknown as LoggedEvent;
}

async function apply(store: LineupStore, world: World, plan: Plan, at: string): Promise<HistoryEntry> {
  const entry: HistoryEntry = {
    ...plan,
    id: randomUUID(),
    aliases: { before: aliasesOf(world, plan.touched), after: plan.aliases },
    links: { before: linksOf(world, plan.touched), after: plan.links },
    createdAt: at,
  };
  // History first: it holds everything needed to put things back.
  await store.putEntityHistory(entry);
  await store.putEntities(entry.entities.after);
  await store.replaceEntityAliases(entry.touched, entry.aliases.after);
  await store.replaceEntityLinks(entry.touched, entry.links.after);
  const events = entry.events.map((c) => applyFields(world.stored.get(c.id)!, c.after, Object.keys(c.after), at));
  if (events.length) await store.putEvents(events);
  return entry;
}

export async function planEntityRename(store: LineupStore, id: string, name: unknown, at = now()): Promise<EntityChangePlan> {
  const world = await load(store);
  return { world, plan: planRename(world, id, name, at), at };
}

export async function planEntityMerge(store: LineupStore, sourceId: string, intoId: string, at = now()): Promise<EntityChangePlan> {
  const world = await load(store);
  return { world, plan: planMerge(world, sourceId, intoId, at), at };
}

export async function applyEntityChangePlan(store: LineupStore, planned: EntityChangePlan): Promise<HistoryEntry> {
  return apply(store, planned.world, planned.plan, planned.at);
}

const now = () => new Date().toISOString();

export async function renameEntity(store: LineupStore, id: string, name: unknown, at = now()): Promise<HistoryEntry> {
  return applyEntityChangePlan(store, await planEntityRename(store, id, name, at));
}

export async function updatePerson(store: LineupStore, id: string, details: PersonDetails, at = now()): Promise<HistoryEntry> {
  const world = await load(store);
  return apply(store, world, planPerson(world, id, details ?? {}, at), at);
}

export async function updateAttrs(store: LineupStore, id: string, values: Record<string, unknown>, at = now()): Promise<HistoryEntry> {
  const world = await load(store);
  return apply(store, world, planAttrs(world, id, values, at), at);
}

export async function mergeEntity(store: LineupStore, sourceId: string, intoId: string, at = now()): Promise<HistoryEntry> {
  return applyEntityChangePlan(store, await planEntityMerge(store, sourceId, intoId, at));
}

export async function addAlias(store: LineupStore, id: string, alias: unknown, at = now()): Promise<HistoryEntry> {
  const world = await load(store);
  return apply(store, world, planAlias(world, id, alias, true, at), at);
}

export async function removeAlias(store: LineupStore, id: string, alias: unknown, at = now()): Promise<HistoryEntry> {
  const world = await load(store);
  return apply(store, world, planAlias(world, id, alias, false, at), at);
}

// See planVenuePlaces. Null when there was nothing to link.
export async function linkVenuePlaces(store: LineupStore, at = now()): Promise<HistoryEntry | null> {
  const world = await load(store);
  const plan = planVenuePlaces(world, at);
  return plan ? apply(store, world, plan, at) : null;
}

// Series records no event uses, with no other names, links, details or merged
// records pointing at them: left behind when an event's series was changed or
// typed part-way. `names` limits it to those records.
function unusedSeries(world: World, names?: string[]): Entity[] {
  const used = new Set(world.linked.map((e) => e.refs?.seriesId).filter(Boolean));
  const wanted = names ? new Set(names.map((n) => normalizeName(n)).filter(Boolean)) : null;
  const all = [...world.byId.values()];
  return all.filter(
    (e) =>
      e.kind === 'series' &&
      !e.mergedIntoId &&
      !used.has(e.id) &&
      (!wanted || wanted.has(e.nameNormalized)) &&
      !Object.keys(e.attrs ?? {}).length &&
      !world.aliases.some((a) => a.entityId === e.id) &&
      !world.links.some((l) => l.fromId === e.id || l.toId === e.id) &&
      !all.some((o) => o.mergedIntoId === e.id),
  );
}

// Removes those records, with one history entry that undo puts back. Null when there are none.
// Only a member's own records can be removed (the store refuses the shared ones).
export async function removeUnusedSeries(store: LineupStore, opts: { names?: string[] } = {}, at = now()): Promise<HistoryEntry | null> {
  const world = await load(store);
  const gone = unusedSeries(world, opts.names);
  if (!gone.length) return null;
  const entry: HistoryEntry = {
    id: randomUUID(),
    operation: 'remove',
    summary: `Removed ${plural(gone.length, 'unused series record')}: ${gone.map((e) => e.name).join(', ')}`,
    sourceEntityId: gone[0].id,
    entities: { before: gone, after: [] },
    touched: [],
    aliases: { before: [], after: [] },
    links: { before: [], after: [] },
    events: [],
    createdAt: at,
  };
  // Delete first, as a store without member tables refuses it and then nothing is logged;
  // a history entry that cannot be written puts the records straight back.
  await store.deleteEntities(gone.map((e) => e.id));
  try {
    await store.putEntityHistory(entry);
  } catch (err) {
    await store.putEntities(gone);
    throw err;
  }
  return entry;
}

// Venues with no place whose events use more than one city, for Data health.
export async function venuePlaceConflicts(store: LineupStore) {
  const world = await load(store);
  const venues = [...world.byId.values()].filter((e) => e.kind === 'venue');
  return venuePlaceSplit(venues, world.links, world.linked).conflicts;
}

export async function addLink(store: LineupStore, fromId: string, toId: string, role: unknown, at = now()): Promise<HistoryEntry> {
  const world = await load(store);
  return apply(store, world, planLink(world, fromId, toId, role, true, at), at);
}

export async function removeLink(store: LineupStore, fromId: string, toId: string, role: unknown, at = now()): Promise<HistoryEntry> {
  const world = await load(store);
  return apply(store, world, planLink(world, fromId, toId, role, false, at), at);
}

// A record you add by hand: an organization, or a label (with its group,
// such as Indoor/Outdoor). Every other kind comes from the names on your
// events.
export async function createEntity(
  store: LineupStore,
  kind: unknown,
  name: unknown,
  at = now(),
  group?: unknown,
): Promise<{ entity: Entity; entry: HistoryEntry }> {
  if (kind !== 'organization' && kind !== 'label') {
    throw new ManageError('Only organizations and labels are added here; the rest come from your events.', 400);
  }
  const display = cleanName(name);
  const key = normalizeName(display);
  const world = await load(store);
  const other = holder(world, kind, key);
  if (other) throw taken(other, kind, other.nameNormalized === key ? '' : ' (as an AKA)');
  const groupName = typeof group === 'string' ? group.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
  const attrs = kind === 'label' && groupName ? { group: groupName } : {};
  const entity: Entity = { id: randomUUID(), kind, name: display, nameNormalized: key, attrs, createdAt: at, updatedAt: at };
  const entry: HistoryEntry = {
    id: randomUUID(),
    operation: 'create',
    summary: `Added ${kind} "${display}"`,
    sourceEntityId: entity.id,
    entities: { before: [], after: [entity] },
    touched: [entity.id],
    aliases: { before: [], after: [] },
    links: { before: [], after: [] },
    events: [],
    createdAt: at,
  };
  await store.addEntities([entity]);
  await store.putEntityHistory(entry);
  return { entity, entry };
}

export interface UndoResult {
  entry: HistoryEntry;
  restored: number;
  // Events changed since, left as they are now.
  skipped: Array<{ id: string; name: string }>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sortedBy = <T>(list: T[], key: (t: T) => string) => [...list].sort((a, b) => key(a).localeCompare(key(b)));
const aliasKey = (a: EntityAlias) => `${a.entityId}\u0000${a.kind}\u0000${a.aliasNormalized}`;
const linkKey = (l: EntityLink) => `${l.fromId}\u0000${l.toId}\u0000${l.role}`;
const withoutIds = (seen: unknown) => (Array.isArray(seen) ? seen.map(({ artistId: _id, ...act }) => act) : seen);

// Puts back what one change did. Refused when its records changed since (undo
// the later change first). Events changed since are left as they are and
// listed; the rest get their names back.
export async function undoEntry(store: LineupStore, id: string, at = now()): Promise<UndoResult> {
  const entry = await store.getEntityHistory(id);
  if (!entry) throw new ManageError('No such change.', 404);
  if (entry.undoneAt) throw new ManageError('That change was already undone.', 409);
  if (entry.operation === 'create') throw new ManageError('Adding a record cannot be undone; rename or merge it instead.', 400);
  const world = await load(store);
  const later = () => new ManageError('Those records changed after this. Undo the later change first.', 409);
  for (const e of entry.entities.after) {
    const { updatedAt: _a, ...now } = world.byId.get(e.id) ?? ({} as Entity);
    const { updatedAt: _b, ...was } = e;
    if (!same(now, was)) throw later();
  }
  if (!same(sortedBy(aliasesOf(world, entry.touched), aliasKey).map(aliasKey), sortedBy(entry.aliases.after, aliasKey).map(aliasKey))) {
    throw later();
  }
  if (!same(sortedBy(linksOf(world, entry.touched), linkKey).map(linkKey), sortedBy(entry.links.after, linkKey).map(linkKey))) {
    throw later();
  }

  await store.putEntities(entry.entities.before.map((e) => ({ ...e, updatedAt: at })));
  await store.replaceEntityAliases(entry.touched, entry.aliases.before);
  await store.replaceEntityLinks(entry.touched, entry.links.before);
  const skipped: UndoResult['skipped'] = [];
  const events: LoggedEvent[] = [];
  for (const change of entry.events) {
    const event = world.stored.get(change.id);
    if (!event) continue; // deleted since
    const keys = Object.keys(change.after);
    const unchanged = keys
      .filter((k) => k !== 'sources')
      .every((k) => {
        const current = (event as unknown as Record<string, unknown>)[k];
        return k === 'seen' ? same(withoutIds(current), withoutIds(change.after[k])) : same(current ?? null, change.after[k] ?? null);
      });
    if (unchanged) events.push(applyFields(event, change.before, keys, at));
    else skipped.push({ id: event.id, name: event.name ?? '' });
  }
  if (events.length) await store.putEvents(events);
  const done = { ...entry, undoneAt: at };
  await store.putEntityHistory(done);
  return { entry: done, restored: events.length, skipped };
}
