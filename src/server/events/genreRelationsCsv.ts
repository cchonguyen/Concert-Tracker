// The genre links file (docs/specs/genre-taxonomy-phase-a.md section 5): source, target, type, weight, origin.
// The file replaces every stored link of each (type, origin) pair it contains, across all genres; pairs it does
// not contain stay as they are. Planning writes nothing. Apply is one logged 'relations-import' change.

import { ManageError } from '../entities/manage';
import type { LineupStore, GenreVocabWriteRow } from '../lineup/store/types';
import type { GenreRelation, GenreRelationOrigin, GenreRelationType, GenreVocabChange, GenreVocabulary, VocabGenre } from './genreTypes';
import { checkTaxonomy, familyKey, genreKey, levelOf } from './genreVocabulary';

export type GenreRelationsCsvRow = {
  line?: number;
  source: string;
  target: string;
  type: string;
  weight: string;
  origin: string;
};

export interface GenreRelationPairCount {
  type: GenreRelationType;
  origin: GenreRelationOrigin;
  added: number;
  removed: number;
  weightChanged: number;
  unchanged: number;
}

export interface GenreRelationsCsvPreview {
  pairs: GenreRelationPairCount[]; // one per (type, origin) the file contains
  added: number;
  removed: number;
  weightChanged: number;
  unchanged: number;
  genresTouched: number;
  errors: string[];
}

export type GenreRelationsCsvPlan = { after: GenreVocabWriteRow[]; preview: GenreRelationsCsvPreview };

const HEADERS = ['source', 'target', 'type', 'weight', 'origin'];
const TYPES: readonly string[] = ['secondary_parent', 'adjacent', 'derived_from'];
const UPLOAD_ORIGINS: readonly string[] = ['curated', 'artist_cooccur'];

const clean = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '').trim().replace(/\s+/g, ' ');

const cmpText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const relationOrder = (a: GenreRelation, b: GenreRelation): number => cmpText(a.target, b.target) || cmpText(a.type, b.type);
const relationForm = (r: GenreRelation) => [r.target, r.type, r.weight, r.origin];
const pairKey = (type: string, origin: string): string => `${type}\u0000${origin}`;
const linkKey = (source: string, target: string, type: string): string => `${source}\u0000${target}\u0000${type}`;

export function sameRelations(a: GenreRelation[], b: GenreRelation[]): boolean {
  return JSON.stringify([...a].sort(relationOrder).map(relationForm)) === JSON.stringify([...b].sort(relationOrder).map(relationForm));
}

// The full image of a genre with its links replaced (level, group, family, tier and spellings included).
export function imageWith(g: VocabGenre, relations: GenreRelation[]): VocabGenre {
  return {
    key: g.key,
    name: g.name,
    level: levelOf(g),
    ...(g.parent ? { parent: g.parent } : {}),
    ...(g.primaryParent ? { primaryParent: g.primaryParent } : {}),
    ...(g.tier ? { tier: g.tier } : {}),
    aliases: g.aliases.map((a) => ({ key: a.key, alias: a.alias })),
    umbrellas: [...g.umbrellas],
    relations: [...relations].sort(relationOrder),
  };
}

export function parseGenreRelationsCsv(table: string[][]): { rows: GenreRelationsCsvRow[]; errors: string[] } {
  if (table.length === 0) return { rows: [], errors: ['CSV is empty.'] };
  const headers = table[0].map((h) => clean(h).toLowerCase().replace(/[\s_-]+/g, ''));
  const missing = HEADERS.filter((h) => !headers.includes(h));
  if (missing.length > 0) return { rows: [], errors: missing.map((h) => `CSV is missing the "${h}" column.`) };
  const rows: GenreRelationsCsvRow[] = [];
  const errors: string[] = [];
  for (let i = 1; i < table.length; i++) {
    const line = table[i];
    if (line.every((cell) => !clean(cell))) continue;
    const cell = (h: string): string => clean(line[headers.indexOf(h)]);
    const row: GenreRelationsCsvRow = {
      line: i + 1,
      source: cell('source'),
      target: cell('target'),
      type: cell('type'),
      weight: cell('weight'),
      origin: cell('origin'),
    };
    if (!row.source || !row.target) {
      errors.push(`Line ${i + 1}: missing source or target.`);
      continue;
    }
    rows.push(row);
  }
  return { rows, errors };
}

export function planGenreRelationsCsvImport(rows: GenreRelationsCsvRow[], current: GenreVocabulary): GenreRelationsCsvPlan {
  const errors: string[] = [];
  const byKey = new Map(current.genres.map((g) => [g.key, g]));
  const aliasOf = new Map<string, string>();
  for (const g of current.genres) {
    if (levelOf(g) !== 'genre') continue;
    for (const a of g.aliases) if (!byKey.has(a.key)) aliasOf.set(a.key, g.key);
  }
  // A genre name: its own genre row, else a spelling of one. Only genre rows take links.
  const genreOf = (name: string): string | undefined => {
    const k = genreKey(name);
    if (!k) return undefined;
    const direct = byKey.get(k);
    if (direct) return levelOf(direct) === 'genre' ? k : undefined;
    return aliasOf.get(k);
  };
  const notInVocabulary = (name: string): string => `${name} is not a genre in the vocabulary. Upload the genre tree first.`;

  interface Link {
    source: string;
    target: string;
    type: GenreRelationType;
    origin: GenreRelationOrigin;
    weight: number;
    label: string;
  }
  const links: Link[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const where = row.line !== undefined ? `Line ${row.line}: ` : '';
    const sourceName = clean(row.source);
    const targetName = clean(row.target);
    const type = clean(row.type);
    const origin = clean(row.origin);
    const weightText = clean(row.weight);

    const source = genreOf(sourceName);
    if (!source) {
      errors.push(`${where}${notInVocabulary(sourceName)}`);
      continue;
    }
    if (!TYPES.includes(type)) {
      errors.push(`${where}type "${type}" must be secondary_parent, adjacent or derived_from.`);
      continue;
    }
    if (origin === 'lineup_cooccur') {
      errors.push(`${where}origin lineup_cooccur is reserved for the system job. Use curated or artist_cooccur.`);
      continue;
    }
    if (!UPLOAD_ORIGINS.includes(origin)) {
      errors.push(`${where}origin "${origin}" must be curated or artist_cooccur.`);
      continue;
    }
    const weight = weightText === '' ? NaN : Number(weightText);
    if (!(weight > 0 && weight <= 1)) {
      errors.push(`${where}weight "${weightText}" must be a number above 0 and at most 1.`);
      continue;
    }
    let target: string | undefined;
    if (type === 'secondary_parent') {
      const fk = familyKey(targetName);
      const family = byKey.get(fk);
      if (!family || levelOf(family) !== 'family') {
        errors.push(`${where}${targetName} is not a family in the vocabulary. Upload the genre tree first.`);
        continue;
      }
      target = fk;
    } else {
      target = genreOf(targetName);
      if (!target) {
        errors.push(`${where}${notInVocabulary(targetName)}`);
        continue;
      }
    }
    if (target === source) {
      errors.push(`${where}${sourceName} cannot link to itself.`);
      continue;
    }
    const k = linkKey(source, target, type);
    if (seen.has(k)) {
      errors.push(`${where}${sourceName} to ${targetName} (${type}) is listed more than once.`);
      continue;
    }
    seen.add(k);
    links.push({ source, target, type: type as GenreRelationType, origin: origin as GenreRelationOrigin, weight, label: `${sourceName} to ${targetName}` });
  }

  // Adjacent pairs are one row, in one direction.
  const adjacentSeen = new Set<string>();
  for (const l of links) {
    if (l.type !== 'adjacent') continue;
    if (adjacentSeen.has(`${l.target}\u0000${l.source}`)) {
      errors.push(`${l.source} and ${l.target} are listed as adjacent in both directions. List the pair once.`);
    }
    adjacentSeen.add(`${l.source}\u0000${l.target}`);
  }

  // What the file replaces: every stored link of a (type, origin) pair the file contains.
  const replaced = new Set(links.map((l) => pairKey(l.type, l.origin)));
  const stored = current.genres.flatMap((g) => (g.relations ?? []).map((r) => ({ source: g.key, ...r })));
  const kept = stored.filter((s) => !replaced.has(pairKey(s.type, s.origin)));
  const keptLinks = new Set(kept.map((s) => linkKey(s.source, s.target, s.type)));
  for (const l of links) {
    if (keptLinks.has(linkKey(l.source, l.target, l.type))) {
      errors.push(`${l.label} (${l.type}) is already stored with an origin this file does not replace.`);
    }
  }

  // Each genre's links after the upload; a genre whose links change gets a full image.
  const fileLinksBySource = new Map<string, GenreRelation[]>();
  for (const l of links) {
    const list = fileLinksBySource.get(l.source) ?? [];
    list.push({ target: l.target, type: l.type, weight: l.weight, origin: l.origin });
    fileLinksBySource.set(l.source, list);
  }
  const after: GenreVocabWriteRow[] = [];
  const finalGenres: VocabGenre[] = [];
  for (const g of current.genres) {
    const stored = g.relations ?? [];
    const next = [...stored.filter((r) => !replaced.has(pairKey(r.type, r.origin))), ...(fileLinksBySource.get(g.key) ?? [])];
    if (sameRelations(stored, next)) {
      finalGenres.push(g);
      continue;
    }
    const image = imageWith(g, next);
    after.push({ key: g.key, image });
    finalGenres.push(image);
  }
  after.sort((a, b) => cmpText(a.key, b.key));

  // Counts per (type, origin) the file contains: stored links of that pair against the file's.
  const pairs: GenreRelationPairCount[] = [...new Set(links.map((l) => pairKey(l.type, l.origin)))].sort().map((pk) => {
    const [type, origin] = pk.split('\u0000') as [GenreRelationType, GenreRelationOrigin];
    const before = new Map<string, number>();
    for (const s of stored) if (s.type === type && s.origin === origin) before.set(linkKey(s.source, s.target, s.type), s.weight);
    const file = new Map<string, number>();
    for (const l of links) if (l.type === type && l.origin === origin) file.set(linkKey(l.source, l.target, l.type), l.weight);
    const count: GenreRelationPairCount = { type, origin, added: 0, removed: 0, weightChanged: 0, unchanged: 0 };
    for (const [k, weight] of file) {
      if (!before.has(k)) count.added++;
      else if (before.get(k) !== weight) count.weightChanged++;
      else count.unchanged++;
    }
    for (const k of before.keys()) if (!file.has(k)) count.removed++;
    return count;
  });

  errors.push(...checkTaxonomy({ genres: finalGenres }));

  const sum = (k: 'added' | 'removed' | 'weightChanged' | 'unchanged'): number => pairs.reduce((n, p) => n + p[k], 0);
  return {
    after,
    preview: {
      pairs,
      added: sum('added'),
      removed: sum('removed'),
      weightChanged: sum('weightChanged'),
      unchanged: sum('unchanged'),
      genresTouched: after.length,
      errors,
    },
  };
}

export async function previewGenreRelationsCsv(store: LineupStore, rows: GenreRelationsCsvRow[]): Promise<GenreRelationsCsvPreview> {
  return planGenreRelationsCsvImport(rows, await store.getGenreVocabulary()).preview;
}

export async function applyGenreRelationsCsv(
  store: LineupStore,
  rows: GenreRelationsCsvRow[],
): Promise<{ preview: GenreRelationsCsvPreview; change: GenreVocabChange | null }> {
  const plan = planGenreRelationsCsvImport(rows, await store.getGenreVocabulary());
  if (plan.preview.errors.length > 0) throw new ManageError(plan.preview.errors[0], 400);
  if (plan.after.length === 0) return { preview: plan.preview, change: null };
  const p = plan.preview;
  const change = await store.writeGenreVocabulary(plan.after, {
    operation: 'relations-import',
    actor: 'owner',
    reason: 'Genre links CSV upload',
    summary: `Genre links CSV upload: ${p.added} added, ${p.removed} removed, ${p.weightChanged} weight changed across ${p.genresTouched} genres`,
  });
  return { preview: p, change };
}
