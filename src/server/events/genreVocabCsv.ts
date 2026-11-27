import type { GenreRelation, GenreTier, GenreVocabulary, VocabGenre } from './genreTypes';
import { checkTaxonomy, familyKey, genreKey, levelOf, macroKey, wouldMakeUmbrellaLoop } from './genreVocabulary';
import type { GenreVocabWriteRow } from '../lineup/store/types';

// The tree columns, set only on rows of a tree file (genre, family, macro, tier, secondary_families, other_spellings).
export type GenreVocabCsvTree = {
  family: string;
  macro: string;
  tier: string;
  secondaryFamilies: string[];
};

export type GenreVocabCsvRow = {
  genre: string;
  group: string;
  otherSpellings: string[];
  tree?: GenreVocabCsvTree;
};

export type GenreVocabCsvSkippedAlias = {
  genre: string;
  alias: string;
  reason: string;
};

export type GenreTaxonomyCount = { created: number; updated: number; unchanged: number };

export interface GenreTaxonomyPreview {
  macros: GenreTaxonomyCount;
  families: GenreTaxonomyCount;
  genres: GenreTaxonomyCount & {
    familyMoved: number;
    tierChanged: number;
    aliasesChanged: number;
    secondaryChanged: number;
  };
  aliasesAdded: number;
  aliasesSkipped: number; // spellings that are the genre's own name, so no spelling is needed
  secondaryAdded: number;
  secondaryRemoved: number;
  withoutFamily: {
    count: number;
    names: string[]; // up to 20
    checked: 'stored and vocabulary' | 'vocabulary only';
  };
}

export type GenreVocabCsvPreview = {
  created: number;
  updated: number;
  unchanged: number;
  aliasesAdded: number;
  umbrellasAdded: number;
  skippedAliases: GenreVocabCsvSkippedAlias[];
  errors: string[];
  taxonomy?: GenreTaxonomyPreview; // tree files only
};

export type GenreVocabCsvPlan = {
  after: GenreVocabWriteRow[];
  preview: GenreVocabCsvPreview;
};

// A genre that stored artist genres resolve to, for the "no family yet" list.
export type StoredGenreRef = { key: string; name: string };

const WITHOUT_FAMILY_LIMIT = 20;
const TIERS: readonly string[] = ['specific', 'umbrella_fallback'];

const clean = (value: string | undefined): string => (value ?? '').trim().replace(/\s+/g, ' ');

const normHeader = (value: string): string => clean(value).toLowerCase().replace(/[\s_-]+/g, '');

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const splitList = (value: string): string[] =>
  value
    .split(';')
    .map((s) => clean(s))
    .filter(Boolean);

const cloneGenre = (g: VocabGenre): VocabGenre => ({
  key: g.key,
  name: g.name,
  ...(g.parent ? { parent: g.parent } : {}),
  aliases: g.aliases.map((a) => ({ key: a.key, alias: a.alias })),
  umbrellas: [...g.umbrellas],
});

const sameGenre = (a: VocabGenre | undefined, b: VocabGenre | undefined): boolean => {
  if (!a || !b) return a === b;
  if (a.key !== b.key || a.name !== b.name || (a.parent ?? '') !== (b.parent ?? '')) return false;
  if (a.aliases.length !== b.aliases.length || a.umbrellas.length !== b.umbrellas.length) return false;
  const aAliases = [...a.aliases].sort((x, y) => x.key.localeCompare(y.key));
  const bAliases = [...b.aliases].sort((x, y) => x.key.localeCompare(y.key));
  if (aAliases.some((x, i) => x.key !== bAliases[i]?.key || x.alias !== bAliases[i]?.alias)) return false;
  const aUmb = [...a.umbrellas].sort();
  const bUmb = [...b.umbrellas].sort();
  return !aUmb.some((u, i) => u !== bUmb[i]);
};

// The comparable form of a vocabulary row. Equal forms mean the upload changes nothing.
function comparable(g: VocabGenre): string {
  return JSON.stringify({
    key: g.key,
    name: g.name,
    level: levelOf(g),
    parent: g.parent ?? null,
    primaryParent: g.primaryParent ?? null,
    tier: g.tier ?? null,
    aliases: g.aliases.map((a) => ({ key: a.key, alias: a.alias })).sort((x, y) => cmp(x.key, y.key)),
    umbrellas: [...new Set(g.umbrellas)].sort(),
    relations: (g.relations ?? [])
      .map((r) => ({ target: r.target, type: r.type, weight: r.weight, origin: r.origin }))
      .sort((x, y) => cmp(x.target, y.target) || cmp(x.type, y.type)),
  });
}

export function parseGenreVocabCsv(table: string[][]): { rows: GenreVocabCsvRow[]; errors: string[] } {
  if (table.length === 0) return { rows: [], errors: ['CSV is empty.'] };
  const headers = table[0].map(normHeader);
  const genreIdx = headers.indexOf('genre');
  if (genreIdx === -1) return { rows: [], errors: ['CSV is missing the "genre" column.'] };
  const groupIdx = headers.indexOf('group');
  const aliasesIdx = ['otherspellings', 'aliases', 'alias'].map((h) => headers.indexOf(h)).find((i) => i !== -1) ?? -1;
  // A file with a family column is a tree file (genre-taxonomy-phase-a.md section 5).
  const isTree = headers.includes('family');
  const familyIdx = headers.indexOf('family');
  const macroIdx = headers.indexOf('macro');
  const tierIdx = headers.indexOf('tier');
  const secondaryIdx = headers.indexOf('secondaryfamilies');

  const rows: GenreVocabCsvRow[] = [];
  const errors: string[] = [];
  for (let i = 1; i < table.length; i++) {
    const line = table[i];
    if (line.every((cell) => !clean(cell))) continue;
    const genre = clean(line[genreIdx]);
    if (!genre) {
      errors.push(`Line ${i + 1}: missing genre name.`);
      continue;
    }
    const group = groupIdx >= 0 ? clean(line[groupIdx]) : '';
    const rawAliases = aliasesIdx >= 0 ? line[aliasesIdx] ?? '' : '';
    const otherSpellings = splitList(rawAliases);
    const row: GenreVocabCsvRow = { genre, group, otherSpellings };
    if (isTree) {
      row.tree = {
        family: clean(line[familyIdx]),
        macro: macroIdx >= 0 ? clean(line[macroIdx]) : '',
        tier: tierIdx >= 0 ? clean(line[tierIdx]) : '',
        secondaryFamilies: secondaryIdx >= 0 ? splitList(line[secondaryIdx] ?? '') : [],
      };
    }
    rows.push(row);
  }
  return { rows, errors };
}

export function planGenreVocabCsvImport(rows: GenreVocabCsvRow[], current: GenreVocabulary): GenreVocabCsvPlan {
  const origByKey = new Map(current.genres.map((g) => [g.key, g]));
  const byKey = new Map<string, VocabGenre>(current.genres.map((g) => [g.key, cloneGenre(g)]));
  const aliasOwner = new Map<string, string>();
  for (const g of byKey.values()) {
    for (const a of g.aliases) aliasOwner.set(a.key, g.key);
  }

  const createdKeys = new Set<string>();
  const seenRowKeys = new Set<string>();
  const errors: string[] = [];
  const pending: Array<{ key: string; extraGroups: string[]; otherSpellings: string[] }> = [];

  for (const row of rows) {
    const name = clean(row.genre);
    const key = genreKey(name);
    if (!key) {
      errors.push(`"${row.genre}" has no letters or digits.`);
      continue;
    }
    seenRowKeys.add(key);

    const groupParts = row.group
      .split(';')
      .map((s) => clean(s))
      .filter(Boolean);
    const primaryGroup = groupParts[0];
    const extraGroups = groupParts.slice(1);

    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        key,
        name,
        ...(primaryGroup ? { parent: primaryGroup } : {}),
        aliases: [],
        umbrellas: [],
      };
      byKey.set(key, entry);
      createdKeys.add(key);
    } else {
      entry.name = name;
      if (primaryGroup) entry.parent = primaryGroup;
    }

    pending.push({ key, extraGroups, otherSpellings: row.otherSpellings });
  }

  let aliasesAdded = 0;
  let umbrellasAdded = 0;
  const skippedAliases: GenreVocabCsvSkippedAlias[] = [];
  const workingVocab = (): GenreVocabulary => ({ genres: [...byKey.values()] });

  for (const item of pending) {
    const entry = byKey.get(item.key);
    if (!entry) continue;

    for (const groupName of item.extraGroups) {
      const uKey = genreKey(groupName);
      if (!uKey || uKey === entry.key || !byKey.has(uKey)) continue;
      if (entry.umbrellas.includes(uKey)) continue;
      if (wouldMakeUmbrellaLoop(entry.key, uKey, workingVocab())) continue;
      entry.umbrellas.push(uKey);
      umbrellasAdded++;
    }

    for (const rawAlias of item.otherSpellings) {
      const alias = clean(rawAlias);
      if (!alias) continue;
      const ak = genreKey(alias);
      if (!ak || ak === entry.key) continue;
      if (byKey.has(ak)) {
        skippedAliases.push({ genre: entry.name, alias, reason: 'Matches an existing genre' });
        continue;
      }
      const owner = aliasOwner.get(ak);
      if (owner) {
        if (owner !== entry.key) {
          skippedAliases.push({ genre: entry.name, alias, reason: 'Already an alias of another genre' });
        }
        continue;
      }
      entry.aliases.push({ key: ak, alias });
      aliasOwner.set(ak, entry.key);
      aliasesAdded++;
    }
  }

  const after: GenreVocabWriteRow[] = [];
  for (const g of byKey.values()) {
    if (!sameGenre(origByKey.get(g.key), g)) {
      after.push({ key: g.key, image: g });
    }
  }
  after.sort((a, b) => a.key.localeCompare(b.key));

  const created = createdKeys.size;
  const updated = Math.max(0, after.length - created);
  const unchanged = Math.max(0, seenRowKeys.size - created - updated);

  return {
    after,
    preview: {
      created,
      updated,
      unchanged,
      aliasesAdded,
      umbrellasAdded,
      skippedAliases,
      errors,
    },
  };
}

// A tree file: every macro, family and genre row, with its level, primary parent, tier and links.
// Nothing is written here. The plan lists the rows that change and the rule breaks that refuse the file.
export function planGenreTaxonomyCsvImport(
  rows: GenreVocabCsvRow[],
  current: GenreVocabulary,
  stored?: StoredGenreRef[],
): GenreVocabCsvPlan {
  const origByKey = new Map(current.genres.map((g) => [g.key, g]));
  const errors: string[] = [];

  // Families and macros. A family sits under one macro.
  const families = new Map<string, { name: string; macro: string }>();
  const macros = new Map<string, string>();
  for (const row of rows) {
    const name = clean(row.genre);
    const family = clean(row.tree?.family);
    const macro = clean(row.tree?.macro);
    if (!family) {
      if (macro) errors.push(`${name}: a macro needs a family.`);
      continue;
    }
    if (!macro) {
      errors.push(`${name}: family ${family} has no macro.`);
      continue;
    }
    if (!genreKey(family) || !genreKey(macro)) {
      errors.push(`"${family}" or "${macro}" has no letters or digits.`);
      continue;
    }
    const fk = familyKey(family);
    const mk = macroKey(macro);
    const known = families.get(fk);
    if (known && known.macro !== mk) {
      errors.push(`${known.name} is listed under two macros: ${macros.get(known.macro) ?? known.macro} and ${macro}.`);
    } else if (!known) {
      families.set(fk, { name: family, macro: mk });
    }
    if (!macros.has(mk)) macros.set(mk, macro);
  }

  // Genres: one row per key.
  const parsed: Array<{ name: string; key: string; row: GenreVocabCsvRow }> = [];
  const fileKeys = new Set<string>();
  for (const row of rows) {
    const name = clean(row.genre);
    const key = genreKey(name);
    if (!key) {
      errors.push(`"${row.genre}" has no letters or digits.`);
      continue;
    }
    if (fileKeys.has(key)) {
      errors.push(`${name} is listed more than once.`);
      continue;
    }
    fileKeys.add(key);
    parsed.push({ name, key, row });
  }

  const aliasOwner = new Map<string, string>();
  for (const g of current.genres) for (const a of g.aliases) aliasOwner.set(a.key, g.key);

  const desiredGenres: VocabGenre[] = [];
  const reasons = new Map<string, { familyMoved: boolean; tierChanged: boolean; aliasesChanged: boolean; secondaryChanged: boolean }>();
  let aliasesAdded = 0;
  let aliasesSkipped = 0;
  let secondaryAdded = 0;
  let secondaryRemoved = 0;

  for (const { name, key, row } of parsed) {
    const orig = origByKey.get(key);
    const tree = row.tree;
    const family = clean(tree?.family);
    const tierText = clean(tree?.tier);
    if (tierText && !TIERS.includes(tierText)) {
      errors.push(`${name}: tier "${tierText}" must be specific or umbrella_fallback.`);
    }

    const secondaryKeys: string[] = [];
    for (const raw of tree?.secondaryFamilies ?? []) {
      const f = clean(raw);
      if (!f) continue;
      const sk = familyKey(f);
      if (!families.has(sk)) errors.push(`${name}: secondary family ${f} is not in the file's families.`);
      else if (!secondaryKeys.includes(sk)) secondaryKeys.push(sk);
    }

    // Spellings: the file's own, plus the ones already stored. A spelling of another genre refuses the file.
    const aliases = new Map<string, string>();
    for (const a of orig?.aliases ?? []) aliases.set(a.key, a.alias);
    let rowAliasesAdded = 0;
    for (const raw of row.otherSpellings) {
      const alias = clean(raw);
      const ak = genreKey(alias);
      if (!ak) continue;
      if (ak === key) {
        aliasesSkipped++;
        continue;
      }
      const owner = aliasOwner.get(ak);
      if (origByKey.has(ak) || fileKeys.has(ak) || (owner !== undefined && owner !== key)) {
        errors.push(`${name}: the spelling ${alias} belongs to a different genre.`);
        continue;
      }
      if (aliases.has(ak)) continue;
      aliases.set(ak, alias);
      aliasOwner.set(ak, key);
      rowAliasesAdded++;
    }
    aliasesAdded += rowAliasesAdded;

    const origSecondary = (orig?.relations ?? []).filter((r) => r.type === 'secondary_parent').map((r) => r.target);
    const addedHere = secondaryKeys.filter((k) => !origSecondary.includes(k)).length;
    const removedHere = origSecondary.filter((k) => !secondaryKeys.includes(k)).length;
    secondaryAdded += addedHere;
    secondaryRemoved += removedHere;

    const tier = (TIERS as string[]).includes(tierText) ? (tierText as GenreTier) : orig?.tier;
    const primaryParent = family ? familyKey(family) : undefined;
    const relations: GenreRelation[] = [
      ...(orig?.relations ?? []).filter((r) => r.type !== 'secondary_parent'),
      ...secondaryKeys.map((target) => ({ target, type: 'secondary_parent' as const, weight: 1, origin: 'curated' as const })),
    ];
    const image: VocabGenre = {
      key,
      name,
      level: 'genre',
      ...(orig?.parent ? { parent: orig.parent } : {}),
      ...(primaryParent ? { primaryParent } : {}),
      ...(tier ? { tier } : {}),
      aliases: [...aliases].map(([k, alias]) => ({ key: k, alias })).sort((x, y) => cmp(x.key, y.key)),
      umbrellas: [...new Set(orig?.umbrellas ?? [])].sort(),
      relations,
    };
    desiredGenres.push(image);
    reasons.set(key, {
      familyMoved: orig !== undefined && (orig.primaryParent ?? '') !== (primaryParent ?? ''),
      tierChanged: orig !== undefined && (orig.tier ?? '') !== (tier ?? ''),
      aliasesChanged: rowAliasesAdded > 0,
      secondaryChanged: addedHere + removedHere > 0,
    });
  }

  // Macros and families keep their stored spellings, umbrellas and links.
  const desiredMacros: VocabGenre[] = [...macros].map(([mk, name]) => {
    const orig = origByKey.get(mk);
    return {
      key: mk,
      name,
      level: 'macro',
      aliases: (orig?.aliases ?? []).map((a) => ({ key: a.key, alias: a.alias })),
      umbrellas: [...(orig?.umbrellas ?? [])],
      relations: [...(orig?.relations ?? [])],
    };
  });
  const desiredFamilies: VocabGenre[] = [...families].map(([fk, f]) => {
    const orig = origByKey.get(fk);
    return {
      key: fk,
      name: f.name,
      level: 'family',
      primaryParent: f.macro,
      aliases: (orig?.aliases ?? []).map((a) => ({ key: a.key, alias: a.alias })),
      umbrellas: [...(orig?.umbrellas ?? [])],
      relations: [...(orig?.relations ?? [])],
    };
  });

  const counts = {
    macros: { created: 0, updated: 0, unchanged: 0 },
    families: { created: 0, updated: 0, unchanged: 0 },
    genres: { created: 0, updated: 0, unchanged: 0, familyMoved: 0, tierChanged: 0, aliasesChanged: 0, secondaryChanged: 0 },
  };
  const after: GenreVocabWriteRow[] = [];
  const classify = (g: VocabGenre, bucket: GenreTaxonomyCount): void => {
    const orig = origByKey.get(g.key);
    if (!orig) {
      bucket.created++;
      after.push({ key: g.key, image: g });
    } else if (comparable(orig) === comparable(g)) {
      bucket.unchanged++;
    } else {
      bucket.updated++;
      after.push({ key: g.key, image: g });
    }
  };
  for (const g of desiredMacros) classify(g, counts.macros);
  for (const g of desiredFamilies) classify(g, counts.families);
  for (const g of desiredGenres) {
    const before = counts.genres.updated;
    classify(g, counts.genres);
    const r = reasons.get(g.key);
    if (r && counts.genres.updated > before) {
      if (r.familyMoved) counts.genres.familyMoved++;
      if (r.tierChanged) counts.genres.tierChanged++;
      if (r.aliasesChanged) counts.genres.aliasesChanged++;
      if (r.secondaryChanged) counts.genres.secondaryChanged++;
    }
  }
  after.sort((a, b) => cmp(a.key, b.key));

  // Every genre, family and macro as it would be after the upload. The same rules as the write are checked here.
  const finalByKey = new Map(origByKey);
  for (const g of [...desiredMacros, ...desiredFamilies, ...desiredGenres]) finalByKey.set(g.key, g);
  errors.push(...checkTaxonomy({ genres: [...finalByKey.values()] }));

  // Genres with no family after the upload, from the vocabulary and, when given, the stored artist genres.
  const aliasTarget = new Map<string, string>();
  for (const g of finalByKey.values()) for (const a of g.aliases) aliasTarget.set(a.key, g.key);
  const without = new Map<string, string>();
  const considerGenre = (key: string, name: string): void => {
    const g = finalByKey.get(key);
    if (g && levelOf(g) !== 'genre') return;
    if (g?.primaryParent) return;
    if (!without.has(key)) without.set(key, g?.name ?? name);
  };
  for (const g of finalByKey.values()) if (levelOf(g) === 'genre') considerGenre(g.key, g.name);
  for (const s of stored ?? []) {
    const key = finalByKey.has(s.key) ? s.key : (aliasTarget.get(s.key) ?? s.key);
    considerGenre(key, s.name);
  }
  const withoutNames = [...without.values()].sort((a, b) => a.localeCompare(b));

  const taxonomy: GenreTaxonomyPreview = {
    macros: counts.macros,
    families: counts.families,
    genres: counts.genres,
    aliasesAdded,
    aliasesSkipped,
    secondaryAdded,
    secondaryRemoved,
    withoutFamily: {
      count: without.size,
      names: withoutNames.slice(0, WITHOUT_FAMILY_LIMIT),
      checked: stored ? 'stored and vocabulary' : 'vocabulary only',
    },
  };

  const sumOf = (k: 'created' | 'updated' | 'unchanged'): number => counts.macros[k] + counts.families[k] + counts.genres[k];
  return {
    after,
    preview: {
      created: sumOf('created'),
      updated: sumOf('updated'),
      unchanged: sumOf('unchanged'),
      aliasesAdded,
      umbrellasAdded: 0,
      skippedAliases: [],
      errors,
      taxonomy,
    },
  };
}

// The plan for whichever file was uploaded: a tree file when any row carries the tree columns.
export function planGenreVocabUpload(
  rows: GenreVocabCsvRow[],
  current: GenreVocabulary,
  stored?: StoredGenreRef[],
): GenreVocabCsvPlan {
  return rows.some((r) => r.tree) ? planGenreTaxonomyCsvImport(rows, current, stored) : planGenreVocabCsvImport(rows, current);
}
