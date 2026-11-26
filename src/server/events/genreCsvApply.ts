// Artist genres CSV: store access. Export, preview, apply and undo of one
// upload. The matching and checks are pure (genreCsv.ts); this file reads and
// writes the store. No model calls. Spec: docs/specs/genres-csv.md.

import { InputError } from '../lineup/pipeline';
import type { LineupStore } from '../lineup/store/types';
import { genresByArtist } from '../../services/genres';
import { GENRE_MAP_SETTING, knownGenreMap, knownGenres, ownGenreRow } from './genres';
import type { ArtistGenres, GenreMapEntry, GenreShare, KnownGenre } from './genreTypes';
import {
  MAX_CSV_ROWS,
  changesToSave,
  csvText,
  exportTable,
  previewGenresCsv as previewRows,
} from './genreCsv';
import type { CsvAct, GenreChange, GenreCsvRow, SkippedRow } from './genreCsv';

// app_settings key of the latest upload's undo record (one per person).
export const GENRES_CSV_UNDO_SETTING = 'genres_csv_undo';

export interface GenresCsvUndoRecord {
  batchId: string;
  at: string;
  rows: Array<{ key: string; name: string; before: ArtistGenres | null; after: ArtistGenres }>;
}

interface Catalog {
  acts: CsvAct[];
  aliases: Record<string, string>;
  known: KnownGenre[];
  knownMap: Map<string, KnownGenre>;
  rows: ArtistGenres[];
}

// Every act you can give genres: each seen act, plus every live artist record,
// once by key. Each row shows what genresByArtist shows.
async function loadCatalog(store: LineupStore): Promise<Catalog> {
  const [events, entities, map, rows, aliases] = await Promise.all([
    store.listEvents(),
    store.listEntities(),
    store.getSetting<GenreMapEntry[]>(GENRE_MAP_SETTING),
    store.listArtistGenres(),
    store.getAliases(),
  ]);
  const byKey = new Map<string, { key: string; name: string; mbid?: string }>();
  for (const e of events) for (const s of e.seen) if (!byKey.has(s.key)) byKey.set(s.key, { key: s.key, name: s.name });
  for (const e of entities) {
    if (e.kind === 'artist' && !e.mergedIntoId && !byKey.has(e.nameNormalized)) byKey.set(e.nameNormalized, { key: e.nameNormalized, name: e.name });
  }
  for (const a of await store.getArtists([...byKey.keys()])) {
    const act = byKey.get(a.key);
    if (act && a.mbid) act.mbid = a.mbid;
  }
  const shown = genresByArtist(rows);
  const acts: CsvAct[] = [...byKey.values()].map((a) => {
    const g = shown.get(a.key);
    return {
      key: a.key,
      name: a.name,
      mbid: a.mbid,
      source: g ? g.source : 'none',
      genres: (g?.genres ?? []).map((x: GenreShare) => ({ style: x.style, weight: x.weight })),
    };
  });
  const known = knownGenres(map ?? [], rows);
  return { acts, aliases, known, knownMap: knownGenreMap(map ?? [], rows), rows };
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

// Reads the browser's rows. Blank "New genres" rows are dropped here: blank
// means leave the act alone, so they are never sent on to be skipped.
function readUploadRows(input: unknown): GenreCsvRow[] {
  const list = (input as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(list)) throw new InputError('Send { rows: [...] }.');
  const out: GenreCsvRow[] = [];
  for (const raw of list) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const newGenres = text(r.newGenres);
    if (!newGenres) continue;
    out.push({
      line: Number.isInteger(r.line) ? (r.line as number) : 0,
      name: text(r.name),
      mbid: text(r.mbid),
      newGenres,
      stamp: text(r.stamp),
    });
  }
  if (out.length > MAX_CSV_ROWS) {
    throw new InputError(`This file has more than ${MAX_CSV_ROWS.toLocaleString('en-US')} rows with new genres. Split it into smaller files.`);
  }
  return out;
}

function readOverwrite(input: unknown): Set<string> {
  const o = (input as { overwrite?: unknown } | null)?.overwrite;
  return new Set(Array.isArray(o) ? o.filter((k): k is string => typeof k === 'string') : []);
}

// The downloadable file: the acts you can give genres, as it is shown now.
export async function exportGenresCsv(store: LineupStore): Promise<string> {
  const { acts } = await loadCatalog(store);
  return csvText(exportTable(acts));
}

// Matches and checks the rows. Changes nothing.
export async function previewGenresCsv(store: LineupStore, input: unknown): Promise<{ changes: GenreChange[]; skipped: SkippedRow[] }> {
  const rows = readUploadRows(input);
  const cat = await loadCatalog(store);
  return previewRows(rows, cat.acts, cat.aliases, cat.known);
}

export interface GenresCsvApplyResult {
  saved: number;
  skipped: SkippedRow[];
  batchId: string | null;
}

// Saves the matched, valid rows that are not stale (or are ticked in `overwrite`),
// and records the undo for this upload. A new upload replaces the undo record.
// An upload that saves nothing leaves the previous undo record as it is.
export async function applyGenresCsv(store: LineupStore, input: unknown, now: Date): Promise<GenresCsvApplyResult> {
  const rows = readUploadRows(input);
  const overwrite = readOverwrite(input);
  const cat = await loadCatalog(store);
  const { changes, skipped } = previewRows(rows, cat.acts, cat.aliases, cat.known);
  for (const c of changes) {
    if (c.stale && !c.sameAsNow && !overwrite.has(c.key)) {
      skipped.push({ line: c.line, name: c.name, reason: 'changed in the app after you downloaded the file (tick "Replace anyway" to overwrite)' });
    }
  }
  skipped.sort((a, b) => a.line - b.line);

  const ownBefore = new Map(cat.rows.filter((r) => r.source === 'you').map((r) => [r.key, r]));
  const saving: ArtistGenres[] = [];
  const undoRows: GenresCsvUndoRecord['rows'] = [];
  for (const c of changesToSave(changes, overwrite)) {
    const row = ownGenreRow(cat.knownMap, c.key, c.name, c.after.map((a) => a.style), now);
    saving.push(row);
    undoRows.push({ key: c.key, name: c.name, before: ownBefore.get(c.key) ?? null, after: row });
  }
  if (saving.length === 0) return { saved: 0, skipped, batchId: null };

  await store.putArtistGenres(saving);
  const batchId = `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const record: GenresCsvUndoRecord = { batchId, at: now.toISOString(), rows: undoRows };
  await store.putSetting(GENRES_CSV_UNDO_SETTING, record);
  return { saved: saving.length, skipped, batchId };
}

const genreSignature = (genres: GenreShare[]) =>
  genres
    .map((g) => `${g.style.toLowerCase()}|${g.parent}|${g.weight}`)
    .sort()
    .join('\n');

export interface GenresCsvUndoResult {
  restored: number;
  leftAlone: string[]; // acts edited after the upload, left as they are
}

// Puts back the latest upload. A row whose "you" genres no longer equal what
// the upload saved (edited since) is left alone. The record is then removed.
export async function undoGenresCsv(store: LineupStore): Promise<GenresCsvUndoResult> {
  const record = await store.getSetting<GenresCsvUndoRecord>(GENRES_CSV_UNDO_SETTING);
  if (!record) throw new InputError('There is no upload to undo.');
  const own = new Map((await store.listArtistGenres()).filter((r) => r.source === 'you').map((r) => [r.key, r]));
  const restore: ArtistGenres[] = [];
  const leftAlone: string[] = [];
  let restored = 0;
  for (const r of record.rows) {
    const current = own.get(r.key);
    if (!current || genreSignature(current.genres) !== genreSignature(r.after.genres)) {
      leftAlone.push(r.name);
      continue;
    }
    if (r.before) restore.push(r.before);
    else await store.deleteArtistGenres(r.key, 'you');
    restored += 1;
  }
  if (restore.length) await store.putArtistGenres(restore);
  await store.putSetting<GenresCsvUndoRecord | null>(GENRES_CSV_UNDO_SETTING, null);
  return { restored, leftAlone };
}
