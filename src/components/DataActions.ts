import type { LineupFacts, LoggedEvent } from '../services/lineupApi';
import { eventsToCsv } from '../services/format';
import { downloadText } from '../services/download';

// The same data tools everywhere they appear (Menu, Table, Quick add). Import,
// Sheets and the list of panels are opened by App, so only one copy is open at
// a time; the CSV download is shared here so the file name and rules match.

export type DataPanel = 'import' | 'sheets';

// Downloads the rows as CSV, named by the day. The Menu passes every event;
// the Table passes the rows its filters show.
export function exportCsv(rows: LoggedEvent[], editions: Record<string, LineupFacts>): void {
  downloadText(`livearchive-${new Date().toISOString().slice(0, 10)}.csv`, eventsToCsv(rows, editions));
}
