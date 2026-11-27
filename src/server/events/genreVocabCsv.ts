import type { GenreVocabulary, VocabGenre } from './genreTypes';
import { genreKey, wouldMakeUmbrellaLoop } from './genreVocabulary';
import type { GenreVocabWriteRow } from '../lineup/store/types';

export type GenreVocabCsvRow = {
  genre: string;
  group: string;
  otherSpellings: string[];
};

export type GenreVocabCsvSkippedAlias = {
  genre: string;
  alias: string;
  reason: string;
};

export type GenreVocabCsvPreview = {
  created: number;
  updated: number;
  unchanged: number;
  aliasesAdded: number;
  umbrellasAdded: number;
  skippedAliases: GenreVocabCsvSkippedAlias[];
  errors: string[];
};

export type GenreVocabCsvPlan = {
  after: GenreVocabWriteRow[];
  preview: GenreVocabCsvPreview;
};

const clean = (value: string | undefined): string => (value ?? '').trim().replace(/\s+/g, ' ');

const normHeader = (value: string): string => clean(value).toLowerCase().replace(/[\s_-]+/g, '');

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

export function parseGenreVocabCsv(table: string[][]): { rows: GenreVocabCsvRow[]; errors: string[] } {
  if (table.length === 0) return { rows: [], errors: ['CSV is empty.'] };
  const headers = table[0].map(normHeader);
  const genreIdx = headers.indexOf('genre');
  if (genreIdx === -1) return { rows: [], errors: ['CSV is missing the "genre" column.'] };
  const groupIdx = headers.indexOf('group');
  const aliasesIdx = ['otherspellings', 'aliases', 'alias'].map((h) => headers.indexOf(h)).find((i) => i !== -1) ?? -1;

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
    const otherSpellings = rawAliases
      .split(';')
      .map((s) => clean(s))
      .filter(Boolean);
    rows.push({ genre, group, otherSpellings });
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
