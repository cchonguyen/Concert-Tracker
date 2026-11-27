// Artist orbits (docs/specs/genre-taxonomy-release-3.md, section 3; migration 0064). An orbit is the owner's
// shared curation of a few acts that belong together: 2 to 4 anchors, each a member at centrality 1.0, and
// other members at 0.5 or 0.25. Shared data with no personal fields. Only the owner (or a system job) writes
// them, and every write is logged and undoable. Never counted in a genre total.
import type { LineupStore } from '../lineup/store/types';

export type OrbitCentrality = 1 | 0.5 | 0.25;
export const ORBIT_CENTRALITIES: readonly OrbitCentrality[] = [1, 0.5, 0.25];
export const ORBIT_ORIGINS = ['curated', 'lineup_cluster', 'hybrid'] as const;
export type OrbitOrigin = (typeof ORBIT_ORIGINS)[number];
export const ORBIT_ANCHORS_MIN = 2;
export const ORBIT_ANCHORS_MAX = 4;

export interface ArtistOrbitMember {
  artistKey: string;
  centrality: OrbitCentrality;
}

export interface ArtistOrbit {
  id: string;
  anchorKeys: string[];
  workingLabel?: string;
  parentGenreKey?: string;
  origin: OrbitOrigin;
  members: ArtistOrbitMember[];
}

export interface ArtistOrbitChange {
  id: string;
  old: ArtistOrbit[];
  new: ArtistOrbit[];
  actor: string;
  reason: string;
  at: string;
  undoneAt?: string;
  undoneBy?: string;
}

export interface ArtistOrbitMeta {
  actor: string;
  reason: string;
}

// A refused write or undo. The status is the HTTP status a route answers with.
export class ArtistOrbitError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = 'ArtistOrbitError';
  }
}

// PostgREST (or Postgres) says the orbit functions are not there yet: the migration is not applied.
export function isMissingOrbitFunction(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === '42883' || code === 'PGRST202';
}

export function checkOrbitActor(actor: unknown): void {
  if (!(actor === 'owner' || (typeof actor === 'string' && actor.startsWith('system:')))) {
    throw new ArtistOrbitError('Only the owner or a system job changes artist orbits.', 400);
  }
}

function nonblank(value: unknown, what: string): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new ArtistOrbitError(`${what} is required.`, 400);
  return s;
}

// Validates and canonicalises orbits: anchors added at 1.0 when not listed, members sorted by centrality
// (highest first) then key, orbits sorted by id. genreKeys (when given) must hold every parentGenreKey.
export function normalizeArtistOrbits(next: unknown, genreKeys?: ReadonlySet<string>): ArtistOrbit[] {
  if (!Array.isArray(next)) throw new ArtistOrbitError('The orbits must be a list.', 400);
  const ids = new Set<string>();
  const out: ArtistOrbit[] = [];
  for (const raw of next) {
    if (!raw || typeof raw !== 'object') throw new ArtistOrbitError('Every orbit must be an object.', 400);
    const o = raw as Record<string, unknown>;
    const id = nonblank(o.id, 'An orbit id');
    if (ids.has(id)) throw new ArtistOrbitError(`Orbit ${id} is listed twice.`, 400);
    ids.add(id);

    if (!Array.isArray(o.anchorKeys)) throw new ArtistOrbitError(`Orbit ${id} needs anchorKeys.`, 400);
    const anchors = o.anchorKeys.map((a) => nonblank(a, 'An anchor'));
    if (new Set(anchors).size !== anchors.length) throw new ArtistOrbitError(`An anchor of orbit ${id} is listed twice.`, 400);
    if (anchors.length < ORBIT_ANCHORS_MIN || anchors.length > ORBIT_ANCHORS_MAX) {
      throw new ArtistOrbitError(`Orbit ${id} needs ${ORBIT_ANCHORS_MIN} to ${ORBIT_ANCHORS_MAX} anchors.`, 400);
    }

    const label = o.workingLabel === undefined || o.workingLabel === null ? '' : String(o.workingLabel).trim();
    let parentGenreKey: string | undefined;
    if (o.parentGenreKey !== undefined && o.parentGenreKey !== null && o.parentGenreKey !== '') {
      parentGenreKey = nonblank(o.parentGenreKey, 'A parent genre');
      if (genreKeys && !genreKeys.has(parentGenreKey)) throw new ArtistOrbitError(`${parentGenreKey} is not a genre.`, 400);
    }
    const origin = o.origin === undefined || o.origin === null || o.origin === '' ? 'curated' : o.origin;
    if (!ORBIT_ORIGINS.includes(origin as OrbitOrigin)) throw new ArtistOrbitError(`Orbit ${id} has an unknown origin.`, 400);

    if (o.members !== undefined && !Array.isArray(o.members)) throw new ArtistOrbitError(`Orbit ${id} members must be a list.`, 400);
    const members = new Map<string, OrbitCentrality>();
    for (const m of (o.members as unknown[] | undefined) ?? []) {
      const mm = (m ?? {}) as Record<string, unknown>;
      const artistKey = nonblank(mm.artistKey, 'A member');
      if (!ORBIT_CENTRALITIES.includes(mm.centrality as OrbitCentrality)) {
        throw new ArtistOrbitError(`${artistKey} in orbit ${id} needs a centrality of 1, 0.5 or 0.25.`, 400);
      }
      if (members.has(artistKey)) throw new ArtistOrbitError(`${artistKey} is listed twice in orbit ${id}.`, 400);
      members.set(artistKey, mm.centrality as OrbitCentrality);
    }
    for (const a of anchors) {
      const c = members.get(a);
      if (c === undefined) members.set(a, 1);
      else if (c !== 1) throw new ArtistOrbitError(`Anchor ${a} of orbit ${id} must have centrality 1.`, 400);
    }

    out.push({
      id,
      anchorKeys: anchors,
      ...(label ? { workingLabel: label } : {}),
      ...(parentGenreKey ? { parentGenreKey } : {}),
      origin: origin as OrbitOrigin,
      members: [...members]
        .map(([artistKey, centrality]) => ({ artistKey, centrality }))
        .sort((a, b) => b.centrality - a.centrality || (a.artistKey < b.artistKey ? -1 : a.artistKey > b.artistKey ? 1 : 0)),
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// The owner's write: checks the actor and reason, the genre keys in the vocabulary, then the store does the rest.
export async function writeArtistOrbits(
  store: LineupStore,
  next: unknown,
  replaceIds: unknown,
  actor: unknown,
  reason: unknown,
): Promise<ArtistOrbitChange> {
  checkOrbitActor(actor);
  const why = nonblank(reason, 'A reason');
  if (!Array.isArray(replaceIds)) throw new ArtistOrbitError('replaceIds must be a list.', 400);
  const replace = replaceIds.map((id) => nonblank(id, 'An orbit id'));
  const genreKeys = new Set((await store.getGenreVocabulary()).genres.map((g) => g.key));
  const orbits = normalizeArtistOrbits(next, genreKeys);
  return store.writeArtistOrbits(orbits, replace, { actor: actor as string, reason: why });
}

// The orbits that hold at least one of these act keys, each with its full roster.
export function orbitsForMember(orbits: ArtistOrbit[], keys: Set<string>): ArtistOrbit[] {
  return orbits.filter((o) => o.members.some((m) => keys.has(m.artistKey)));
}
