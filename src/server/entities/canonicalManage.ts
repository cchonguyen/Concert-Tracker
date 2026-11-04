import { randomUUID } from 'node:crypto';
import type { ArtistIdentity, Edition } from '../lineup/types';
import { normalizeName } from '../lineup/text';
import type { LineupStore } from '../lineup/store/types';
import { currentMember } from '../auth/requestScope';
import { ArtistAliasRow, ArtistEditionRow, CanonicalChange, Entity, HistoryEntry } from './types';
import { cleanName, ManageError, mergeEntity, renameEntity, undoEntry, UndoResult } from './manage';

// Canonical editions for the owner's Global Archive (spec Phase 1).
// Only shared facts: no personal attendance, prices, notes or companions.
// Only confirmed editions are shown to members' suggestions (owner sees both).

// The newest editions the archive loads in one request (Workers' subrequest budget).
export const CANONICAL_EDITION_LIMIT = 200;

export type EditionStatusFilter = 'all' | 'confirmed' | 'draft';

export interface CanonicalEditionSummary {
  id: string;
  key: string;
  seriesSlug: string;
  year: number;
  name: string;
  startDate: string | null;
  endDate: string | null;
  venue: string | null;
  city: string | null;
  status: Edition['status'];
  performanceCount: number;
  hasSetTimes: boolean;
}

export function summarizeEdition(e: Edition): CanonicalEditionSummary {
  return {
    id: e.id,
    key: e.key,
    seriesSlug: e.seriesSlug,
    year: e.year,
    name: e.name,
    startDate: e.startDate ?? null,
    endDate: e.endDate ?? null,
    venue: e.venue ?? null,
    city: e.city ?? null,
    status: e.status,
    performanceCount: e.performances.length,
    // Set times exist only where a source timed them (AGENTS.md): a set is timed when it has days or stages.
    hasSetTimes: e.performances.some((p) => p.days.length > 0 || p.stages.length > 0),
  };
}

// Filters and sorts the editions: newest year first, then name.
export function listCanonicalEditions(editions: Edition[], opts: { query?: string; status?: EditionStatusFilter } = {}): CanonicalEditionSummary[] {
  const status = opts.status ?? 'all';
  const q = (opts.query ?? '').trim().toLowerCase();
  return editions
    .filter((e) => status === 'all' || e.status === status)
    .filter((e) => !q || [e.name, e.seriesSlug, e.venue ?? ''].some((s) => s.toLowerCase().includes(q)))
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
  editions: Edition[];
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
  for (const e of input.editions) {
    if (e.status !== 'confirmed') continue;
    for (const p of e.performances) {
      const row = byKey.get(p.artistKey);
      if (row) row.editionsCount += 1;
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

// ---- Catalog artists as records (Global archive, GA3) ----------------------
// Edits to canonical_artists, artist_aliases and performances (the edition
// links). Never a member's logged_events or seen text. The owner's own record
// of the artist follows only through the existing entity operations (manage.ts),
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
// then the artists that are gone.
async function writeScope(store: LineupStore, current: Scope, target: Scope): Promise<void> {
  for (const c of current.artists) {
    if (c.mbid && !target.artists.some((t) => t.key === c.key && t.mbid === c.mbid)) await store.upsertArtist({ ...c, mbid: undefined });
  }
  for (const a of target.artists) await store.upsertArtist(a);
  await store.putArtistPerformances(target.performances);
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

// The owner's own artist record with this key, when there is one to follow.
async function personalArtist(store: LineupStore, key: string): Promise<Entity | undefined> {
  return (await store.listEntities()).find((e) => e.kind === 'artist' && !e.mergedIntoId && !e.nameEncrypted && e.nameNormalized === key);
}

function entryFor(operation: HistoryEntry['operation'], summary: string, key: string, change: CanonicalChange, at: string): HistoryEntry {
  return {
    id: randomUUID(),
    operation,
    summary,
    sourceEntityId: key,
    entities: { before: [], after: [] },
    touched: [],
    aliases: { before: [], after: [] },
    links: { before: [], after: [] },
    events: [],
    createdAt: at,
    canonical: change,
  };
}

// History first, then the writes: the entry holds what undo needs.
async function applyArtistChange(store: LineupStore, entry: HistoryEntry): Promise<HistoryEntry> {
  await store.putEntityHistory(entry);
  await writeScope(store, sides(entry.canonical!).before, sides(entry.canonical!).after);
  return entry;
}

export async function renameArtist(store: LineupStore, key: string, newName: unknown, at = now()): Promise<HistoryEntry> {
  const artist = await loadArtist(store, key);
  const name = cleanName(newName);
  if (name === artist.name) throw new ManageError(`It is already called "${name}".`, 400);
  const newKey = normalizeName(name);
  const aliases = await store.getAliases();
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
  const performances = await store.artistPerformances([key]);

  const mine = await personalArtist(store, key);
  let personalId: string | undefined;
  if (mine && mine.name !== name) personalId = (await renameEntity(store, mine.id, name, at)).id;

  const renamed: ArtistIdentity = { ...artist, key: newKey, name };
  const change: CanonicalChange = {
    key,
    artists: { before: [artist], after: [renamed] },
    performances: { before: performances, after: performances.map((p) => ({ ...p, artistKey: newKey })) },
    aliases: aliasDiff(aliases, next, touched),
    personalHistoryId: personalId,
  };
  const kept = newKey !== key ? ` (“${artist.name}” kept as an AKA)` : '';
  const own = personalId ? ', and your own record' : '';
  return applyArtistChange(store, entryFor('canonical-rename', `Renamed artist "${artist.name}" to "${name}"${kept}${own}`, key, change, at));
}

// Merges `sourceKey` into `targetKey`: the target keeps its name, takes the source's
// MBID when it has none (else keeps its own), and the source's name and AKAs become
// AKAs of the target. Performances move to the target; where both have an edition,
// the target's row keeps its fields and takes the source's billing and sources.
export async function mergeArtists(store: LineupStore, sourceKey: string, targetKey: string, at = now()): Promise<HistoryEntry> {
  if (sourceKey === targetKey) throw new ManageError('An artist cannot be merged into itself.', 400);
  const source = await loadArtist(store, sourceKey);
  const target = await loadArtist(store, targetKey);
  const aliases = await store.getAliases();
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

  const rows = await store.artistPerformances([sourceKey, targetKey]);
  const byEdition = new Map<string, { source?: ArtistEditionRow; target?: ArtistEditionRow }>();
  for (const r of rows) {
    const slot = byEdition.get(r.editionId) ?? {};
    if (r.artistKey === sourceKey) slot.source = r;
    else slot.target = r;
    byEdition.set(r.editionId, slot);
  }
  const after: ArtistEditionRow[] = [];
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
  const mineSource = await personalArtist(store, sourceKey);
  const mineTarget = await personalArtist(store, targetKey);
  let personalId: string | undefined;
  if (mineSource && mineTarget) personalId = (await mergeEntity(store, mineSource.id, mineTarget.id, at)).id;
  else if (mineSource && mineSource.name !== target.name) personalId = (await renameEntity(store, mineSource.id, target.name, at)).id;

  const change: CanonicalChange = {
    key: sourceKey,
    artists: { before: [source, target], after: [merged] },
    performances: { before: rows, after },
    aliases: aliasDiff(aliases, next, touched),
    personalHistoryId: personalId,
  };
  const own = personalId ? ', and your own record' : '';
  const summary = `Merged artist "${source.name}" into "${target.name}" (${plural(byEdition.size, 'edition')})${own}`;
  return applyArtistChange(store, entryFor('canonical-merge', summary, sourceKey, change, at));
}

// Adds or removes an AKA (an alias of the artist's normalized name).
async function planAka(store: LineupStore, key: string, alias: unknown, add: boolean, at: string): Promise<HistoryEntry> {
  const artist = await loadArtist(store, key);
  const raw = typeof alias === 'string' ? alias.trim() : '';
  const aka = normalizeName(raw);
  if (!aka) throw new ManageError('An AKA needs at least one letter or digit.', 400);
  const aliases = await store.getAliases();
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
  const change: CanonicalChange = {
    key,
    artists: { before: [], after: [] },
    performances: { before: [], after: [] },
    aliases: aliasDiff(aliases, next, [aka]),
  };
  const summary = `${add ? 'Added' : 'Removed'} AKA "${aka}" ${add ? 'to' : 'from'} "${artist.name}"`;
  return applyArtistChange(store, entryFor(add ? 'canonical-alias-add' : 'canonical-alias-remove', summary, key, change, at));
}

export const addArtistAka = (store: LineupStore, key: string, alias: unknown, at = now()) => planAka(store, key, alias, true, at);
export const removeArtistAka = (store: LineupStore, key: string, alias: unknown, at = now()) => planAka(store, key, alias, false, at);

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

// Undo for any history entry: a catalog artist change, or a Manage change (manage.ts).
export async function undoHistory(store: LineupStore, id: string, at = now()): Promise<UndoResult> {
  const entry = await store.getEntityHistory(id);
  if (entry?.canonical) return undoArtistChange(store, entry, at);
  return undoEntry(store, id, at);
}

