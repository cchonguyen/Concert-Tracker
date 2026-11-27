// The owner's operations on the genre vocabulary (docs/specs/genre-vocabulary.md
// section 6, docs/specs/genre-taxonomy-phase-a.md section 6). Each one builds the
// 'after' images of the rows it touches and makes exactly one writeGenreVocabulary
// call with actor 'owner'. Stored artist genres are never rewritten: they follow the
// vocabulary when read (section 4).
//
// An image always carries the taxonomy (level, primary parent, tier and outgoing
// links), so a full image written to the store never drops a genre's family or links.

import { ManageError } from '../entities/manage';
import type { LineupStore, GenreVocabWriteRow } from '../lineup/store/types';
import { GENRE_MAP_SETTING, MAX_GENRE_LENGTH } from './genreTypes';
import type {
  ArtistGenres,
  GenreLevel,
  GenreMapEntry,
  GenreRelation,
  GenreRelationType,
  GenreVocabChange,
  GenreVocabOperation,
  GenreVocabulary,
  VocabGenre,
} from './genreTypes';
import { checkTaxonomy, familyKey, GENRE_NEEDS_LETTER, genreKey, genreResolver, levelOf, macroKey, wouldMakeUmbrellaLoop } from './genreVocabulary';
import type { GenreResolver } from './genreVocabulary';
import { planGenreVocabUpload } from './genreVocabCsv';
import type { GenreVocabCsvPlan, GenreVocabCsvPreview, GenreVocabCsvRow, StoredGenreRef } from './genreVocabCsv';

export const OWNER_GENRE_REASON = 'Changed by the owner in Manage';
export const GENRES_CHANGED_SINCE = 'Those genres changed after this. Undo the later change first.';

const mergeInstead = (name: string) => `That is already a genre: ${name}. Merge instead.`;
const loopRefusal = (name: string) => `That would put ${name} under itself.`;
const NOT_MERGEABLE = "A family or macro can't be merged with a genre.";
const WEIGHT_RANGE = 'A link strength is a number above 0 and up to 1.';
const LEVEL_WORD: Record<GenreLevel, string> = { genre: 'genre', family: 'family', macro: 'macro' };
const RELATION_TYPES: readonly GenreRelationType[] = ['secondary_parent', 'adjacent', 'derived_from'];
const TYPE_NAME: Record<GenreRelationType, string> = {
  secondary_parent: 'a secondary family of',
  adjacent: 'adjacent to',
  derived_from: 'derived from',
};

interface Ctx {
  vocab: GenreVocabulary;
  byKey: Map<string, VocabGenre>;
  aliasOf: Map<string, string>; // alias key -> genre key
  resolver: GenreResolver;
  known: Set<string>; // keys that are a genre today: vocabulary, genre map or shared rows
  rows: ArtistGenres[]; // shared rows only
}

async function load(store: LineupStore): Promise<Ctx> {
  const [vocab, map, allRows] = await Promise.all([
    store.getGenreVocabulary(),
    store.getSetting<GenreMapEntry[]>(GENRE_MAP_SETTING),
    store.listArtistGenres(),
  ]);
  const rows = allRows.filter((r) => r.source !== 'added');
  const byKey = new Map(vocab.genres.map((g) => [g.key, g]));
  const aliasOf = new Map<string, string>();
  for (const g of vocab.genres) for (const a of g.aliases) aliasOf.set(a.key, g.key);
  const resolver = genreResolver(vocab, map ?? [], rows);
  const known = new Set<string>(byKey.keys());
  for (const m of map ?? []) {
    const k = genreKey(m.style);
    if (k) known.add(resolver.resolve(m.style).key);
  }
  for (const r of rows) for (const s of r.genres) if (genreKey(s.style)) known.add(resolver.resolve(s.style).key);
  return { vocab, byKey, aliasOf, resolver, known, rows };
}

const relationOrder = (a: GenreRelation, b: GenreRelation): number =>
  a.target < b.target ? -1 : a.target > b.target ? 1 : a.type < b.type ? -1 : a.type > b.type ? 1 : 0;

// Sorted like the store's images, so two images compare by their JSON.
function image(g: VocabGenre): VocabGenre {
  return {
    key: g.key,
    name: g.name,
    level: levelOf(g),
    ...(g.parent ? { parent: g.parent } : {}),
    ...(g.primaryParent ? { primaryParent: g.primaryParent } : {}),
    ...(g.tier ? { tier: g.tier } : {}),
    aliases: [...g.aliases].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((a) => ({ key: a.key, alias: a.alias })),
    umbrellas: [...new Set(g.umbrellas)].sort(),
    relations: (g.relations ?? [])
      .map((r) => ({ target: r.target, type: r.type, weight: r.weight, origin: r.origin }))
      .sort(relationOrder),
  };
}

const same = (a: VocabGenre | undefined, b: VocabGenre | undefined): boolean =>
  JSON.stringify(a ? image(a) : null) === JSON.stringify(b ? image(b) : null);

function cleanSpelling(value: unknown): { name: string; key: string } {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (name.length > MAX_GENRE_LENGTH) throw new ManageError(`A genre can be at most ${MAX_GENRE_LENGTH} characters.`, 400);
  const key = genreKey(name);
  if (!key) throw new ManageError(GENRE_NEEDS_LETTER, 400);
  return { name, key };
}

// The genre any spelling resolves to, as its vocabulary image. A genre with no
// vocabulary row gets one built from its shown spelling.
function findGenre(ctx: Ctx, spelling: unknown): VocabGenre {
  const { key } = cleanSpelling(spelling);
  const resolved = ctx.resolver.resolve(spelling as string);
  if (!ctx.known.has(resolved.key)) throw new ManageError(`No such genre: ${String(spelling).trim()}.`, 404);
  return image(ctx.byKey.get(resolved.key) ?? { key: resolved.key, name: ctx.resolver.resolve(key).name, aliases: [], umbrellas: [] });
}

// Any row: a genre by any spelling, or a family or macro by its key ('family:house').
function findRow(ctx: Ctx, input: unknown): VocabGenre {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw.includes(':') && ctx.byKey.has(raw)) return image(ctx.byKey.get(raw)!);
  return findGenre(ctx, input);
}

// A family or macro row, by its key or by its name.
function findLevelRow(ctx: Ctx, input: unknown, level: 'family' | 'macro'): VocabGenre {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new ManageError(`Pick a ${LEVEL_WORD[level]}.`, 400);
  const key = raw.includes(':') ? raw : level === 'family' ? familyKey(raw) : macroKey(raw);
  const row = ctx.byKey.get(key);
  if (!row) throw new ManageError(`No such ${LEVEL_WORD[level]}: ${raw}.`, 404);
  if (levelOf(row) !== level) throw new ManageError(`${row.name} is not a ${LEVEL_WORD[level]}.`, 400);
  return image(row);
}

function checkGroup(ctx: Ctx, parent: unknown): string | undefined {
  if (parent === null || parent === undefined || parent === '') return undefined;
  const p = typeof parent === 'string' ? parent.trim() : '';
  if (!ctx.resolver.groups.includes(p)) throw new ManageError("Pick one of the genre map's groups.", 400);
  return p;
}

// The name of whatever genre already holds this key, if any other than `self`.
function holderName(ctx: Ctx, key: string, self?: string): string | undefined {
  const genre = ctx.byKey.has(key) ? key : ctx.aliasOf.get(key) ?? (ctx.known.has(key) ? key : undefined);
  if (genre === undefined || genre === self) return undefined;
  return ctx.byKey.get(genre)?.name ?? ctx.resolver.resolve(key).name;
}

// Refuses a write that would break the taxonomy rules (checkTaxonomy). Only the
// messages about the rows being written are reported, so older data does not block an edit.
function refuseIfBroken(ctx: Ctx, rows: GenreVocabWriteRow[]): void {
  const next = new Map(ctx.vocab.genres.map((g) => [g.key, g] as const));
  for (const r of rows) {
    if (r.image) next.set(r.key, r.image);
    else next.delete(r.key);
  }
  const touched = rows.map((r) => r.key);
  const errors = checkTaxonomy({ genres: [...next.values()] }).filter((e) => touched.some((k) => e.includes(k)));
  if (errors.length > 0) throw new ManageError(errors[0], 400);
}

async function write(store: LineupStore, after: GenreVocabWriteRow[], operation: GenreVocabOperation, summary: string): Promise<GenreVocabChange> {
  return store.writeGenreVocabulary(after, { operation, actor: 'owner', reason: OWNER_GENRE_REASON, summary });
}

// Every other row whose link points at fromKey now points at toKey: umbrellas, the
// primary parent and outgoing links. Only rows that change are returned.
function linksRenamed(ctx: Ctx, fromKey: string, toKey: string): Map<string, VocabGenre> {
  const out = new Map<string, VocabGenre>();
  for (const g of ctx.vocab.genres) {
    if (g.key === fromKey) continue;
    const hit = g.umbrellas.includes(fromKey) || g.primaryParent === fromKey || (g.relations ?? []).some((r) => r.target === fromKey);
    if (!hit) continue;
    out.set(g.key, {
      ...g,
      umbrellas: g.umbrellas.map((u) => (u === fromKey ? toKey : u)),
      ...(g.primaryParent === fromKey ? { primaryParent: toKey } : {}),
      ...(g.relations ? { relations: g.relations.map((r) => (r.target === fromKey ? { ...r, target: toKey } : r)) } : {}),
    });
  }
  return out;
}

export async function createGenre(store: LineupStore, input: { name: unknown; parent?: unknown }): Promise<GenreVocabChange> {
  const ctx = await load(store);
  const { name, key } = cleanSpelling(input.name);
  const taken = holderName(ctx, key);
  if (taken !== undefined) throw new ManageError(`That is already a genre: ${taken}.`, 409);
  const parent = checkGroup(ctx, input.parent);
  const g = image({ key, name, ...(parent ? { parent } : {}), aliases: [], umbrellas: [] });
  return write(store, [{ key, image: g }], 'create', `${name} created`);
}

// The old spelling becomes an alias. A new key moves the genre's row, and every
// link to it follows. A family or macro keeps its key space and gets no alias.
export async function renameGenre(store: LineupStore, genre: unknown, newName: unknown): Promise<GenreVocabChange> {
  const ctx = await load(store);
  const g = findRow(ctx, genre);
  const level = levelOf(g);
  const { name, key: spellingKey } = cleanSpelling(newName);
  if (name === g.name) throw new ManageError(`It is already called ${name}.`, 400);
  const key = level === 'family' ? familyKey(name) : level === 'macro' ? macroKey(name) : spellingKey;
  if (key === g.key) return write(store, [{ key, image: image({ ...g, name }) }], 'rename', `${g.name} renamed to ${name}`);
  if (level === 'genre') {
    const taken = holderName(ctx, key, g.key);
    if (taken !== undefined) throw new ManageError(mergeInstead(taken), 409);
  } else if (ctx.byKey.has(key)) {
    throw new ManageError(`That is already a ${LEVEL_WORD[level]}: ${ctx.byKey.get(key)!.name}.`, 409);
  }
  const moved = image(
    level === 'genre'
      ? { ...g, key, name, aliases: [...g.aliases.filter((a) => a.key !== key), { key: g.key, alias: g.name }] }
      : { ...g, key, name, aliases: [] },
  );
  const rows: GenreVocabWriteRow[] = [{ key: g.key, image: null }, { key, image: moved }];
  for (const [k, child] of linksRenamed(ctx, g.key, key)) rows.push({ key: k, image: image(child) });
  refuseIfBroken(ctx, rows);
  return write(store, rows, 'rename', `${g.name} renamed to ${name}`);
}

export async function addGenreAlias(store: LineupStore, genre: unknown, alias: unknown): Promise<GenreVocabChange> {
  const ctx = await load(store);
  const g = findGenre(ctx, genre);
  const { name, key } = cleanSpelling(alias);
  if (key === g.key) throw new ManageError(`${name} has the same letters as ${g.name}; it is joined on its own.`, 400);
  if (g.aliases.some((a) => a.key === key)) throw new ManageError(`${name} is already a spelling of ${g.name}.`, 400);
  const taken = holderName(ctx, key, g.key);
  if (taken !== undefined) throw new ManageError(mergeInstead(taken), 409);
  const next = image({ ...g, aliases: [...g.aliases, { key, alias: name }] });
  return write(store, [{ key: g.key, image: next }], 'alias-add', `${name} added as a spelling of ${g.name}`);
}

export async function removeGenreAlias(store: LineupStore, genre: unknown, alias: unknown): Promise<GenreVocabChange> {
  const ctx = await load(store);
  const g = findGenre(ctx, genre);
  const { name, key } = cleanSpelling(alias);
  if (key === g.key) throw new ManageError(`${name} has the same letters as ${g.name}; it is joined on its own.`, 400);
  const own = g.aliases.find((a) => a.key === key);
  if (!own) {
    const taken = holderName(ctx, key, g.key);
    if (taken !== undefined && !ctx.aliasOf.has(key)) throw new ManageError(mergeInstead(taken), 409);
    throw new ManageError(`${name} is not a spelling of ${g.name}.`, 404);
  }
  const next = image({ ...g, aliases: g.aliases.filter((a) => a.key !== key) });
  return write(store, [{ key: g.key, image: next }], 'alias-remove', `${own.alias} removed as a spelling of ${g.name}`);
}

// null, undefined or '' clears the owner's group: it comes from the genre map again.
export async function setGenreParent(store: LineupStore, genre: unknown, parent: unknown): Promise<GenreVocabChange> {
  const ctx = await load(store);
  const g = findGenre(ctx, genre);
  const p = checkGroup(ctx, parent);
  if ((g.parent ?? undefined) === p) throw new ManageError('That is already its group.', 400);
  const next = image({ ...g, parent: p });
  return write(store, [{ key: g.key, image: next }], 'parent', p ? `${g.name} grouped under ${p}` : `${g.name} group set back to the genre map`);
}

// Puts a genre in a family (docs/specs/genre-taxonomy-phase-a.md section 6). Empty clears
// it: the genre is "Not grouped".
export async function setGenreFamily(store: LineupStore, genre: unknown, family: unknown): Promise<GenreVocabChange> {
  const ctx = await load(store);
  const g = findGenre(ctx, genre);
  if (levelOf(g) !== 'genre') throw new ManageError('Only a genre goes in a family.', 400);
  const blank = family === null || family === undefined || (typeof family === 'string' && family.trim() === '');
  if (blank && !g.primaryParent) throw new ManageError(`${g.name} is not grouped already.`, 400);
  const f = blank ? undefined : findLevelRow(ctx, family, 'family');
  if (f && g.primaryParent === f.key) throw new ManageError(`${g.name} is already in ${f.name}.`, 400);
  const rows: GenreVocabWriteRow[] = [{ key: g.key, image: image({ ...g, primaryParent: f?.key }) }];
  refuseIfBroken(ctx, rows);
  return write(store, rows, 'family', f ? `${g.name} put in ${f.name}` : `${g.name} set to Not grouped`);
}

export async function addGenreUmbrella(store: LineupStore, genre: unknown, umbrella: unknown): Promise<GenreVocabChange> {
  const ctx = await load(store);
  const g = findGenre(ctx, genre);
  const u = findGenre(ctx, umbrella);
  if (wouldMakeUmbrellaLoop(g.key, u.key, ctx.vocab)) throw new ManageError(loopRefusal(g.name), 400);
  if (g.umbrellas.includes(u.key)) throw new ManageError(`${g.name} is already under ${u.name}.`, 400);
  const rows: GenreVocabWriteRow[] = [{ key: g.key, image: image({ ...g, umbrellas: [...g.umbrellas, u.key] }) }];
  // The umbrella must be a vocabulary genre: one with no row gets it now.
  if (!ctx.byKey.has(u.key)) rows.push({ key: u.key, image: u });
  return write(store, rows, 'umbrella-add', `${g.name} put under ${u.name}`);
}

export async function removeGenreUmbrella(store: LineupStore, genre: unknown, umbrella: unknown): Promise<GenreVocabChange> {
  const ctx = await load(store);
  const g = findGenre(ctx, genre);
  const u = findGenre(ctx, umbrella);
  if (!g.umbrellas.includes(u.key)) throw new ManageError(`${g.name} is not under ${u.name}.`, 404);
  const next = image({ ...g, umbrellas: g.umbrellas.filter((k) => k !== u.key) });
  return write(store, [{ key: g.key, image: next }], 'umbrella-remove', `${g.name} taken out from under ${u.name}`);
}

// A collision (spec section 5): the owner picks the spelling shown for one key.
export async function pickGenreSpelling(store: LineupStore, key: unknown, spelling: unknown): Promise<GenreVocabChange> {
  const ctx = await load(store);
  const { name, key: k } = cleanSpelling(spelling);
  if (typeof key !== 'string' || genreKey(key) !== k) throw new ManageError(`${name} is not a spelling of that genre.`, 400);
  if (ctx.aliasOf.has(k)) throw new ManageError(`${name} is a spelling of ${ctx.byKey.get(ctx.aliasOf.get(k)!)!.name}.`, 400);
  if (!ctx.known.has(k)) throw new ManageError(`No such genre: ${name}.`, 404);
  const g = ctx.byKey.get(k);
  if (g?.name === name) throw new ManageError(`It is already shown as ${name}.`, 400);
  const next = image(g ? { ...g, name } : { key: k, name, aliases: [], umbrellas: [] });
  return write(store, [{ key: k, image: next }], 'spelling', `${name} chosen as the spelling of ${k}`);
}

// ---- Links (genre_relations) -------------------------------------------------

function checkType(type: unknown): GenreRelationType {
  if (typeof type !== 'string' || !RELATION_TYPES.includes(type as GenreRelationType)) {
    throw new ManageError('Pick a link type: secondary family, adjacent or derived from.', 400);
  }
  return type as GenreRelationType;
}

// A strength is a number above 0 and at most 1. A missing value takes `missing`, or is refused.
function checkWeight(value: unknown, missing?: number): number {
  if (value === undefined || value === null || value === '') {
    if (missing !== undefined) return missing;
    throw new ManageError(WEIGHT_RANGE, 400);
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0 || n > 1) throw new ManageError(WEIGHT_RANGE, 400);
  return n;
}

// The link's target: a family for a secondary family, otherwise a genre.
function findTarget(ctx: Ctx, input: unknown, type: GenreRelationType): VocabGenre {
  if (type === 'secondary_parent') return findLevelRow(ctx, input, 'family');
  const g = findGenre(ctx, input);
  if (levelOf(g) !== 'genre') throw new ManageError(`${g.name} is not a genre, so it cannot be linked this way.`, 400);
  return g;
}

// The source of a link is always a genre.
function sourceGenre(ctx: Ctx, source: unknown): VocabGenre {
  const g = findGenre(ctx, source);
  if (levelOf(g) !== 'genre') throw new ManageError('Only a genre can have links.', 400);
  return g;
}

function linkOf(g: VocabGenre, targetKey: string, type: GenreRelationType): GenreRelation | undefined {
  return (g.relations ?? []).find((r) => r.target === targetKey && r.type === type);
}

// True when `from` reaches `to` by links of one type.
function reaches(ctx: Ctx, from: string, to: string, type: GenreRelationType): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const k = stack.pop()!;
    if (k === to) return true;
    if (seen.has(k)) continue;
    seen.add(k);
    for (const r of ctx.byKey.get(k)?.relations ?? []) if (r.type === type) stack.push(r.target);
  }
  return false;
}

// The owner's link. A link of another origin to the same target is replaced by it.
export async function addGenreRelation(
  store: LineupStore,
  source: unknown,
  target: unknown,
  type: unknown,
  weight?: unknown,
): Promise<GenreVocabChange> {
  const ctx = await load(store);
  const kind = checkType(type);
  const w = checkWeight(weight, 1);
  const src = sourceGenre(ctx, source);
  const tgt = findTarget(ctx, target, kind);
  if (tgt.key === src.key) throw new ManageError(`${src.name} cannot link to itself.`, 400);
  if (kind === 'secondary_parent' && src.primaryParent === tgt.key) throw new ManageError(`${tgt.name} is already its family.`, 400);
  const existing = linkOf(src, tgt.key, kind);
  if (existing?.origin === 'curated') throw new ManageError(`${src.name} is already ${TYPE_NAME[kind]} ${tgt.name}.`, 409);
  if (kind === 'adjacent' && (ctx.byKey.get(tgt.key)?.relations ?? []).some((r) => r.type === 'adjacent' && r.target === src.key)) {
    throw new ManageError(`${tgt.name} and ${src.name} are already adjacent. An adjacent pair is stored once.`, 409);
  }
  if (kind === 'derived_from' && reaches(ctx, tgt.key, src.key, 'derived_from')) throw new ManageError(loopRefusal(src.name), 400);
  const link: GenreRelation = { target: tgt.key, type: kind, weight: w, origin: 'curated' };
  const next = [...(src.relations ?? []).filter((r) => !(r.target === tgt.key && r.type === kind)), link];
  const rows: GenreVocabWriteRow[] = [{ key: src.key, image: image({ ...src, relations: next }) }];
  refuseIfBroken(ctx, rows);
  return write(store, rows, 'relation-add', `${src.name} linked as ${TYPE_NAME[kind]} ${tgt.name} (${w})`);
}

export async function removeGenreRelation(store: LineupStore, source: unknown, target: unknown, type: unknown): Promise<GenreVocabChange> {
  const ctx = await load(store);
  const kind = checkType(type);
  const src = sourceGenre(ctx, source);
  const tgt = findTarget(ctx, target, kind);
  if (!linkOf(src, tgt.key, kind)) throw new ManageError(`${src.name} has no link to ${tgt.name} of that kind.`, 404);
  const next = (src.relations ?? []).filter((r) => !(r.target === tgt.key && r.type === kind));
  return write(store, [{ key: src.key, image: image({ ...src, relations: next }) }], 'relation-remove', `${src.name} unlinked from ${tgt.name} (${TYPE_NAME[kind]})`);
}

// Changing a strength makes the link the owner's ('curated').
export async function setGenreRelationWeight(
  store: LineupStore,
  source: unknown,
  target: unknown,
  type: unknown,
  weight: unknown,
): Promise<GenreVocabChange> {
  const ctx = await load(store);
  const kind = checkType(type);
  const w = checkWeight(weight);
  const src = sourceGenre(ctx, source);
  const tgt = findTarget(ctx, target, kind);
  const old = linkOf(src, tgt.key, kind);
  if (!old) throw new ManageError(`${src.name} has no link to ${tgt.name} of that kind.`, 404);
  if (old.weight === w && old.origin === 'curated') throw new ManageError('That is already its strength.', 400);
  const next = (src.relations ?? []).map((r) =>
    r.target === tgt.key && r.type === kind ? { ...r, weight: w, origin: 'curated' as const } : r,
  );
  const rows: GenreVocabWriteRow[] = [{ key: src.key, image: image({ ...src, relations: next }) }];
  return write(store, rows, 'relation-weight', `${src.name} to ${tgt.name} (${TYPE_NAME[kind]}) set to ${w}`);
}

// ---- Preview and merge -------------------------------------------------------

export interface GenreLinkPreview {
  genreKey: string;
  genre: string;
  umbrellaKey: string;
  umbrella: string;
}

export interface GenreMergePlan {
  drop: { key: string; name: string };
  keep: { key: string; name: string };
  artists: number; // shared rows (one per artist) with a style that resolves to the dropped genre
  aliases: string[]; // spellings that become aliases of the kept genre
  umbrellasMoved: GenreLinkPreview[]; // links that now go from or to the kept genre
  umbrellasDropped: GenreLinkPreview[]; // links that would point at itself or make a loop
  after: GenreVocabWriteRow[];
  summary: string;
}

function buildMerge(ctx: Ctx, dropSpelling: unknown, keepSpelling: unknown): GenreMergePlan {
  const drop = findRow(ctx, dropSpelling);
  const keep = findRow(ctx, keepSpelling);
  if (levelOf(drop) !== 'genre' || levelOf(keep) !== 'genre') throw new ManageError(NOT_MERGEABLE, 400);
  if (drop.key === keep.key) throw new ManageError('Cannot merge a genre into itself.', 400);
  const nameOf = (k: string) => (k === drop.key ? drop.name : k === keep.key ? keep.name : ctx.byKey.get(k)?.name ?? ctx.resolver.resolve(k).name);
  const link = (g: string, u: string): GenreLinkPreview => ({ genreKey: g, genre: nameOf(g), umbrellaKey: u, umbrella: nameOf(u) });

  const artists = new Set<string>();
  for (const r of ctx.rows) if (r.genres.some((s) => genreKey(s.style) && ctx.resolver.resolve(s.style).key === drop.key)) artists.add(r.key);

  const newAliases = [...keep.aliases];
  const aliases: string[] = [];
  for (const a of [{ key: drop.key, alias: drop.name }, ...drop.aliases]) {
    if (a.key === keep.key || newAliases.some((x) => x.key === a.key)) continue;
    newAliases.push(a);
    aliases.push(a.alias);
  }

  // Simulated vocabulary: the dropped genre gone, and every link to it removed.
  const sim = new Map<string, VocabGenre>();
  for (const g of ctx.vocab.genres) if (g.key !== drop.key) sim.set(g.key, image({ ...g, umbrellas: g.umbrellas.filter((u) => u !== drop.key) }));
  const keepImg = sim.get(keep.key) ?? image({ ...keep, umbrellas: keep.umbrellas.filter((u) => u !== drop.key) });
  sim.set(keep.key, keepImg);
  const simVocab = (): GenreVocabulary => ({ genres: [...sim.values()] });

  const moved: GenreLinkPreview[] = [];
  const dropped: GenreLinkPreview[] = [];
  if (keep.umbrellas.includes(drop.key)) dropped.push(link(keep.key, drop.key));
  // The dropped genre's umbrellas move to the kept one.
  for (const u of drop.umbrellas) {
    if (keepImg.umbrellas.includes(u)) continue;
    if (u === keep.key || wouldMakeUmbrellaLoop(keep.key, u, simVocab())) {
      dropped.push(link(drop.key, u));
      continue;
    }
    keepImg.umbrellas = [...keepImg.umbrellas, u].sort();
    moved.push(link(keep.key, u));
  }
  // The genres under the dropped one move under the kept one.
  const children: string[] = [];
  for (const child of ctx.vocab.genres) {
    if (child.key === drop.key || child.key === keep.key || !child.umbrellas.includes(drop.key)) continue;
    children.push(child.key);
    const c = sim.get(child.key)!;
    if (c.umbrellas.includes(keep.key)) continue;
    if (wouldMakeUmbrellaLoop(child.key, keep.key, simVocab())) {
      dropped.push(link(child.key, drop.key));
      continue;
    }
    c.umbrellas = [...c.umbrellas, keep.key].sort();
    moved.push(link(child.key, keep.key));
  }

  // Links from other genres to the dropped one point at the kept one, unless that would
  // repeat a link they already have, link the kept genre to itself, or make an adjacent pair twice.
  const relinked = new Set<string>();
  for (const g of ctx.vocab.genres) {
    if (g.key === drop.key || !(g.relations ?? []).some((r) => r.target === drop.key)) continue;
    const c = sim.get(g.key)!;
    const current = c.relations ?? [];
    const next = current.filter((r) => r.target !== drop.key);
    for (const r of current) {
      if (r.target !== drop.key) continue;
      const repeats =
        g.key === keep.key ||
        next.some((x) => x.target === keep.key && x.type === r.type) ||
        (r.type === 'adjacent' && (keepImg.relations ?? []).some((x) => x.type === 'adjacent' && x.target === g.key));
      if (!repeats) next.push({ ...r, target: keep.key });
    }
    c.relations = next;
    relinked.add(g.key);
  }

  const after: GenreVocabWriteRow[] = [];
  if (ctx.byKey.has(drop.key)) after.push({ key: drop.key, image: null });
  after.push({ key: keep.key, image: image({ ...keepImg, aliases: newAliases }) });
  const others = new Set<string>([...children, ...relinked]);
  others.delete(keep.key);
  for (const k of others) after.push({ key: k, image: image(sim.get(k)!) });
  refuseIfBroken(ctx, after);

  return {
    drop: { key: drop.key, name: drop.name },
    keep: { key: keep.key, name: keep.name },
    artists: artists.size,
    aliases,
    umbrellasMoved: moved,
    umbrellasDropped: dropped,
    after,
    summary: `${drop.name} merged into ${keep.name}`,
  };
}

// The preview: nothing is written.
export async function planGenreMerge(store: LineupStore, drop: unknown, keep: unknown): Promise<GenreMergePlan> {
  return buildMerge(await load(store), drop, keep);
}

// The dropped genre's spelling and aliases become aliases of the kept one; its
// umbrellas and the genres under it move to the kept one; the kept genre keeps its group.
export async function mergeGenres(store: LineupStore, drop: unknown, keep: unknown): Promise<{ plan: GenreMergePlan; change: GenreVocabChange }> {
  const plan = buildMerge(await load(store), drop, keep);
  const change = await write(store, plan.after, 'merge', plan.summary);
  return { plan, change };
}

// Undo of one vocabulary change (named apart from undoGenreChange in genres.ts,
// which undoes an artist's genres). Refused when any genre it touched no longer
// equals the change's 'after' image, or when a genre it would remove is now an
// umbrella of a genre the change did not touch.
export async function undoGenreVocabChange(store: LineupStore, id: string, at: Date = new Date()): Promise<GenreVocabChange> {
  const change = (await store.listGenreVocabChanges({ id }))[0];
  if (!change) throw new ManageError('No such genre change.', 404);
  if (change.undoneAt) throw new ManageError('That change was already undone.', 409);
  const vocab = await store.getGenreVocabulary();
  const current = new Map(vocab.genres.map((g) => [g.key, g]));
  const before = new Map(change.before.map((g) => [g.key, g]));
  const after = new Map(change.after.map((g) => [g.key, g]));
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const k of keys) if (!same(current.get(k), after.get(k))) throw new ManageError(GENRES_CHANGED_SINCE, 409);
  const removed = new Set(keys.filter((k) => !before.has(k)));
  for (const g of vocab.genres) {
    if (keys.includes(g.key)) continue;
    if (g.umbrellas.some((u) => removed.has(u))) throw new ManageError(GENRES_CHANGED_SINCE, 409);
  }
  const rows: GenreVocabWriteRow[] = keys.map((k) => ({ key: k, image: before.get(k) ?? null }));
  const undo = await store.writeGenreVocabulary(rows, { operation: 'undo', actor: 'owner', reason: OWNER_GENRE_REASON, summary: `Undo: ${change.summary}` });
  await store.markGenreVocabChangesUndone([change.id], at.toISOString());
  return undo;
}

// The genres the shared artist rows resolve to, for a tree upload's "no family yet" list.
function storedGenreRefs(ctx: Ctx): StoredGenreRef[] {
  const seen = new Map<string, string>();
  for (const r of ctx.rows) {
    for (const s of r.genres) {
      if (!genreKey(s.style)) continue;
      const resolved = ctx.resolver.resolve(s.style);
      if (!seen.has(resolved.key)) seen.set(resolved.key, resolved.name);
    }
  }
  return [...seen].map(([key, name]) => ({ key, name }));
}

async function planVocabUpload(store: LineupStore, rows: GenreVocabCsvRow[]): Promise<GenreVocabCsvPlan> {
  const ctx = await load(store);
  return planGenreVocabUpload(rows, ctx.vocab, storedGenreRefs(ctx));
}

export async function previewGenreVocabCsv(store: LineupStore, rows: GenreVocabCsvRow[]): Promise<GenreVocabCsvPreview> {
  return (await planVocabUpload(store, rows)).preview;
}

export async function applyGenreVocabCsv(
  store: LineupStore,
  rows: GenreVocabCsvRow[],
): Promise<{ preview: GenreVocabCsvPreview; change: GenreVocabChange | null }> {
  const plan = await planVocabUpload(store, rows);
  if (plan.preview.errors.length > 0) {
    throw new ManageError(plan.preview.errors[0], 400);
  }
  if (plan.after.length === 0) {
    return { preview: plan.preview, change: null };
  }
  // A tree upload is one logged change. Its images are full (level, primary parent, tier, links) and are not passed through image().
  const tree = rows.some((r) => r.tree);
  const summary = tree
    ? `Genre tree CSV upload: ${plan.preview.created} created, ${plan.preview.updated} updated`
    : `CSV upload: ${plan.preview.created} created, ${plan.preview.updated} updated`;
  const change = await store.writeGenreVocabulary(plan.after, {
    operation: tree ? 'taxonomy-import' : 'create',
    actor: 'owner',
    reason: tree ? 'Genre tree CSV upload' : 'Genre vocabulary CSV upload',
    summary,
  });
  return { preview: plan.preview, change };
}
