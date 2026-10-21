import type { LoggedEvent } from '../server/events/types';
import type { LineupFacts } from '../server/events/scale';
import type { EmailImport } from '../server/events/email/types';
import { eventRows } from './format';
import { BaseRow, editPatch, findMatches, mapColumns, ReadList } from './listImport';

// The linked Google Sheet in the browser: its cells turned into the rows the
// list import reads, and your log turned back into cells. See ARCHITECTURE.md
// ("Google Sheets sync").

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

// Your whole log as the tab's cells, header first.
export function sheetRows(events: LoggedEvent[], editions: Record<string, LineupFacts> = {}): Array<Array<string | number | null>> {
  const { header, rows } = eventRows(events, editions);
  return [header, ...rows.map((r) => r.map((v) => (v === undefined || v === '' ? null : v)))];
}

// The tab as the app last wrote it, by event ID.
export function baseRows(base: ReadList | undefined): Map<string, BaseRow> {
  const out = new Map<string, BaseRow>();
  for (const row of base?.rows ?? []) if (row.eventId) out.set(row.eventId, { row, present: base!.present });
  return out;
}

// Rows that need a look before the sheet is rewritten: everything except
// rows from this app's export that the sheet didn't change since the base
// (or, without one, that match their event exactly).
export function rowsToReview(list: ReadList, events: LoggedEvent[], imports: EmailImport[], base?: ReadList): number {
  const bases = baseRows(base);
  return list.rows.filter((row) => {
    const m = findMatches(row, events, imports);
    return !m.edit || editPatch(row, m.edit, list.present, new Set(), bases.get(m.edit.id)).changes.length > 0;
  }).length;
}

// Columns of the sheet that are neither read back nor written by the app;
// syncing rewrites the tab, so they are lost.
export function droppedColumns(list: ReadList): string[] {
  const ours = new Set(eventRows([]).header.map((h) => h.toLowerCase()));
  return list.columns.filter((c) => c.header && !c.field && !ours.has(c.header.toLowerCase())).map((c) => c.header);
}
