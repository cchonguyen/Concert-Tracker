import { randomUUID } from 'node:crypto';
import type { ArtistIdentity, Edition, EditionArtistRef, EditionHeader, EditionPerformance, EditionWeekend, SeriesKind } from '../lineup/types';
import { normalizeName } from '../lineup/text';
import type { CanonicalUndoResult, LineupStore } from '../lineup/store/types';
import { CanonicalStoreError, editionMatchesStatusFilter, isVerifiedStatus } from '../lineup/store/types';
import type { CanonicalEditionStatusFilter } from '../lineup/store/types';
import { currentMember } from '../auth/requestScope';
import { ArtistAliasRow, ArtistEditionRow, CANONICAL_OPERATIONS, CanonicalChange, Entity, EntityAlias, EntityLink, HistoryEntry } from './types';
import { applyEntityChangePlan, cleanName, EntityChangePlan, ManageError, planEntityMerge, planEntityRename, undoEntry, UndoResult } from './manage';

// Canonical editions for the owner's Global Archive (spec Phase 1).
// Only shared facts: no personal attendance, prices, notes or companions.
// Only confirmed editions are shown to members' suggestions (owner sees both).

// The newest editions the archive loads in one request (Workers' subrequest budget).
export const CANONICAL_EDITION_LIMIT = 200;

export type EditionStatusFilter = CanonicalEditionStatusFilter;

export interface CanonicalEditionSummary {
  id: string;
  key: string;
  seriesSlug: string | null;
  seriesName: string | null;
  seriesBrand: string | null;
  seriesKind: SeriesKind | null;
  seriesCity: string | null;
  seriesRegion: string | null;
  seriesCountry: string | null;
  year: number;
  name: string;
  startDate: string | null;
  endDate: string | null;
  venue: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  weekends: EditionWeekend[];
  status: Edition['status'];
  performanceCount: number;
  hasSetTimes: boolean;
}

export function summarizeEdition(e: EditionHeader & { performances?: EditionPerformance[] }): CanonicalEditionSummary {
  const performances = e.performances ?? [];
  return {
    id: e.id,
    key: e.key,
    seriesSlug: e.seriesSlug ?? null,
    seriesName: e.seriesName ?? null,
    seriesBrand: e.seriesBrand ?? null,
    seriesKind: e.seriesKind ?? null,
    seriesCity: e.seriesKind !== 'tour' ? (e.seriesCity ?? null) : null,
    seriesRegion: e.seriesKind !== 'tour' ? (e.seriesRegion ?? null) : null,
    seriesCountry: e.seriesKind !== 'tour' ? (e.seriesCountry ?? null) : null,
    year: e.year,
    name: e.name,
    startDate: e.startDate ?? null,
    endDate: e.endDate ?? null,
    venue: e.venue ?? null,
    city: e.city ?? null,
    region: e.region ?? null,
    country: e.country ?? null,
    weekends: e.weekends ?? [],
    status: e.status,
    performanceCount: performances.length,
    // Set times exist only where a source timed them (AGENTS.md): a set is timed when it has days or stages.
    hasSetTimes: performances.some((p) => p.days.length > 0 || p.stages.length > 0),
  };
}

// Filters and sorts the editions: newest year first, then name.
export function listCanonicalEditions(editions: Edition[], opts: { query?: string; status?: EditionStatusFilter } = {}): CanonicalEditionSummary[] {
  const status = opts.status ?? 'all';
  const q = (opts.query ?? '').trim().toLowerCase();
  return editions
    .filter((e) => editionMatchesStatusFilter(e.status, status))
    .filter((e) => !q || [e.name, e.seriesSlug ?? '', e.seriesName ?? '', e.seriesBrand ?? '', e.venue ?? ''].some((s) => s.toLowerCase().includes(q)))
    .map(summarizeEdition)
    .sort((a, b) => b.year - a.year || a.name.localeCompare(b.name));
}

// Only the owner may use /api/manage/canonical/* (spec section 5). Members get 403.
export const isOwner = (member: { role?: string } | null | undefined): boolean => member?.role === 'owner';

export type ArtistOrigin = 'from_me' | 'community_import' | 'unmanaged_fetch';

export interface CanonicalArtistSummary {
  key: string;
  name: string;
  mbid: string | null;
  origins: ArtistOrigin[];
  editionsCount: number;
  // Null until the cross-member "seen" aggregate exists. Never a guessed zero.
  communityCount: number | null;
}

// Unifies the owner's catalog (spec 3.2). Counts only; no member names.
// origins: from_me = in the owner's own seen names; unmanaged_fetch = in
// canonical_artists; community_import is not set until the aggregate exists.
export function unifyArtists(input: {
  canonical: ArtistIdentity[];
  ownerNames: string[];
  editions?: Edition[];
  artistRefs?: EditionArtistRef[];
  // From communityCounts(): name key -> members. Omit or null leaves communityCount null.
  communityCounts?: Map<string, number> | null;
}): CanonicalArtistSummary[] {
  const byKey = new Map<string, CanonicalArtistSummary>();
  const ensure = (key: string, name: string, mbid?: string): CanonicalArtistSummary => {
    let row = byKey.get(key);
    if (!row) {
      row = { key, name, mbid: mbid ?? null, origins: [], editionsCount: 0, communityCount: null };
      byKey.set(key, row);
    }
    return row;
  };
  for (const a of input.canonical) {
    const row = ensure(a.key, a.name, a.mbid);
    if (!row.origins.includes('unmanaged_fetch')) row.origins.push('unmanaged_fetch');
  }
  for (const n of input.ownerNames) {
    const key = normalizeName(n);
    if (!key) continue;
    const row = ensure(key, n);
    if (!row.origins.includes('from_me')) row.origins.push('from_me');
  }
  if (input.artistRefs) {
    for (const ref of input.artistRefs) {
      const row = byKey.get(ref.artistKey);
      if (row) row.editionsCount += 1;
    }
  } else {
    for (const e of input.editions ?? []) {
      if (!isVerifiedStatus(e.status)) continue;
      for (const p of e.performances) {
        const row = byKey.get(p.artistKey);
        if (row) row.editionsCount += 1;
      }
    }
  }
  // With counts, every row gets a number (0 when no live event has it). Without, null: unknown, not zero.
  if (input.communityCounts) {
    for (const row of byKey.values()) row.communityCount = input.communityCounts.get(row.key) ?? 0;
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// The acts of one canonical artist across editions (for the artist detail view).
export interface ArtistAppearance {
  editionId: string;
  editionName: string;
  year: number;
  startDate: string | null;
  venue: string | null;
  city: string | null;
  status: Edition['status'];
  billing: string | null;
  set: string | null;
  days: string[];
  stages: string[];
}

export function appearancesOf(editions: Edition[], artistKey: string): ArtistAppearance[] {
  const out: ArtistAppearance[] = [];
  for (const e of editions) {
    for (const p of e.performances) {
      if (p.artistKey !== artistKey) continue;
      out.push({
        editionId: e.id,
        editionName: e.name,
        year: e.year,
        startDate: e.startDate ?? null,
        venue: e.venue ?? null,
        city: e.city ?? null,
        status: e.status,
        billing: p.billing ?? null,
        set: p.set ?? null,
        days: p.days,
        stages: p.stages,
      });
    }
  }
  return out.sort((a, b) => b.year - a.year || a.editionName.localeCompare(b.editionName));
}

export function appearancesFromRefs(headers: EditionHeader[], refs: EditionArtistRef[], artistKey: string): ArtistAppearance[] {
  const byId = new Map(headers.map((h) => [h.id, h]));
  const out: ArtistAppearance[] = [];
  for (const ref of refs) {
    if (ref.artistKey !== artistKey) continue;
    const e = byId.get(ref.editionId);
    if (!e) continue;
    out.push({
      editionId: e.id,
      editionName: e.name,
      year: e.year,
      startDate: e.startDate ?? null,
      venue: e.venue ?? null,
      city: e.city ?? null,
      status: e.status,
      billing: null,
      set: null,
      days: [],
      stages: [],
    });
  }
  return out.sort((a, b) => b.year - a.year || a.editionName.localeCompare(b.editionName));
}

// ---- Catalog artists as records (Global archive, GA3) ----------------------
// Edits to canonical_artists, artist_aliases and performances (the edition
// links). Never a member's logged_events or seen text. The owner's own record
// of the artist follows only through the existing entity operations (manage.ts; its seen-text rewrites are the only event writes),
// and each such step is undone with its change. Every change writes a history
// entry first (entity_history, with a `canonical` manifest), so undo can put back
// exactly what it changed.

export interface CanonicalArtistRecord extends CanonicalArtistSummary {
  // Normalized AKAs of this artist (artist_aliases), sorted.
  akas: string[];
}

// The AKAs of each artist key, from artist_aliases (alias -> canonical name).
export function akasByKey(aliases: Record<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [alias, name] of Object.entries(aliases)) {
    const key = normalizeName(name);
    out.set(key, [...(out.get(key) ?? []), alias].sort());
  }
  return out;
}

export function withAkas(rows: CanonicalArtistSummary[], aliases: Record<string, string>): CanonicalArtistRecord[] {
  const by = akasByKey(aliases);
  return rows.map((r) => ({ ...r, akas: by.get(r.key) ?? [] }));
}

// The state a change touches: artists, their performances, and AKA rows.
interface Scope {
  artists: ArtistIdentity[];
  performances: ArtistEditionRow[];
  aliases: ArtistAliasRow[];
}

const perfKey = (r: { editionId: string; artistKey: string }) => `${r.editionId}\u0000${r.artistKey}`;
const sortBy = <T>(list: T[], key: (t: T) => string) => [...list].sort((a, b) => key(a).localeCompare(key(b)));

// JSON with sorted keys and no undefined values, so two equal records compare equal.
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );

// The AKA rows for these alias keys, as stored.
function aliasRows(map: Record<string, string>, keys: Iterable<string>): ArtistAliasRow[] {
  return [...new Set(keys)]
    .filter((k) => map[k] !== undefined)
    .sort()
    .map((alias) => ({ alias, name: map[alias] }));
}

// The AKA rows that differ between two maps, before and after.
function aliasDiff(before: Record<string, string>, after: Record<string, string>, keys: Iterable<string>) {
  const changed = [...new Set(keys)].filter((k) => before[k] !== after[k]);
  return { before: aliasRows(before, changed), after: aliasRows(after, changed) };
}

const scopeKeys = (list: ArtistIdentity[]) => [...new Set(list.map((a) => a.key))];

// Writes `target` over `current`, in an order the foreign keys allow: artists
// first (an MBID is freed before it is set again), then performances, then AKAs,
// then the artists that are gone. Only rows that differ are written.
async function writeScope(store: LineupStore, current: Scope, target: Scope): Promise<void> {
  for (const c of current.artists) {
    if (c.mbid && !target.artists.some((t) => t.key === c.key && t.mbid === c.mbid)) await store.upsertArtist({ ...c, mbid: undefined });
  }
  for (const t of target.artists) {
    if (!current.artists.some((c) => stable(c) === stable(t))) await store.upsertArtist(t);
  }
  await store.putArtistPerformances(
    target.performances.filter((t) => !current.performances.some((c) => perfKey(c) === perfKey(t) && stable(c) === stable(t))),
  );
  const gone = current.performances.filter((c) => !target.performances.some((t) => perfKey(t) === perfKey(c)));
  await store.deleteArtistPerformances(gone.map(({ editionId, artistKey }) => ({ editionId, artistKey })));
  const put: Record<string, string> = {};
  for (const t of target.aliases) {
    if (!current.aliases.some((c) => c.alias === t.alias && c.name === t.name)) put[t.alias] = t.name;
  }
  if (Object.keys(put).length) await store.putAliases(put);
  for (const c of current.aliases) {
    if (!target.aliases.some((t) => t.alias === c.alias)) await store.deleteAlias(c.alias);
  }
  const removed = current.artists.filter((c) => !target.artists.some((t) => t.key === c.key)).map((c) => c.key);
  await store.deleteArtists(removed);
}

// Whether the stored state for these keys and AKA keys is exactly `expected`.
async function holds(store: LineupStore, keys: string[], aliasKeys: string[], expected: Scope): Promise<boolean> {
  const [artists, perfs, map] = await Promise.all([store.getArtists(keys), store.artistPerformances(keys), store.getAliases()]);
  return (
    stable(sortBy(artists, (a) => a.key)) === stable(sortBy(expected.artists, (a) => a.key)) &&
    stable(sortBy(perfs, perfKey)) === stable(sortBy(expected.performances, perfKey)) &&
    stable(aliasRows(map, aliasKeys)) === stable(sortBy(expected.aliases, (a) => a.alias))
  );
}

function sides(change: CanonicalChange): { before: Scope; after: Scope } {
  return {
    before: { artists: change.artists.before, performances: change.performances.before, aliases: change.aliases.before },
    after: { artists: change.artists.after, performances: change.performances.after, aliases: change.aliases.after },
  };
}

// The keys a change reads back when it is undone.
function touchedKeys(change: CanonicalChange): { artistKeys: string[]; aliasKeys: string[] } {
  const { before, after } = sides(change);
  return {
    artistKeys: [...new Set([...scopeKeys(before.artists), ...scopeKeys(after.artists)])],
    aliasKeys: [...new Set([...before.aliases, ...after.aliases].map((a) => a.alias))],
  };
}

const now = () => new Date().toISOString();
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

async function loadArtist(store: LineupStore, key: string): Promise<ArtistIdentity> {
  const artist = await store.getArtist(key);
  if (!artist) throw new ManageError('No such artist.', 404);
  return artist;
}

// A key another artist or AKA holds cannot take this one (merge them instead).
async function assertFree(store: LineupStore, aliases: Record<string, string>, key: string, self: string): Promise<void> {
  const other = await store.getArtist(key);
  if (other && other.key !== self) {
    throw new ManageError(`Another artist is already called "${other.name}". Merge them instead.`, 409, { id: other.key, name: other.name });
  }
  const held = aliases[key];
  if (held !== undefined && normalizeName(held) !== self) {
    throw new ManageError(`"${held}" is already an AKA of another artist. Merge them instead.`, 409, { id: normalizeName(held), name: held });
  }
}

// ---- Planner (spec "owner planner") ------------------------------------------
// One read-only planner for every catalog artist change. Preview and apply both
// call planArtistChange over the same snapshot; applyArtistChangePlan writes only
// what the plan holds and recomputes nothing. Planning writes nothing.
//
// The planner is NOT an authorization boundary. The owner-only routes and the
// store RPC (canonical_assert_owner in migration 0037) decide who may plan or apply.
//
// No fingerprint here: canonical_artist_fingerprint (migration 0037) computes it in
// SQL, so there is one algorithm. The store slice calls it on `entry`.

export type CanonicalOperation = (typeof CANONICAL_OPERATIONS)[number];

export type ArtistChangeInput =
  | { op: 'rename'; name: unknown }
  | { op: 'alias-add'; name: unknown }
  | { op: 'alias-remove'; name: unknown }
  | { op: 'merge'; into: string };

export interface ArtistChangeImpact {
  // Distinct editions with at least one performance row changed (a collapsed merge row counts).
  editionsAffected: number;
  // Existing performance rows whose artist key moves (merge collisions: the collapsed source row counts).
  performancesMoved: number;
  // The owner's artist records the operation changes: 0, 1 or 2. No details.
  ownerRecordsAffected: number;
  // Name keys in the aggregate community map whose canonical resolution changes. Null when unavailable.
  communityNameKeysAffected: number | null;
}

// The SQL contract's row images (migration 0037): snake_case, the columns the function compares.
export interface SqlArtistImage {
  key: string;
  name: string;
  mbid: string | null;
  resolved_at: string | null;
}

export interface SqlPerformanceImage {
  id: string | null; // null when the store did not supply the row id (see ArtistChangePlan.sqlReady)
  edition_id: string;
  artist_key: string;
  name: string;
  days: string[];
  stages: string[];
  status: EditionPerformance['status'];
  billing: string | null;
  confidence: number;
  sources: unknown[];
  slot_id: string | null;
  alias: string | null;
  b2b: string[] | null;
  set: string | null;
}

export interface SqlEntityImage {
  id: string;
  kind: string;
  name: string;
  name_normalized: string;
  attrs: Record<string, unknown>;
  merged_into_id: string | null;
}

// An owner alias row (entity_aliases, or companion_token in user_entity_aliases) of a touched owner record.
export interface SqlOwnerAliasImage {
  entity_id: string;
  kind: string;
  alias: string;
}

// An owner link row (entity_links, or user_entity_links) of a touched owner record.
export interface SqlOwnerLinkImage {
  from_id: string;
  to_id: string;
  role: string;
  created_at: string | null;
}

// The seen text of one event row the rewrite changes (logged_events.seen).
export interface SqlEventSeenImage {
  id: string;
  seen: unknown;
}

// One activity_log row for a seen-text change: the same row the TypeScript store writes (diffEvent, activityLog.ts).
export interface SqlActivityRow {
  event_id: string;
  action: 'update';
  field: 'seen';
  before: unknown;
  after: unknown;
  sensitive: boolean;
}

// The plan as the SQL function takes it (migration 0037, header comment).
export interface SqlCanonicalEntry {
  id: string;
  operation: CanonicalOperation;
  summary: string;
  createdAt: string;
  canonical: {
    key: string;
    artists: { before: SqlArtistImage[]; after: SqlArtistImage[] };
    performances: { before: SqlPerformanceImage[]; after: SqlPerformanceImage[] };
    aliases: { before: ArtistAliasRow[]; after: ArtistAliasRow[] };
    owner: { before: SqlEntityImage[]; after: SqlEntityImage[] };
    // Owner-side writes of the personal record change (migration 0037): applied in the same transaction.
    ownerTouched: string[];
    ownerAliases: { before: SqlOwnerAliasImage[]; after: SqlOwnerAliasImage[] };
    ownerLinks: { before: SqlOwnerLinkImage[]; after: SqlOwnerLinkImage[] };
    events: { before: SqlEventSeenImage[]; after: SqlEventSeenImage[] };
    // One row per changed seen text, written to activity_log by the SQL apply (migration 0037).
    activity: SqlActivityRow[];
  };
}

export interface ArtistChangePlan {
  id: string;
  at: string;
  key: string;
  operation: CanonicalOperation;
  summary: string;
  impact: ArtistChangeImpact;
  // The change as the TypeScript apply writes it (camelCase, full before and after).
  change: CanonicalChange;
  // The owner's own record change (manage.ts), planned read-only and applied by applyArtistChangePlan.
  personal?: EntityChangePlan;
  // The same change as the SQL contract's history entry. Input for canonical_artist_fingerprint and
  // canonical_apply_artist_change in the store slice. It includes the owner-side images (aliases, links, event seen text).
  entry: SqlCanonicalEntry;
  // False when a performance row has no id, or an owner event change is not seen text only, so `entry` cannot be applied by SQL yet.
  sqlReady: boolean;
}

type PlanRow = ArtistEditionRow & { id?: string };

// What one operation decides: the before and after of every side, and the owner's record change.
interface Draft {
  operation: CanonicalOperation;
  summary: string;
  // Artist keys the change reads and writes (the SQL function's key set).
  keys: string[];
  artists: { before: ArtistIdentity[]; after: ArtistIdentity[] };
  performances: { before: PlanRow[]; after: PlanRow[] };
  aliases: { before: ArtistAliasRow[]; after: ArtistAliasRow[] };
  nextAliases: Record<string, string>;
  // The artist key a performance row moves away from (rename or merge).
  movedFrom?: string;
  personal?: EntityChangePlan;
  ownerRecords: number;
}

const resolvesTo = (aliases: Record<string, string>, k: string) => (aliases[k] !== undefined ? normalizeName(aliases[k]) : k);

// Editions with at least one performance row that differs between the two sides.
const editionsChanged = (before: PlanRow[], after: PlanRow[]): Set<string> => {
  const out = new Set<string>();
  const afterBy = new Map(after.map((r) => [perfKey(r), r]));
  const beforeKeys = new Set(before.map(perfKey));
  for (const b of before) {
    const a = afterBy.get(perfKey(b));
    if (!a || stable(a) !== stable(b)) out.add(b.editionId);
  }
  for (const a of after) if (!beforeKeys.has(perfKey(a))) out.add(a.editionId);
  return out;
};

function countChangedResolutions(counts: Map<string, number>, before: Record<string, string>, after: Record<string, string>): number {
  let n = 0;
  for (const k of counts.keys()) if (resolvesTo(before, k) !== resolvesTo(after, k)) n += 1;
  return n;
}

// The owner's own artist record with this key, when there is one to follow.
const personalIn = (entities: Entity[], key: string): Entity | undefined =>
  entities.find((e) => e.kind === 'artist' && !e.mergedIntoId && !e.nameEncrypted && e.nameNormalized === key);

const artistImage = (a: ArtistIdentity): SqlArtistImage => ({
  key: a.key,
  name: a.name,
  mbid: a.mbid ?? null,
  resolved_at: a.resolvedAt ?? null,
});

const performanceImage = (r: PlanRow): SqlPerformanceImage => ({
  id: r.id ?? null,
  edition_id: r.editionId,
  artist_key: r.artistKey,
  name: r.name,
  days: r.days,
  stages: r.stages,
  status: r.status,
  billing: r.billing ?? null,
  confidence: r.confidence,
  sources: r.sources,
  slot_id: r.slotId ?? null,
  alias: r.alias ?? null,
  b2b: r.b2b ?? null,
  set: r.set ?? null,
});

const entityImage = (e: Entity): SqlEntityImage => ({
  id: e.id,
  kind: e.kind,
  name: e.name,
  name_normalized: e.nameNormalized,
  attrs: e.attrs,
  merged_into_id: e.mergedIntoId ?? null,
});

const ownerAliasImage = (a: EntityAlias): SqlOwnerAliasImage => ({ entity_id: a.entityId, kind: a.kind, alias: a.aliasNormalized });

const ownerLinkImage = (l: EntityLink): SqlOwnerLinkImage => ({
  from_id: l.fromId,
  to_id: l.toId,
  role: l.role,
  created_at: l.createdAt ?? null,
});

// Owner-side images for the SQL apply (migration 0037): the personal record's aliases, links and event seen text.
// Read from the same snapshot the personal plan was built on. Pure: nothing is written.
interface OwnerSideImages {
  touched: string[];
  aliases: { before: SqlOwnerAliasImage[]; after: SqlOwnerAliasImage[] };
  links: { before: SqlOwnerLinkImage[]; after: SqlOwnerLinkImage[] };
  events: { before: SqlEventSeenImage[]; after: SqlEventSeenImage[] };
  // One activity row per event whose seen text changes (what the TypeScript store logs for the same save).
  activity: SqlActivityRow[];
  // False when an event change rewrites a field other than seen text (the SQL contract covers seen text only).
  supported: boolean;
}

function ownerSideImages(personal: EntityChangePlan | undefined): OwnerSideImages {
  if (!personal) {
    return {
      touched: [],
      aliases: { before: [], after: [] },
      links: { before: [], after: [] },
      events: { before: [], after: [] },
      activity: [],
      supported: true,
    };
  }
  const { world, plan } = personal;
  const touched = new Set(plan.touched);
  return {
    touched: [...touched],
    aliases: {
      before: world.aliases.filter((a) => touched.has(a.entityId)).map(ownerAliasImage),
      after: plan.aliases.map(ownerAliasImage),
    },
    links: {
      before: world.links.filter((l) => touched.has(l.fromId) || touched.has(l.toId)).map(ownerLinkImage),
      after: plan.links.map(ownerLinkImage),
    },
    events: {
      before: plan.events.map((c) => ({ id: c.id, seen: c.before.seen ?? null })),
      after: plan.events.map((c) => ({ id: c.id, seen: c.after.seen ?? null })),
    },
    // Same rule as diffEvent: only a changed field makes a row, and the values are the stored values (no blanking: seen is not sensitive).
    activity: plan.events
      .filter((c) => JSON.stringify(c.before.seen ?? null) !== JSON.stringify(c.after.seen ?? null))
      .map((c) => ({
        event_id: c.id,
        action: 'update' as const,
        field: 'seen' as const,
        before: c.before.seen ?? null,
        after: c.after.seen ?? null,
        sensitive: false,
      })),
    supported: plan.events.every((c) => Object.keys(c.after).every((k) => k === 'seen')),
  };
}

async function draftRename(
  store: LineupStore,
  key: string,
  artist: ArtistIdentity,
  newName: unknown,
  aliases: Record<string, string>,
  entities: Entity[],
  at: string,
): Promise<Draft> {
  const name = cleanName(newName);
  if (name === artist.name) throw new ManageError(`It is already called "${name}".`, 400);
  const newKey = normalizeName(name);
  if (newKey !== key) await assertFree(store, aliases, newKey, key);
  // The old name is kept as an AKA; AKAs that named this artist now name the new one.
  const next = { ...aliases };
  const touched = new Set([key, newKey]);
  for (const [alias, value] of Object.entries(aliases)) {
    if (normalizeName(value) === key) {
      next[alias] = name;
      touched.add(alias);
    }
  }
  if (aliases[newKey] !== undefined && normalizeName(aliases[newKey]) === key) delete next[newKey];
  if (newKey !== key) next[key] = name;
  const performances: PlanRow[] = await store.artistPerformances([key]);
  const mine = personalIn(entities, key);
  const personal = mine && mine.name !== name ? await planEntityRename(store, mine.id, name, at) : undefined;
  const kept = newKey !== key ? ` (“${artist.name}” kept as an AKA)` : '';
  return {
    operation: 'canonical-rename',
    summary: `Renamed artist "${artist.name}" to "${name}"${kept}${personal ? ', and your own record' : ''}`,
    keys: [...new Set([key, newKey])],
    artists: { before: [artist], after: [{ ...artist, key: newKey, name }] },
    performances: { before: performances, after: performances.map((p) => ({ ...p, artistKey: newKey })) },
    aliases: aliasDiff(aliases, next, touched),
    nextAliases: next,
    movedFrom: newKey !== key ? key : undefined,
    personal,
    ownerRecords: personal ? 1 : 0,
  };
}

// Merges `sourceKey` into `targetKey`: the target keeps its name, takes the source's
// MBID when it has none (else keeps its own), and the source's name and AKAs become
// AKAs of the target. Performances move to the target; where both have an edition,
// the target's row keeps its fields and takes the source's billing and sources.
async function draftMerge(
  store: LineupStore,
  sourceKey: string,
  source: ArtistIdentity,
  targetKey: string,
  aliases: Record<string, string>,
  entities: Entity[],
  at: string,
): Promise<Draft> {
  const target = await loadArtist(store, targetKey);
  const sourceHeld = aliases[sourceKey];
  if (sourceHeld !== undefined && normalizeName(sourceHeld) !== sourceKey && normalizeName(sourceHeld) !== targetKey) {
    throw new ManageError(`"${sourceHeld}" is already an AKA of another artist. Merge them instead.`, 409, { id: normalizeName(sourceHeld), name: sourceHeld });
  }
  const targetHeld = aliases[targetKey];
  if (targetHeld !== undefined && normalizeName(targetHeld) !== sourceKey && normalizeName(targetHeld) !== targetKey) {
    throw new ManageError(`"${targetHeld}" is already an AKA of another artist. Merge them instead.`, 409, { id: normalizeName(targetHeld), name: targetHeld });
  }

  const merged: ArtistIdentity = { ...target, mbid: target.mbid ?? source.mbid };
  if (merged.mbid === undefined) delete merged.mbid;

  const rows: PlanRow[] = await store.artistPerformances([sourceKey, targetKey]);
  const byEdition = new Map<string, { source?: PlanRow; target?: PlanRow }>();
  for (const r of rows) {
    const slot = byEdition.get(r.editionId) ?? {};
    if (r.artistKey === sourceKey) slot.source = r;
    else slot.target = r;
    byEdition.set(r.editionId, slot);
  }
  const after: PlanRow[] = [];
  for (const { source: s, target: t } of byEdition.values()) {
    if (t && s) {
      const sources = [...t.sources, ...s.sources.filter((x) => !t.sources.some((y) => stable(y) === stable(x)))];
      after.push({ ...t, billing: t.billing ?? s.billing, sources });
    } else if (t) after.push(t);
    else if (s) after.push({ ...s, artistKey: targetKey });
  }

  // AKAs of the source (and the source's own name) now name the target.
  const next = { ...aliases };
  const touched = new Set([sourceKey, targetKey]);
  for (const [alias, value] of Object.entries(aliases)) {
    if (normalizeName(value) === sourceKey) {
      next[alias] = target.name;
      touched.add(alias);
    }
  }
  next[sourceKey] = target.name;
  touched.add(sourceKey);
  delete next[targetKey];
  touched.add(targetKey);

  // The owner's own records follow: both present, merge them; only the source's, it takes the target's name.
  const mineSource = personalIn(entities, sourceKey);
  const mineTarget = personalIn(entities, targetKey);
  let personal: EntityChangePlan | undefined;
  let ownerRecords = 0;
  if (mineSource && mineTarget) {
    personal = await planEntityMerge(store, mineSource.id, mineTarget.id, at);
    ownerRecords = 2;
  } else if (mineSource && mineSource.name !== target.name) {
    personal = await planEntityRename(store, mineSource.id, target.name, at);
    ownerRecords = 1;
  }
  const own = personal ? ', and your own record' : '';
  return {
    operation: 'canonical-merge',
    summary: `Merged artist "${source.name}" into "${target.name}" (${plural(byEdition.size, 'edition')})${own}`,
    keys: [sourceKey, targetKey],
    artists: { before: [source, target], after: [merged] },
    performances: { before: rows, after },
    aliases: aliasDiff(aliases, next, touched),
    nextAliases: next,
    movedFrom: sourceKey,
    personal,
    ownerRecords,
  };
}

// Adds or removes an AKA (an alias of the artist's normalized name).
async function draftAka(
  store: LineupStore,
  key: string,
  artist: ArtistIdentity,
  alias: unknown,
  add: boolean,
  aliases: Record<string, string>,
): Promise<Draft> {
  const raw = typeof alias === 'string' ? alias.trim() : '';
  const aka = normalizeName(raw);
  if (!aka) throw new ManageError('An AKA needs at least one letter or digit.', 400);
  const held = aliases[aka];
  const next = { ...aliases };
  if (add) {
    if (aka === key) throw new ManageError(`"${raw}" is already its name.`, 400);
    if (held !== undefined && normalizeName(held) === key) throw new ManageError(`"${raw}" is already an AKA.`, 400);
    if (held !== undefined) throw new ManageError(`"${raw}" is already an AKA of "${held}". Merge them instead.`, 409, { id: normalizeName(held), name: held });
    const other = await store.getArtist(aka);
    if (other) throw new ManageError(`Another artist is already called "${other.name}". Merge them instead.`, 409, { id: other.key, name: other.name });
    next[aka] = artist.name;
  } else {
    if (held === undefined || normalizeName(held) !== key) throw new ManageError(`"${raw}" is not an AKA of "${artist.name}".`, 404);
    delete next[aka];
  }
  // An AKA change leaves the artist and its editions as they are. The plan still holds them, so the state check is exact.
  const performances: PlanRow[] = await store.artistPerformances([key]);
  return {
    operation: add ? 'canonical-alias-add' : 'canonical-alias-remove',
    summary: `${add ? 'Added' : 'Removed'} AKA "${aka}" ${add ? 'to' : 'from'} "${artist.name}"`,
    keys: [key],
    artists: { before: [artist], after: [artist] },
    performances: { before: performances, after: [...performances] },
    aliases: aliasDiff(aliases, next, [aka]),
    nextAliases: next,
    ownerRecords: 0,
  };
}

// Plans one catalog artist change. Read-only: it reads the store and returns the
// plan; nothing is written. `at` is the change time. `opts.communityCounts: false`
// skips the cross-member aggregate (communityNameKeysAffected is then null).
export async function planArtistChange(
  store: LineupStore,
  key: string,
  input: ArtistChangeInput,
  at = now(),
  opts: { communityCounts?: boolean } = {},
): Promise<ArtistChangePlan> {
  if (input.op === 'merge' && input.into === key) throw new ManageError('An artist cannot be merged into itself.', 400);
  const artist = await loadArtist(store, key);
  const aliases = await store.getAliases();
  const entities = await store.listEntities();
  const draft =
    input.op === 'rename'
      ? await draftRename(store, key, artist, input.name, aliases, entities, at)
      : input.op === 'merge'
        ? await draftMerge(store, key, artist, input.into, aliases, entities, at)
        : await draftAka(store, key, artist, input.name, input.op === 'alias-add', aliases);
  const counts = opts.communityCounts === false ? null : await store.communityCounts();

  const id = randomUUID();
  const { before, after } = draft.performances;
  const impact: ArtistChangeImpact = {
    editionsAffected: editionsChanged(before, after).size,
    performancesMoved: draft.movedFrom ? before.filter((r) => r.artistKey === draft.movedFrom).length : 0,
    ownerRecordsAffected: draft.ownerRecords,
    communityNameKeysAffected: counts ? countChangedResolutions(counts, aliases, draft.nextAliases) : null,
  };

  // Owner rows the SQL function compares: every artist record with a touched name key, plus the records the plan changes.
  const personalIds = new Set((draft.personal?.plan.entities.before ?? []).map((e) => e.id));
  const afterById = new Map((draft.personal?.plan.entities.after ?? []).map((e) => [e.id, e] as const));
  const keySet = new Set(draft.keys);
  const ownerBefore = entities.filter((e) => e.kind === 'artist' && (keySet.has(e.nameNormalized) || personalIds.has(e.id)));
  const ownerAfter = ownerBefore.map((e) => afterById.get(e.id) ?? e);

  const owner = ownerSideImages(draft.personal);
  const entry: SqlCanonicalEntry = {
    id,
    operation: draft.operation,
    summary: draft.summary,
    createdAt: at,
    canonical: {
      key,
      artists: { before: draft.artists.before.map(artistImage), after: draft.artists.after.map(artistImage) },
      performances: { before: before.map(performanceImage), after: after.map(performanceImage) },
      aliases: draft.aliases,
      owner: { before: ownerBefore.map(entityImage), after: ownerAfter.map(entityImage) },
      ownerTouched: owner.touched,
      ownerAliases: owner.aliases,
      ownerLinks: owner.links,
      events: owner.events,
      activity: owner.activity,
    },
  };
  return {
    id,
    at,
    key,
    operation: draft.operation,
    summary: draft.summary,
    impact,
    change: { key, artists: draft.artists, performances: draft.performances, aliases: draft.aliases },
    personal: draft.personal,
    entry,
    sqlReady: [...before, ...after].every((r) => typeof r.id === 'string') && owner.supported,
  };
}

// Writes a plan: the owner's record change (manage.ts) first, then the history entry, then the catalog writes.
export async function applyArtistChangePlan(store: LineupStore, plan: ArtistChangePlan): Promise<HistoryEntry> {
  const personalHistoryId = plan.personal ? (await applyEntityChangePlan(store, plan.personal)).id : undefined;
  return applyArtistChange(store, {
    id: plan.id,
    operation: plan.operation,
    summary: plan.summary,
    sourceEntityId: plan.key,
    entities: { before: [], after: [] },
    touched: [],
    aliases: { before: [], after: [] },
    links: { before: [], after: [] },
    events: [],
    createdAt: plan.at,
    canonical: { ...plan.change, personalHistoryId },
  });
}

// History first, then the writes: the entry holds what undo needs.
async function applyArtistChange(store: LineupStore, entry: HistoryEntry): Promise<HistoryEntry> {
  await store.putEntityHistory(entry);
  await writeScope(store, sides(entry.canonical!).before, sides(entry.canonical!).after);
  return entry;
}

// The four operations the routes call: plan (no community aggregate) and apply.
const planAndApply = async (store: LineupStore, key: string, input: ArtistChangeInput, at: string) =>
  applyArtistChangePlan(store, await planArtistChange(store, key, input, at, { communityCounts: false }));

export async function renameArtist(store: LineupStore, key: string, newName: unknown, at = now()): Promise<HistoryEntry> {
  return planAndApply(store, key, { op: 'rename', name: newName }, at);
}

// Merges `sourceKey` into `targetKey` (see draftMerge).
export async function mergeArtists(store: LineupStore, sourceKey: string, targetKey: string, at = now()): Promise<HistoryEntry> {
  return planAndApply(store, sourceKey, { op: 'merge', into: targetKey }, at);
}

export async function addArtistAka(store: LineupStore, key: string, alias: unknown, at = now()): Promise<HistoryEntry> {
  return planAndApply(store, key, { op: 'alias-add', name: alias }, at);
}

export async function removeArtistAka(store: LineupStore, key: string, alias: unknown, at = now()): Promise<HistoryEntry> {
  return planAndApply(store, key, { op: 'alias-remove', name: alias }, at);
}

// Puts back a catalog artist change. Refused when its records changed since (undo
// the later change first). An owner's own record changed by the same step is undone first.
async function undoArtistChange(store: LineupStore, entry: HistoryEntry, at: string): Promise<UndoResult> {
  if (!isOwner(currentMember())) throw new ManageError('Only the owner can do this.', 403);
  if (entry.undoneAt) throw new ManageError('That change was already undone.', 409);
  const change = entry.canonical!;
  const { before, after } = sides(change);
  const { artistKeys, aliasKeys } = touchedKeys(change);
  if (!(await holds(store, artistKeys, aliasKeys, after))) {
    throw new ManageError('Those records changed after this. Undo the later change first.', 409);
  }
  let personal: UndoResult | undefined;
  if (change.personalHistoryId) personal = await undoEntry(store, change.personalHistoryId, at);
  await writeScope(store, after, before);
  const done = { ...entry, undoneAt: at };
  await store.putEntityHistory(done);
  return { entry: done, restored: 0, skipped: personal?.skipped ?? [] };
}

// Undo of a canonical apply made through the file store (8.7). Those applies are kept in the store's
// canonical change log, not in entity history, so the history lookup above does not find them.
// The owner check runs first; the store then checks the "after" side and writes nothing on refusal.
export type CanonicalUndoOutcome = CanonicalUndoResult & { undoneAt?: string };

async function undoFileCanonicalChange(store: LineupStore, id: string, at: string): Promise<UndoResult | CanonicalUndoOutcome> {
  if (!isOwner(currentMember())) throw new ManageError('Only the owner can do this.', 403);
  try {
    const result = await store.undoCanonicalArtistChange(id);
    return { ...result, undoneAt: at };
  } catch (err) {
    if (err instanceof CanonicalStoreError && err.code === 'stale') throw new ManageError(err.message, 409);
    if (err instanceof CanonicalStoreError && err.code === 'forbidden') throw new ManageError('Only the owner can do this.', 403);
    // The file store reports an id it does not hold as this message: fall through to the Manage path's 404.
    if (err instanceof CanonicalStoreError && err.message === 'No such change.') return undoEntry(store, id, at);
    throw err;
  }
}

// Undo for any history entry: a catalog artist change, or a Manage change (manage.ts).
export async function undoHistory(store: LineupStore, id: string, at = now()): Promise<UndoResult | CanonicalUndoOutcome> {
  const entry = await store.getEntityHistory(id);
  if (entry?.canonical) return undoArtistChange(store, entry, at);
  if (!entry) return undoFileCanonicalChange(store, id, at);
  return undoEntry(store, id, at);
}
