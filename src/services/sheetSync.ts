import type { LoggedEvent } from '../server/events/types';
import type { LineupFacts } from '../server/events/scale';
import { eventRows } from './format';
import { mapColumns, ReadList } from './listImport';

// The linked Google Sheet in the browser. Sync is one way: the app is the
// source of truth and writes your log into the tab; nothing is read back.
// The tab is read only to warn before edits made there are replaced. See
// ARCHITECTURE.md ("Google Sheets sync").

export type SheetValue = string | number | boolean;

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(1899, 11, 30); // day 0 of Sheets (and Excel) dates

export function serialToDate(serial: number): string | undefined {
  if (!Number.isFinite(serial) || serial < 1 || serial > 100_000) return undefined;
  return new Date(EPOCH + Math.floor(serial) * DAY_MS).toISOString().slice(0, 10);
}

// Cells as text. The sheet is read unformatted, so a date you typed is a
// serial number; in a Date or End date column it becomes YYYY-MM-DD again.
// Numbers anywhere else stay numbers.
export function sheetTable(values: Array<Array<SheetValue | null>>): string[][] {
  if (!values.length) return [];
  const header = values[0].map((v) => String(v ?? ''));
  const columns = mapColumns(header);
  return values.map((row, r) =>
    row.map((v, c) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
      if (typeof v === 'number') {
        const field = columns[c]?.field;
        if (r > 0 && (field === 'startDate' || field === 'endDate')) return serialToDate(v) ?? String(v);
        return String(v);
      }
      return String(v);
    }),
  );
}

// Your whole log as the tab's cells, header first. A member's sheet leaves out
// Notes and Went with: their vault keeps those encrypted, and the server cuts
// the same columns again before anything reaches Google.
export const PRIVATE_COLUMNS = ['Notes', 'Went with'];

export function sheetRows(
  events: LoggedEvent[],
  editions: Record<string, LineupFacts> = {},
  options: { omitPrivate?: boolean } = {},
): Array<Array<string | number | null>> {
  const { header, rows } = eventRows(events, editions);
  const keep = header.map((h) => !(options.omitPrivate && PRIVATE_COLUMNS.includes(h)));
  const pick = <T,>(r: T[]) => r.filter((_, i) => keep[i]);
  return [pick(header), ...rows.map((r) => pick(r.map((v) => (v === undefined || v === '' ? null : v))))];
}

// Rows of the tab that differ from what the app last wrote there (edited,
// added or removed in the sheet), which updating the sheet replaces.
// Without a base (never written by the app), every row with data counts.
export function outsideEdits(table: string[][], base?: string[][]): number {
  const key = (r: string[]) => JSON.stringify(r.map((c) => c.trim()).filter((c, i, all) => all.slice(i).some(Boolean)));
  const filled = (rows: string[][]) => rows.filter((r) => r.some((c) => c.trim()));
  const mine = filled(table);
  if (!base) return Math.max(0, mine.length - 1);
  const was = new Map<string, number>();
  for (const r of filled(base)) was.set(key(r), (was.get(key(r)) ?? 0) + 1);
  let differ = 0;
  for (const r of mine) {
    const k = key(r);
    const left = was.get(k) ?? 0;
    if (left) was.set(k, left - 1);
    else differ++;
  }
  let removed = 0;
  for (const n of was.values()) removed += n;
  return Math.max(differ, removed);
}

// Columns of the sheet the app doesn't write; updating rewrites the tab, so
// they are lost.
export function droppedColumns(list: ReadList): string[] {
  const ours = new Set(eventRows([]).header.map((h) => h.toLowerCase()));
  return list.columns.filter((c) => c.header && !c.field && !ours.has(c.header.toLowerCase())).map((c) => c.header);
}
