import { LoggedEvent } from '../events/types';
import { ALLOWED_LINKS, ENTITY_KINDS, Entity, EntityAlias, EntityKind, EntityLink } from './types';

// The rules both stores enforce on entity writes. Supabase also has them as
// constraints (0014); the file store and the code paths Postgres cannot see
// (IDs inside JSON) rely on these. Each throws on the first broken rule.

export class EntityIntegrityError extends Error {}

const fail = (message: string): never => {
  throw new EntityIntegrityError(message);
};

// `all` is every stored record by ID, including the incoming ones' old rows.
export function checkEntities(all: Map<string, Entity>, incoming: Entity[]): void {
  const next = new Map(all);
  for (const e of incoming) next.set(e.id, e);
  const live = new Map<string, string>();
  for (const e of next.values()) {
    if (!ENTITY_KINDS.includes(e.kind)) fail(`Unknown entity kind "${e.kind}".`);
    if (e.nameEncrypted) {
      if (e.kind !== 'person') fail(`Only a person can have an encrypted name (${e.id}).`);
      if (e.name || e.nameNormalized) fail(`Person ${e.id} has an encrypted name and a plain one.`);
    } else if (!e.nameNormalized) fail(`Entity ${e.id} has no name.`);
    if (e.mergedIntoId) {
      if (e.mergedIntoId === e.id) fail(`Entity ${e.id} cannot be merged into itself.`);
      const target = next.get(e.mergedIntoId);
      if (!target) fail(`Entity ${e.id} is merged into a missing record.`);
      else if (target.mergedIntoId) fail(`Entity ${e.id} is merged into ${target.id}, which is itself merged; merges must be flattened.`);
      continue;
    }
    if (e.nameEncrypted) continue;
    const key = `${e.kind}\u0000${e.nameNormalized}`;
    const other = live.get(key);
    if (other && other !== e.id) fail(`Two live ${e.kind} records are named "${e.nameNormalized}".`);
    live.set(key, e.id);
  }
}

export function checkAliases(all: Map<string, Entity>, existing: EntityAlias[], incoming: EntityAlias[]): void {
  const owner = new Map(existing.map((a) => [`${a.kind}\u0000${a.aliasNormalized}`, a.entityId]));
  for (const a of incoming) {
    const entity = all.get(a.entityId);
    if (!entity) fail(`Alias "${a.aliasNormalized}" points at a missing record.`);
    else if (entity.kind !== a.kind) fail(`Alias "${a.aliasNormalized}" is a ${a.kind} alias on a ${entity.kind} record.`);
    if (!a.aliasNormalized) fail('An alias cannot be empty.');
    const key = `${a.kind}\u0000${a.aliasNormalized}`;
    const held = owner.get(key);
    if (held && held !== a.entityId) fail(`The ${a.kind} alias "${a.aliasNormalized}" already belongs to another record.`);
    owner.set(key, a.entityId);
  }
}

export function checkLinks(all: Map<string, Entity>, incoming: EntityLink[]): void {
  for (const l of incoming) {
    if (l.fromId === l.toId) fail('A record cannot link to itself.');
    const from = all.get(l.fromId);
    const to = all.get(l.toId);
    if (!from || !to) fail('A link points at a missing record.');
    if (!ALLOWED_LINKS.some((a) => a.from === from!.kind && a.role === l.role && a.to === to!.kind)) {
      fail(`A ${from!.kind} cannot be "${l.role}" a ${to!.kind}.`);
    }
  }
}

// IDs on an event must point at live records of the right kind.
export function checkEventRefs(all: Map<string, Entity>, event: LoggedEvent): void {
  const want = (id: string | null | undefined, kind: EntityKind) => {
    if (!id) return;
    const e = all.get(id);
    if (!e) fail(`Event ${event.id} points at a missing ${kind} record.`);
    else if (e.kind !== kind) fail(`Event ${event.id} points at a ${e.kind} record as its ${kind}.`);
    else if (e.mergedIntoId) fail(`Event ${event.id} points at a merged ${kind} record.`);
  };
  const refs = event.refs;
  if (refs) {
    want(refs.venueId, 'venue');
    want(refs.placeId, 'place');
    want(refs.seriesId, 'series');
    refs.companionIds.forEach((id) => want(id, 'person'));
  }
  event.personIds?.forEach((id) => want(id, 'person'));
  for (const act of event.seen) want(act.artistId, 'artist');
}
