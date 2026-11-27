// Artist orbits as a CSV (docs/specs/genre-taxonomy-release-3.md section 4). Columns: orbit_id, label,
// parent_genre, anchors, core, crossover. Lists are separated by ';'. Anchors are centrality 1.0, core 0.5,
// crossover 0.25. The file REPLACES the whole orbit set: an orbit not in the file is removed. Preview changes
// nothing; apply is one logged, undoable change through writeArtistOrbits (actor 'owner').
// Owner only: the routes refuse a member. Pure parsing and mapping; the store is read only through the functions below.

import { parseCsv } from '../../services/listImport';
import { genreUniverse } from './genreCatalog';
import { ArtistOrbitError, ORBIT_ANCHORS_MAX, ORBIT_ANCHORS_MIN, normalizeArtistOrbits, writeArtistOrbits } from './artistOrbits';
import type { ArtistOrbit, ArtistOrbitChange, OrbitCentrality } from './artistOrbits';
import { csvText, matchCsvRows, readCell, safeCell } from './genreCsv';
import type { CsvAct, GenreCsvRow } from './genreCsv';
import { genreKey, levelOf } from './genreVocabulary';
import type { LineupStore } from '../lineup/store/types';
import type { GenreVocabulary } from './genreTypes';

export const ORBIT_CSV_HEADER = ['orbit_id', 'label', 'parent_genre', 'anchors', 'core', 'crossover'] as const;
export const ORBIT_CSV_REASON = 'Orbits spreadsheet';
const CORE_CENTRALITY: OrbitCentrality = 0.5;
const CROSSOVER_CENTRALITY: OrbitCentrality = 0.25;

export interface OrbitCsvRow {
  line: number; // record number in the file; the header is 1
  orbitId: string;
  label: string;
  parentGenre: string;
  anchors: string;
  core: string;
  crossover: string;
}

export interface OrbitCsvError {
  row: number;
  message: string;
}

export interface OrbitsCsvPreview {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  errors: OrbitCsvError[];
}

export interface OrbitsCsvPlan {
  orbits: ArtistOrbit[]; // the file's orbits (only when there are no errors)
  currentIds: string[]; // every orbit now stored: what the file replaces
  preview: OrbitsCsvPreview;
}

const clean = (value: unknown): string => (typeof value === 'string' ? value : '').trim().replace(/\s+/g, ' ');

// Semicolon-separated names: trimmed, inner spaces collapsed, blanks dropped.
export function splitNames(raw: string): string[] {
  return raw
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s !== '');
}

// Reads a parsed table (header first). Columns are found by name, case-insensitively, and a leading
// byte order mark is ignored. Blank records are skipped.
export function parseArtistOrbitsCsv(table: string[][]): { rows: OrbitCsvRow[]; errors: OrbitCsvError[] } {
  if (table.length === 0) return { rows: [], errors: [{ row: 1, message: 'CSV is empty.' }] };
  const headers = table[0].map((h) => readCell(h).replace(/^﻿/, '').trim().toLowerCase());
  const missing = ORBIT_CSV_HEADER.filter((h) => !headers.includes(h));
  if (missing.length > 0) return { rows: [], errors: missing.map((h) => ({ row: 1, message: `CSV is missing the "${h}" column.` })) };
  const rows: OrbitCsvRow[] = [];
  for (let i = 1; i < table.length; i++) {
    const line = table[i];
    if (line.every((cell) => !clean(readCell(cell)))) continue;
    const cell = (h: string): string => clean(readCell(line[headers.indexOf(h)] ?? ''));
    rows.push({
      line: i + 1,
      orbitId: cell('orbit_id'),
      label: cell('label'),
      parentGenre: cell('parent_genre'),
      anchors: cell('anchors'),
      core: cell('core'),
      crossover: cell('crossover'),
    });
  }
  return { rows, errors: [] };
}

// A genre name (its own genre row, or a spelling of one) to a genre key. Families and macros are not genres.
function genreKeyOf(vocab: GenreVocabulary, name: string): string | undefined {
  const k = genreKey(name);
  if (!k) return undefined;
  const direct = vocab.genres.find((g) => g.key === k);
  if (direct) return levelOf(direct) === 'genre' ? k : undefined;
  return vocab.genres.find((g) => levelOf(g) === 'genre' && g.aliases.some((a) => a.key === k))?.key;
}

// Plans the file against the stored orbits and the acts you can give genres. Writes nothing.
export async function planArtistOrbitsCsv(store: LineupStore, rows: OrbitCsvRow[]): Promise<OrbitsCsvPlan> {
  const [universe, aliases, vocab, current] = await Promise.all([
    genreUniverse(store),
    store.getAliases(),
    store.getGenreVocabulary(),
    store.listArtistOrbits(),
  ]);
  const acts: CsvAct[] = universe.map((a) => ({ key: a.key, name: a.name, mbid: a.mbid, source: 'none', genres: [] }));
  const genreKeys = new Set(vocab.genres.map((g) => g.key));
  const currentById = new Map(current.map((o) => [o.id, o]));
  const errors: OrbitCsvError[] = [];

  // Act names, each looked up once through the same matching the genres file uses (exact name, then renames).
  const looked = new Map<string, { key?: string; reason: string }>();
  const lookUp = (name: string): { key?: string; reason: string } => {
    let hit = looked.get(name);
    if (!hit) {
      const probe: GenreCsvRow = { line: 0, name, mbid: '', newGenres: 'x', stamp: '' };
      const { matched, skipped } = matchCsvRows([probe], acts, aliases);
      hit = matched[0] ? { key: matched[0].act.key, reason: '' } : { reason: skipped[0]?.reason ?? 'no act with that name' };
      looked.set(name, hit);
    }
    return hit;
  };

  const seenIds = new Set<string>();
  const next: ArtistOrbit[] = [];
  for (const row of rows) {
    const id = row.orbitId;
    if (!id) {
      errors.push({ row: row.line, message: 'Every row needs an orbit_id.' });
      continue;
    }
    if (seenIds.has(id)) {
      errors.push({ row: row.line, message: `orbit_id ${id} is listed more than once.` });
      continue;
    }
    seenIds.add(id);
    const before = errors.length;

    const anchorNames = splitNames(row.anchors);
    if (anchorNames.length < ORBIT_ANCHORS_MIN || anchorNames.length > ORBIT_ANCHORS_MAX) {
      errors.push({ row: row.line, message: `Orbit ${id} needs ${ORBIT_ANCHORS_MIN} to ${ORBIT_ANCHORS_MAX} anchors.` });
    }

    const members: Array<{ artistKey: string; centrality: OrbitCentrality }> = [];
    const placed = new Set<string>();
    const groups: Array<[string[], OrbitCentrality, 'anchors' | 'core' | 'crossover']> = [
      [anchorNames, 1, 'anchors'],
      [splitNames(row.core), CORE_CENTRALITY, 'core'],
      [splitNames(row.crossover), CROSSOVER_CENTRALITY, 'crossover'],
    ];
    const anchorKeys: string[] = [];
    for (const [names, centrality, group] of groups) {
      for (const name of names) {
        const hit = lookUp(name);
        const key = hit.key;
        if (!key) {
          errors.push({ row: row.line, message: `${name} is not an act you can give genres (${hit.reason}).` });
          continue;
        }
        if (placed.has(key)) {
          errors.push({ row: row.line, message: `${name} is listed twice in orbit ${id}.` });
          continue;
        }
        placed.add(key);
        members.push({ artistKey: key, centrality });
        if (group === 'anchors') anchorKeys.push(key);
      }
    }

    let parentGenreKey: string | undefined;
    if (row.parentGenre) {
      parentGenreKey = genreKeyOf(vocab, row.parentGenre);
      if (!parentGenreKey) errors.push({ row: row.line, message: `${row.parentGenre} is not a genre in the vocabulary.` });
    }

    if (errors.length > before) continue;
    try {
      const [canonical] = normalizeArtistOrbits(
        [
          {
            id,
            anchorKeys,
            ...(row.label ? { workingLabel: row.label } : {}),
            ...(parentGenreKey ? { parentGenreKey } : {}),
            origin: currentById.get(id)?.origin ?? 'curated',
            members,
          },
        ],
        genreKeys,
      );
      next.push(canonical);
    } catch (err) {
      errors.push({ row: row.line, message: err instanceof Error ? err.message : String(err) });
    }
  }

  // Counts: an orbit with an error in the file is neither added, changed nor removed.
  const shape = (o: ArtistOrbit) =>
    JSON.stringify([o.anchorKeys, o.workingLabel ?? '', o.parentGenreKey ?? '', o.origin, o.members]);
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  for (const o of next) {
    const was = currentById.get(o.id);
    if (!was) added++;
    else if (shape(was) !== shape(o)) changed++;
    else unchanged++;
  }
  const fileIds = new Set([...seenIds]);
  const removed = current.filter((o) => !fileIds.has(o.id)).length;
  errors.sort((a, b) => a.row - b.row);

  return {
    orbits: errors.length === 0 ? next : [],
    currentIds: current.map((o) => o.id),
    preview: { added, removed, changed, unchanged, errors },
  };
}

// Preview: parses the uploaded text and plans it. Changes nothing.
export async function previewArtistOrbitsCsv(store: LineupStore, csv: unknown): Promise<OrbitsCsvPreview> {
  if (typeof csv !== 'string') throw new ArtistOrbitError('Send the orbits file as text: { csv }.', 400);
  const parsed = parseArtistOrbitsCsv(parseCsv(csv));
  if (parsed.errors.length > 0) return { added: 0, removed: 0, changed: 0, unchanged: 0, errors: parsed.errors };
  return (await planArtistOrbitsCsv(store, parsed.rows)).preview;
}

// Apply: refused when the preview has any error. Writes the file as the whole orbit set, logged as 'owner'.
// A file with nothing to change writes nothing and answers change null.
export async function applyArtistOrbitsCsv(
  store: LineupStore,
  csv: unknown,
): Promise<{ preview: OrbitsCsvPreview; change: ArtistOrbitChange | null }> {
  if (typeof csv !== 'string') throw new ArtistOrbitError('Send the orbits file as text: { csv }.', 400);
  const parsed = parseArtistOrbitsCsv(parseCsv(csv));
  if (parsed.errors.length > 0) throw new ArtistOrbitError(parsed.errors[0].message, 400);
  const plan = await planArtistOrbitsCsv(store, parsed.rows);
  if (plan.preview.errors.length > 0) throw new ArtistOrbitError(plan.preview.errors[0].message, 400);
  const p = plan.preview;
  if (p.added + p.removed + p.changed === 0) return { preview: p, change: null };
  const change = await writeArtistOrbits(store, plan.orbits, plan.currentIds, 'owner', ORBIT_CSV_REASON);
  return { preview: p, change };
}

// Download: the orbits as they are stored. Names come from the act records (the key when none), the genre
// names from the vocabulary.
export async function exportArtistOrbitsCsv(store: LineupStore): Promise<string> {
  const [orbits, universe, vocab] = await Promise.all([store.listArtistOrbits(), genreUniverse(store), store.getGenreVocabulary()]);
  const names = new Map(universe.map((a) => [a.key, a.name]));
  const nameOf = (key: string) => names.get(key) ?? key;
  const genreName = (key: string) => vocab.genres.find((g) => g.key === key)?.name ?? key;
  const table: string[][] = [[...ORBIT_CSV_HEADER]];
  for (const o of [...orbits].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const of = (c: OrbitCentrality) =>
      o.members
        .filter((m) => m.centrality === c)
        .map((m) => nameOf(m.artistKey))
        .join('; ');
    table.push(
      [
        o.id,
        o.workingLabel ?? '',
        o.parentGenreKey ? genreName(o.parentGenreKey) : '',
        o.anchorKeys.map(nameOf).join('; '),
        of(CORE_CENTRALITY),
        of(CROSSOVER_CENTRALITY),
      ].map(safeCell),
    );
  }
  return csvText(table);
}
