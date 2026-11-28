// Artist genres CSV: store access. Export, preview, apply and undo of one
// upload. The matching and checks are pure (genreCsv.ts); this file reads and
// writes the store. No model calls. Spec: docs/archive/genres-csv.md.

import { InputError } from '../lineup/pipeline';
import { CanonicalStoreError } from '../lineup/store/types';
import type { LineupStore } from '../lineup/store/types';
import { genreUniverse } from './genreCatalog';
import { genresByArtist } from '../../services/genres';
import { GENRE_MAP_SETTING, ownerGenreRow } from './genres';
import { NOT_GROUPED, genreKey, genreResolver } from './genreVocabulary';
import type { GenreResolver } from './genreVocabulary';
import type {
  ArtistGenres,
  GenreChange as LoggedGenreChange,
  GenreMapEntry,
  GenreShare,
  GenreVocabulary,
  KnownGenre,
} from './genreTypes';
import {
  MAX_CSV_ROWS,
  changesToSave,
  csvText,
  exportTable,
  previewGenresCsv as previewRows,
} from './genreCsv';
import type { CsvAct, GenreChange, GenreCsvRow, SkippedRow } from './genreCsv';

// app_settings key of the old undo record, from before undo read the change log.
// It is ignored, and cleared (set to null) when an apply or undo finds it.
export const GENRES_CSV_UNDO_SETTING = 'genres_csv_undo';

// The reasons written to artist_genre_changes by an upload and by its undo.
export const UPLOAD_REASON = 'Genres file upload';
export const UNDO_REASON = 'Undo genres file upload';

async function clearOldUndoSetting(store: LineupStore): Promise<void> {
  if ((await store.getSetting(GENRES_CSV_UNDO_SETTING)) != null) await store.putSetting(GENRES_CSV_UNDO_SETTING, null);
}

interface Catalog {
  acts: CsvAct[];
  aliases: Record<string, string>;
  known: KnownGenre[];
  knownMap: Map<string, KnownGenre>;
  resolver: GenreResolver;
  rows: ArtistGenres[];
}

// Every genre the app knows (the genre map, the stored rows, the owner's
// vocabulary), each once, resolved through the vocabulary: its shown spelling and
// group. A genre the vocabulary only aliases is known under the genre it points to.
function resolvedKnown(resolver: GenreResolver, map: GenreMapEntry[], rows: ArtistGenres[], vocab: GenreVocabulary): KnownGenre[] {
  const out = new Map<string, KnownGenre>();
  const add = (style: string) => {
    const r = resolver.resolve(style);
    if (r.key && !out.has(r.key)) out.set(r.key, { style: r.name, parent: r.parent ?? NOT_GROUPED });
  };
  for (const m of map) add(m.style);
  for (const r of rows) for (const g of r.genres) add(g.style);
  for (const g of vocab.genres) add(g.name);
  return [...out.values()].sort((a, b) => a.style.localeCompare(b.style));
}

// Every act that can have shared genres (genreUniverse: the lineup catalog with
// its MusicBrainz IDs, every member's seen acts by name only, the owner's
// records), once by key. Each row shows what genresByArtist shows, resolved
// through the owner's vocabulary. Stored rows are read, never rewritten.
async function loadCatalog(store: LineupStore): Promise<Catalog> {
  const [universe, setting, rows, aliases, vocab] = await Promise.all([
    genreUniverse(store),
    store.getSetting<GenreMapEntry[]>(GENRE_MAP_SETTING),
    store.listArtistGenres(),
    store.getAliases(),
    store.getGenreVocabulary(),
  ]);
  const map = setting ?? [];
  const resolver = genreResolver(vocab, map, rows);
  const shown = genresByArtist(rows, vocab, map);
  // The owner's ranks, by genreKey: the shown genres keep their order, so export lists by rank.
  const ownerRanks = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.source !== 'owner') continue;
    ownerRanks.set(r.key, new Map(r.genres.filter((g) => typeof g.rank === 'number').map((g) => [genreKey(g.style), g.rank!])));
  }
  const acts: CsvAct[] = universe.map((a) => {
    const g = shown.get(a.key);
    const ranks = g?.source === 'owner' ? ownerRanks.get(a.key) : undefined;
    return {
      key: a.key,
      name: a.name,
      mbid: a.mbid,
      source: g ? g.source : 'none',
      genres: (g?.genres ?? []).map((x: GenreShare) => {
        const rank = ranks?.get(genreKey(x.style));
        return rank != null ? { style: x.style, weight: x.weight, rank } : { style: x.style, weight: x.weight };
      }),
    };
  });
  const known = resolvedKnown(resolver, map, rows, vocab);
  const knownMap = new Map(known.map((g) => [genreKey(g.style), g]));
  return { acts, aliases, known, knownMap, resolver, rows };
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
  return previewRows(rows, cat.acts, cat.aliases, cat.known, cat.resolver);
}

export interface GenresCsvApplyResult {
  saved: number;
  skipped: SkippedRow[];
  batchId: string | null;
}

// Saves the matched, valid rows that are not stale (or are ticked in `overwrite`)
// as shared `owner` rows, one batch in the change log. The newest batch is the
// one an undo puts back. An upload that saves nothing writes no batch.
export async function applyGenresCsv(store: LineupStore, input: unknown, now: Date): Promise<GenresCsvApplyResult> {
  const rows = readUploadRows(input);
  const overwrite = readOverwrite(input);
  const cat = await loadCatalog(store);
  const { changes, skipped } = previewRows(rows, cat.acts, cat.aliases, cat.known, cat.resolver);
  for (const c of changes) {
    if (c.stale && !c.sameAsNow && !overwrite.has(c.key)) {
      skipped.push({ line: c.line, name: c.name, reason: 'changed in the app after you downloaded the file (tick "Replace anyway" to overwrite)' });
    }
  }
  skipped.sort((a, b) => a.line - b.line);

  const saving: ArtistGenres[] = [];
  for (const c of changesToSave(changes, overwrite)) {
    saving.push(ownerGenreRow(cat.knownMap, c.key, c.name, c.after.map((a) => a.style), now));
  }
  await clearOldUndoSetting(store);
  if (saving.length === 0) return { saved: 0, skipped, batchId: null };

  const batchId = `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await store.writeArtistGenres(
    saving.map((row) => ({ key: row.key, source: 'owner' as const, row })),
    { actor: 'owner', reason: UPLOAD_REASON, batchId },
  );
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

// The latest upload that can be undone, from the change log. A member cannot
// read the log, so a member gets null.
async function latestUpload(store: LineupStore): Promise<LoggedGenreChange[]> {
  try {
    return await store.listGenreChanges({ latestBatchReason: UPLOAD_REASON });
  } catch (err) {
    if (err instanceof CanonicalStoreError && err.code === 'forbidden') return [];
    throw err;
  }
}

// What GET /api/artist-genres reports: when the latest upload was saved and how
// many acts it changed, or null when there is nothing to undo.
export async function genresCsvUndoStatus(store: LineupStore): Promise<{ at: string; count: number } | null> {
  const changes = await latestUpload(store);
  if (!changes.length) return null;
  // The upload's own time (the saved rows' checkedAt, the app clock at Apply), else the log time.
  const when = (c: LoggedGenreChange) => c.after?.checkedAt || c.at;
  const at = changes.map(when).reduce((max, t) => (t > max ? t : max));
  return { at, count: new Set(changes.map((c) => c.key)).size };
}

const keyName = (c: LoggedGenreChange) => c.after?.name ?? c.before?.name ?? c.key;

// Puts back the latest upload, read from artist_genre_changes. A row whose owner
// genres no longer equal what the upload saved (edited since) is left alone and
// named. The restore is one logged write; the upload's changes are marked undone.
export async function undoGenresCsv(store: LineupStore, now: Date = new Date()): Promise<GenresCsvUndoResult> {
  await clearOldUndoSetting(store);
  const changes = await latestUpload(store);
  if (!changes.length) throw new InputError('There is no upload to undo.');
  const own = new Map((await store.listArtistGenres()).filter((r) => r.source === 'owner').map((r) => [r.key, r]));
  const restore: Array<{ key: string; source: 'owner'; row: ArtistGenres | null }> = [];
  const leftAlone: string[] = [];
  for (const c of changes) {
    const current = own.get(c.key);
    if (!current || !c.after || genreSignature(current.genres) !== genreSignature(c.after.genres)) {
      leftAlone.push(keyName(c));
      continue;
    }
    restore.push({ key: c.key, source: 'owner', row: c.before && { ...c.before, source: 'owner' } });
  }
  if (restore.length) await store.writeArtistGenres(restore, { actor: 'owner', reason: UNDO_REASON });
  await store.markGenreChangesUndone(changes.map((c) => c.id), now.toISOString());
  return { restored: restore.length, leftAlone };
}
