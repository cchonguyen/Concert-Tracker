// The owner's operations on the genre vocabulary (docs/specs/genre-vocabulary.md
// section 6). Each one builds the 'after' images of the genres it touches and
// makes exactly one writeGenreVocabulary call with actor 'owner'. Stored artist
// genres are never rewritten: they follow the vocabulary when read (section 4).

import { ManageError } from '../entities/manage';
import type { LineupStore, GenreVocabWriteRow } from '../lineup/store/types';
import { GENRE_MAP_SETTING, MAX_GENRE_LENGTH } from './genreTypes';
import type { ArtistGenres, GenreMapEntry, GenreVocabChange, GenreVocabOperation, GenreVocabulary, VocabGenre } from './genreTypes';
import { GENRE_NEEDS_LETTER, genreKey, genreResolver, wouldMakeUmbrellaLoop } from './genreVocabulary';
import type { GenreResolver } from './genreVocabulary';
import { planGenreVocabCsvImport } from './genreVocabCsv';
import type { GenreVocabCsvPreview, GenreVocabCsvRow } from './genreVocabCsv';

export const OWNER_GENRE_REASON = 'Changed by the owner in Manage';
export const GENRES_CHANGED_SINCE = 'Those genres changed after this. Undo the later change first.';

const mergeInstead = (name: string) => `That is already a genre: ${name}. Merge instead.`;
const loopRefusal = (name: string) => `That would put ${name} under itself.`;

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

// Sorted like the store's images, so two images compare by their JSON.
function image(g: VocabGenre): VocabGenre {
  return {
    key: g.key,
    name: g.name,
    ...(g.parent ? { parent: g.parent } : {}),
    aliases: [...g.aliases].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((a) => ({ key: a.key, alias: a.alias })),
    umbrellas: [...new Set(g.umbrellas)].sort(),
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

async function write(store: LineupStore, after: GenreVocabWriteRow[], operation: GenreVocabOperation, summary: string): Promise<GenreVocabChange> {
  return store.writeGenreVocabulary(after, { operation, actor: 'owner', reason: OWNER_GENRE_REASON, summary });
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
// genre under it follows.
export async function renameGenre(store: LineupStore, genre: unknown, newName: unknown): Promise<GenreVocabChange> {
  const ctx = await load(store);
  const g = findGenre(ctx, genre);
  const { name, key } = cleanSpelling(newName);
  if (name === g.name) throw new ManageError(`It is already called ${name}.`, 400);
  if (key === g.key) return write(store, [{ key, image: image({ ...g, name }) }], 'rename', `${g.name} renamed to ${name}`);
  const taken = holderName(ctx, key, g.key);
  if (taken !== undefined) throw new ManageError(mergeInstead(taken), 409);
  const moved = image({
    ...g,
    key,
    name,
    aliases: [...g.aliases.filter((a) => a.key !== key), { key: g.key, alias: g.name }],
  });
  const rows: GenreVocabWriteRow[] = [{ key: g.key, image: null }, { key, image: moved }];
  for (const child of ctx.vocab.genres) {
    if (child.key === g.key || !child.umbrellas.includes(g.key)) continue;
    rows.push({ key: child.key, image: image({ ...child, umbrellas: child.umbrellas.map((u) => (u === g.key ? key : u)) }) });
  }
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
  const next = image({ key: g.key, name: g.name, ...(p ? { parent: p } : {}), aliases: g.aliases, umbrellas: g.umbrellas });
  return write(store, [{ key: g.key, image: next }], 'parent', p ? `${g.name} grouped under ${p}` : `${g.name} group set back to the genre map`);
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
  const drop = findGenre(ctx, dropSpelling);
  const keep = findGenre(ctx, keepSpelling);
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

  const after: GenreVocabWriteRow[] = [];
  if (ctx.byKey.has(drop.key)) after.push({ key: drop.key, image: null });
  after.push({ key: keep.key, image: image({ ...keepImg, aliases: newAliases }) });
  for (const k of children) after.push({ key: k, image: sim.get(k)! });

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

export async function previewGenreVocabCsv(store: LineupStore, rows: GenreVocabCsvRow[]): Promise<GenreVocabCsvPreview> {
  const vocab = await store.getGenreVocabulary();
  return planGenreVocabCsvImport(rows, vocab).preview;
}

export async function applyGenreVocabCsv(
  store: LineupStore,
  rows: GenreVocabCsvRow[],
): Promise<{ preview: GenreVocabCsvPreview; change: GenreVocabChange | null }> {
  const vocab = await store.getGenreVocabulary();
  const plan = planGenreVocabCsvImport(rows, vocab);
  if (plan.preview.errors.length > 0) {
    throw new ManageError(plan.preview.errors[0], 400);
  }
  if (plan.after.length === 0) {
    return { preview: plan.preview, change: null };
  }
  const summary = `CSV upload: ${plan.preview.created} created, ${plan.preview.updated} updated`;
  const change = await store.writeGenreVocabulary(plan.after, {
    operation: 'create',
    actor: 'owner',
    reason: 'Genre vocabulary CSV upload',
    summary,
  });
  return { preview: plan.preview, change };
}
