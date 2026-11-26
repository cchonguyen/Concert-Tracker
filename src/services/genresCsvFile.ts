// Browser only: builds the artist-genres CSV for download and reads an edited
// file back into rows. The rules (columns, BOM, formula-safe cells, header
// lookup, blank rows left out) live in src/server/events/genreCsv.ts; this file
// only wires them to the file and the download. Spec: docs/specs/genres-csv.md.

import { downloadText } from './download';
import { parseCsv } from './listImport';
import { csvText, exportTable, readGenreRows } from '../server/events/genreCsv';
import type { CsvAct, ReadRowsResult } from '../server/events/genreCsv';

// artists-and-genres-YYYY-MM-DD.csv, using the person's local calendar day.
export function genresCsvFileName(today: Date = new Date()): string {
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  return `artists-and-genres-${y}-${m}-${d}.csv`;
}

// The whole file text: UTF-8 BOM, CRLF, RFC 4180 quoting, formula-safe cells.
export function buildGenresCsv(acts: CsvAct[]): string {
  return csvText(exportTable(acts));
}

export function downloadGenresCsv(acts: CsvAct[], today?: Date): void {
  downloadText(genresCsvFileName(today), buildGenresCsv(acts));
}

// Rows with a filled "New genres" cell, found by header name. A missing
// "Artist" or "New genres" column gives a plain-English error.
export function readGenresCsvText(text: string): ReadRowsResult {
  return readGenreRows(parseCsv(text));
}

export async function readGenresCsvFile(file: Blob): Promise<ReadRowsResult> {
  return readGenresCsvText(await file.text());
}
