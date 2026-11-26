// Artist genres as a CSV: pure rules only (no DB, network or model). Shared by
// the server and, later, the browser, so no server-only imports here.
// Spec: docs/specs/genres-csv.md.

import { canonicalName } from '../lineup/merge';
import { normalizeName } from '../lineup/text';
import { GENRE_NEEDS_LETTER, genreKey, genreResolver } from './genreVocabulary';
import type { GenreResolver } from './genreVocabulary';
import { MAX_GENRE_LENGTH, MAX_OWN_GENRES } from './genreTypes';
import type { GenreSource, KnownGenre } from './genreTypes';

export const GENRE_CSV_HEADER = [
  'Artist',
  'MusicBrainz ID',
  'Current genres',
  'Source',
  'New genres',
  'Version (leave as it is)',
] as const;

// Most rows with a filled "New genres" cell one upload may carry.
export const MAX_CSV_ROWS = 5000;

// What the app shows for an act: its own genres ('you'), music-story,
// MusicBrainz, or nothing.
export type ShownSource = GenreSource | 'none';

export interface ShownGenre {
  style: string;
  weight: number;
}

export interface CsvAct {
  key: string;
  name: string;
  mbid?: string;
  source: ShownSource;
  genres: ShownGenre[];
}

export interface GenreCsvRow {
  line: number; // record number in the file; the header is 1
  name: string;
  mbid: string;
  newGenres: string;
  stamp: string;
}

export interface SkippedRow {
  line: number;
  name: string;
  reason: string;
}

export interface MatchedRow {
  row: GenreCsvRow;
  act: CsvAct;
}

export interface AfterGenre {
  style: string; // the spelling that is stored (resolved through the vocabulary)
  parent: string;
  isNew: boolean;
  typed?: string; // what the file said, only when it differs from `style`
}

export interface GenreChange {
  line: number;
  key: string;
  name: string;
  mbid: string;
  before: string[];
  beforeSource: ShownSource;
  after: AfterGenre[];
  stale: boolean; // the act changed in the app after the file was downloaded
  sameAsNow: boolean; // your genres already are exactly these
}

const SOURCE_LABEL: Record<ShownSource, string> = {
  you: 'owner',
  owner: 'owner',
  added: 'owner',
  'music-story': 'music-story',
  musicbrainz: 'MusicBrainz',
  none: 'none',
};

// FNV-1a, 32 bit, as 8 lower-case hex characters.
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const stampToken = (source: ShownSource) => (source === 'owner' ? 'you' : source);

// A hash of the genres as shown (already resolved), not a timestamp. It hashes
// each genre's loose-match key, so choosing another spelling for the same genre
// does not make a downloaded row stale, while an alias or merge that turns a
// genre into a different one does. Nothing shown is always "none|". The owner's
// genres hash the same under `you` (legacy) and `owner`.
export function genreStamp(source: ShownSource, styles: string[]): string {
  if (styles.length === 0) return fnv1a('none|');
  const keys = [...new Set(styles.map(genreKey))].sort();
  return fnv1a(`${stampToken(source)}|${keys.join(';')}`);
}

// The stamp files carried before it hashed keys: lower-cased spellings. Still
// accepted, over the same resolved genres, so a file downloaded before the change
// is not stale only because of it.
export function legacyGenreStamp(source: ShownSource, styles: string[]): string {
  if (styles.length === 0) return fnv1a('none|');
  const sorted = styles.map((s) => s.toLowerCase()).sort();
  return fnv1a(`${stampToken(source)}|${sorted.join(';')}`);
}

// Spreadsheet formula safety: a cell starting with = + - or @ gets a leading
// apostrophe on export, and that one apostrophe is removed on read.
// A value that already starts with apostrophes then a formula character gets
// one more, so the read step can always undo it exactly.
export function safeCell(value: string): string {
  return /^'*[=+\-@]/.test(value) ? `'${value}` : value;
}
export function readCell(value: string): string {
  const v = value ?? '';
  return /^'+[=+\-@]/.test(v) ? v.slice(1) : v;
}

function shownStyles(act: CsvAct): string[] {
  return [...act.genres].sort((a, b) => b.weight - a.weight).map((g) => g.style);
}

// Export table: header first, then one row per act (once per key). The
// "New genres" cell is always blank.
export function exportTable(acts: CsvAct[]): string[][] {
  const seen = new Set<string>();
  const table: string[][] = [[...GENRE_CSV_HEADER]];
  for (const act of acts) {
    if (seen.has(act.key)) continue;
    seen.add(act.key);
    const styles = shownStyles(act);
    const source: ShownSource = styles.length ? act.source : 'none';
    table.push(
      [
        act.name,
        act.mbid ?? '',
        styles.join('; '),
        SOURCE_LABEL[source],
        '',
        genreStamp(source, styles),
      ].map(safeCell),
    );
  }
  return table;
}

// UTF-8 byte order mark, CRLF line ends, and quotes only where RFC 4180 needs them.
export function csvText(table: string[][]): string {
  const line = (cells: string[]) =>
    cells.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',');
  return `﻿${table.map(line).join('\r\n')}\r\n`;
}

export type ReadRowsResult = { ok: true; rows: GenreCsvRow[] } | { ok: false; error: string };

// Reads a parsed table (rows of cells, header first). Columns are found by
// name, case-insensitively. Only rows with a filled "New genres" cell are kept.
export function readGenreRows(table: string[][]): ReadRowsResult {
  if (table.length === 0) return { ok: false, error: 'The file is empty.' };
  const header = table[0].map((h) => readCell(h).replace(/^﻿/, '').trim().toLowerCase());
  const col = (name: string) => header.indexOf(name.toLowerCase());
  const artistCol = col('Artist');
  const newCol = col('New genres');
  if (artistCol < 0) return { ok: false, error: 'The file has no "Artist" column.' };
  if (newCol < 0) return { ok: false, error: 'The file has no "New genres" column.' };
  const mbidCol = col('MusicBrainz ID');
  const stampCol = col('Version (leave as it is)');

  const rows: GenreCsvRow[] = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    const get = (c: number) => (c < 0 ? '' : readCell(cells[c] ?? '').trim());
    const newGenres = get(newCol);
    if (!newGenres) continue; // blank means leave the act alone
    rows.push({
      line: i + 1,
      name: get(artistCol),
      mbid: get(mbidCol),
      newGenres,
      stamp: get(stampCol),
    });
    if (rows.length > MAX_CSV_ROWS) {
      return {
        ok: false,
        error: `This file has more than ${MAX_CSV_ROWS.toLocaleString('en-US')} rows with new genres. Split it into smaller files.`,
      };
    }
  }
  return { ok: true, rows };
}

export type GenreListResult = { ok: true; styles: string[] } | { ok: false; reason: string };

// Semicolon-separated genres: trimmed, inner spaces collapsed, duplicates
// dropped (first spelling kept, case-insensitive). A list over the limits is
// refused whole, never cut short.
export function parseGenreList(raw: string): GenreListResult {
  const styles: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(';')) {
    const style = part.replace(/\s+/g, ' ').trim();
    if (!style) continue;
    const k = style.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    styles.push(style);
  }
  if (styles.length === 0) {
    return { ok: false, reason: 'The New genres cell has no genre names, only separators. Leave the cell blank to keep the act as it is.' };
  }
  if (styles.length > MAX_OWN_GENRES) {
    return { ok: false, reason: `There are ${styles.length} genres. The limit is ${MAX_OWN_GENRES} per act.` };
  }
  if (styles.some((s) => s.length > MAX_GENRE_LENGTH)) {
    return { ok: false, reason: `A genre is longer than ${MAX_GENRE_LENGTH} characters.` };
  }
  return { ok: true, styles };
}

// Matching never guesses: MusicBrainz ID first, then the exact normalized name
// (or the name after your renames in `aliases`). Anything unclear is skipped.
export function matchCsvRows(
  rows: GenreCsvRow[],
  acts: CsvAct[],
  aliases: Record<string, string>,
): { matched: MatchedRow[]; skipped: SkippedRow[] } {
  const byMbid = new Map<string, CsvAct[]>();
  const byKey = new Map<string, CsvAct>();
  for (const act of acts) {
    const id = (act.mbid ?? '').trim().toLowerCase();
    if (id) byMbid.set(id, [...(byMbid.get(id) ?? []), act]);
    if (!byKey.has(act.key)) byKey.set(act.key, act);
  }

  // A name that has its own row is that act, even when a rename links it to
  // another exported act. The rename is used only when there is no exact row.
  const nameHitsFor = (name: string): CsvAct[] => {
    const exactKey = normalizeName(name);
    if (!exactKey) return [];
    const exact = byKey.get(exactKey);
    if (exact) return [exact];
    const renamed = byKey.get(normalizeName(canonicalName(name, aliases)));
    return renamed ? [renamed] : [];
  };

  const skipped: SkippedRow[] = [];
  const resolved: MatchedRow[] = [];
  const skip = (row: GenreCsvRow, reason: string) => skipped.push({ line: row.line, name: row.name, reason });

  for (const row of rows) {
    const mbid = row.mbid.trim().toLowerCase();
    const idHits = mbid ? (byMbid.get(mbid) ?? []) : [];
    if (idHits.length > 1) {
      skip(row, 'the MusicBrainz ID matches more than one act');
      continue;
    }
    const nameHits = nameHitsFor(row.name);
    if (nameHits.length > 1) {
      skip(row, 'the name matches more than one act');
      continue;
    }
    let act: CsvAct;
    if (idHits.length === 1) {
      act = idHits[0];
      if (nameHits.length === 1 && nameHits[0] !== act) {
        skip(row, 'the ID and the name point to different acts');
        continue;
      }
    } else {
      if (nameHits.length === 0) {
        skip(row, 'no act with that MusicBrainz ID or name');
        continue;
      }
      act = nameHits[0];
      const actMbid = (act.mbid ?? '').trim().toLowerCase();
      if (mbid && actMbid && actMbid !== mbid) {
        skip(row, 'the name matches an act with a different MusicBrainz ID');
        continue;
      }
    }
    resolved.push({ row, act });
  }

  // Two rows for one act: which one is right is a guess, so both are skipped.
  const perAct = new Map<string, number>();
  for (const m of resolved) perAct.set(m.act.key, (perAct.get(m.act.key) ?? 0) + 1);
  const matched: MatchedRow[] = [];
  for (const m of resolved) {
    if ((perAct.get(m.act.key) ?? 0) > 1) skip(m.row, 'two rows for the same act');
    else matched.push(m);
  }
  skipped.sort((a, b) => a.line - b.line);
  return { matched, skipped };
}

// Key-only resolving: no vocabulary, no map, no rows. Each genre is its own key
// and keeps the spelling typed.
const PLAIN_RESOLVER = genreResolver(undefined, []);

// Preview: matches, parses each list, resolves each typed genre through the
// vocabulary (`resolver`), checks the stamp, and works out the before and after.
// Two typed spellings of one genre become one. A genre with no letter or digit
// refuses the row. Changes nothing.
export function previewGenresCsv(
  rows: GenreCsvRow[],
  acts: CsvAct[],
  aliases: Record<string, string>,
  known: KnownGenre[],
  resolver: GenreResolver = PLAIN_RESOLVER,
): { changes: GenreChange[]; skipped: SkippedRow[] } {
  const { matched, skipped } = matchCsvRows(rows, acts, aliases);
  const knownBy = new Map<string, KnownGenre>();
  for (const g of known) {
    const k = genreKey(g.style);
    if (k && !knownBy.has(k)) knownBy.set(k, g);
  }
  const changes: GenreChange[] = [];
  for (const { row, act } of matched) {
    const list = parseGenreList(row.newGenres);
    if (!list.ok) {
      skipped.push({ line: row.line, name: row.name || act.name, reason: list.reason });
      continue;
    }
    if (list.styles.some((s) => !genreKey(s))) {
      skipped.push({ line: row.line, name: row.name || act.name, reason: GENRE_NEEDS_LETTER });
      continue;
    }
    const before = shownStyles(act);
    const beforeSource: ShownSource = before.length ? act.source : 'none';
    const stamp = row.stamp.trim().toLowerCase();
    const readable = /^[0-9a-f]{8}$/.test(stamp);
    const stale = readable
      ? stamp !== genreStamp(beforeSource, before) && stamp !== legacyGenreStamp(beforeSource, before)
      : before.length > 0;
    const after: AfterGenre[] = [];
    const afterKeys = new Set<string>();
    for (const typed of list.styles) {
      const r = resolver.resolve(typed);
      if (afterKeys.has(r.key)) continue;
      afterKeys.add(r.key);
      const k = knownBy.get(r.key);
      const g: AfterGenre = k
        ? { style: k.style, parent: k.parent, isNew: false }
        : { style: r.name, parent: r.name, isNew: true };
      if (g.style !== typed) g.typed = typed;
      after.push(g);
    }
    const beforeKeys = new Set(before.map((s) => resolver.resolve(s).key));
    const same = beforeKeys.size === afterKeys.size && [...afterKeys].every((k) => beforeKeys.has(k));
    changes.push({
      line: row.line,
      key: act.key,
      name: act.name,
      mbid: act.mbid ?? '',
      before,
      beforeSource,
      after,
      stale,
      sameAsNow: (act.source === 'you' || act.source === 'owner') && same,
    });
  }
  skipped.sort((a, b) => a.line - b.line);
  return { changes, skipped };
}

// What Apply saves: no "no change" rows, and stale rows only when ticked.
export function changesToSave(changes: GenreChange[], overwrite: ReadonlySet<string>): GenreChange[] {
  return changes.filter((c) => !c.sameAsNow && (!c.stale || overwrite.has(c.key)));
}
