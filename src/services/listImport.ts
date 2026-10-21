import type { EventPatch } from '../server/events/service';
import type { EmailImport } from '../server/events/email/types';
import type { LoggedEvent } from '../server/events/types';
import { toSeenInput } from '../server/events/seen';

// A list of past events you kept elsewhere (a Notion export, a spreadsheet,
// this app's own CSV export) read into rows you review in the Table view.
// Everything here is your own record, so the fields it fills count as typed
// by you. It only rearranges what the file says: a date it cannot read stays
// unread, and nothing missing is filled in. See ARCHITECTURE.md ("Importing a
// list").

export type ListField =
  | 'name'
  | 'startDate'
  | 'endDate'
  | 'year'
  | 'venue'
  | 'city'
  | 'country'
  | 'seen'
  | 'companions'
  | 'rating'
  | 'ticketPrice'
  | 'format'
  | 'series'
  | 'notes'
  | 'id';

// Header words each field answers to, compared lowercased.
const HEADERS: Record<ListField, string[]> = {
  name: ['event', 'name', 'title', 'show', 'event name'],
  startDate: ['date', 'dates', 'when', 'start date', 'start'],
  endDate: ['end date', 'end'],
  year: ['year'],
  venue: ['venue', 'location', 'place'],
  city: ['city', 'town'],
  country: ['country'],
  seen: ['artist', 'artists', 'saw', 'seen', 'acts', 'acts seen', 'performers'],
  companions: ['attendee', 'attendees', 'went with', 'with', 'companions', 'people', 'friends'],
  rating: ['rating', 'stars', 'score'],
  ticketPrice: ['ticket price', 'price', 'cost', 'paid'],
  format: ['format'],
  series: ['series', 'festival series'],
  notes: ['notes', 'note', 'comments'],
  // This app's own export: the event the row came from.
  id: ['id'],
};

export interface ListColumn {
  header: string;
  field: ListField | null; // null: not imported
}

export interface ListRow {
  id: string;
  lines: number[]; // file line numbers, header is line 1
  name: string;
  startDate?: string;
  endDate?: string;
  year?: number;
  yearFromName?: boolean; // no date in the row; the year is the one in its name
  venue?: string;
  city?: string;
  country?: string;
  seen: string[];
  companions: string[];
  rating?: number;
  ticketPrice?: number;
  format?: string;
  series?: string;
  notes?: string;
  eventId?: string; // the ID column of this app's export
  unread: ListField[]; // cells with a value that couldn't be read
  problems: string[]; // things you should look at; none is fixed for you
}

export interface ReadList {
  columns: ListColumn[];
  present: ListField[]; // fields the file has a column for
  rows: ListRow[];
  combined: number; // rows folded into an earlier row of the same file
  error?: string;
}

// RFC 4180: quoted cells, doubled quotes, newlines inside quotes, CRLF.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// Same rule as normalizeName on the server (src/server/lineup/text.ts),
// which cannot be bundled for the browser.
export function norm(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoDate(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1) return undefined;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return undefined;
  return d.toISOString().slice(0, 10);
}

// One full date: 2024-05-17, or May 17, 2024 / 17 May 2024. Nothing else:
// 05/06/2024 could be either month first or day first.
export function readDate(text: string): string | undefined {
  const s = text.trim().replace(/\s+/g, ' ');
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^([A-Za-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(s);
  if (m) return isoDate(Number(m[3]), MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, Number(m[2]));
  m = /^(\d{1,2}) ([A-Za-z]+)\.? (\d{4})$/.exec(s);
  if (m) return isoDate(Number(m[3]), MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, Number(m[1]));
  return undefined;
}

// "May 17, 2024 → May 19, 2024" (Notion), "2024-05-17 – 2024-05-19", or one date.
export function readDates(text: string): { startDate?: string; endDate?: string; unread?: string } {
  const s = text.trim();
  if (!s) return {};
  const parts = s.split(/\s*[→–—]\s*|\s+(?:-|to)\s+/);
  if (parts.length > 2) return { unread: s };
  const start = readDate(parts[0]);
  const end = parts[1] !== undefined ? readDate(parts[1]) : undefined;
  if (!start || (parts[1] !== undefined && !end)) return { unread: s };
  return { startDate: start, endDate: end && end !== start ? end : undefined };
}

// "Las Vegas NV" is written "Las Vegas, NV" like the rest of the app.
function cityLabel(city: string): string {
  return city.replace(/^(.*\S)\s+([A-Z]{2})$/, (_, c: string, st: string) => (c.endsWith(',') ? `${c} ${st}` : `${c}, ${st}`));
}

// Notion joins a multi-select with commas; this app's export uses semicolons.
function splitList(cell: string): string[] {
  const sep = cell.includes(';') ? ';' : ',';
  return cell
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

function union(a: string[], b: string[]): string[] {
  const out = [...a];
  const keys = new Set(a.map(norm));
  for (const x of b) {
    if (keys.has(norm(x))) continue;
    keys.add(norm(x));
    out.push(x);
  }
  return out;
}

// A "?" between letters is usually a character the export could not write
// (KØD becomes K?D). It is shown, never guessed back.
const LOST = /[\p{L}\p{N}]\?|\?[\p{L}\p{N}]/u;

export function mapColumns(header: string[]): ListColumn[] {
  const used = new Set<ListField>();
  return header.map((h) => {
    const key = h.trim().toLowerCase();
    const field = (Object.keys(HEADERS) as ListField[]).find((f) => !used.has(f) && HEADERS[f].includes(key)) ?? null;
    if (field) used.add(field);
    return { header: h.trim(), field };
  });
}

export function readList(text: string): ReadList {
  return readTable(parseCsv(text));
}

// Rows of cells (a CSV, or a Google Sheet's tab) with a header row first.
export function readTable(cells: string[][]): ReadList {
  const table = cells.filter((r) => r.some((c) => c.trim()));
  if (table.length < 2) return { columns: [], present: [], rows: [], combined: 0, error: 'The file has no rows under its header.' };
  const columns = mapColumns(table[0]);
  const present = columns.flatMap((c) => (c.field ? [c.field] : []));
  if (!present.includes('name')) {
    return { columns, present, rows: [], combined: 0, error: 'No column for the event name (expected a header like "Event" or "Name").' };
  }
  const rows: ListRow[] = [];
  const byKey = new Map<string, ListRow>();
  let combined = 0;
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const get = (f: ListField) => {
      const idx = columns.findIndex((c) => c.field === f);
      return idx >= 0 ? (cells[idx] ?? '').trim() : '';
    };
    const name = get('name').replace(/\s+/g, ' ');
    if (!name) return;
    const row: ListRow = { id: `line-${line}`, lines: [line], name, seen: [], companions: [], unread: [], problems: [] };
    const dates = readDates(get('startDate'));
    if (dates.unread) {
      row.problems.push(`Couldn't read the date "${dates.unread}".`);
      row.unread.push('startDate');
    }
    row.startDate = dates.startDate;
    row.endDate = dates.endDate;
    const end = get('endDate');
    if (end && !row.endDate) {
      const d = readDate(end);
      if (d) row.endDate = d !== row.startDate ? d : undefined;
      else {
        row.problems.push(`Couldn't read the end date "${end}".`);
        row.unread.push('endDate');
      }
    }
    if (row.endDate && (!row.startDate || row.endDate < row.startDate)) {
      row.problems.push('The end date is before the start date, so it was left out.');
      row.endDate = undefined;
    }
    const yearCell = get('year');
    if (row.startDate) row.year = Number(row.startDate.slice(0, 4));
    else if (/^(19|20)\d{2}$/.test(yearCell)) row.year = Number(yearCell);
    const named = /\b((?:19|20)\d{2})\b/.exec(name);
    if (row.year === undefined && named) {
      row.year = Number(named[1]);
      row.yearFromName = true;
    }
    if (named && row.startDate && Number(named[1]) !== row.year) {
      row.problems.push(`The name says ${named[1]} but the date is in ${row.year}.`);
    }
    if (!row.startDate) row.problems.push(row.year ? 'No date, only a year.' : 'No date or year.');
    row.venue = get('venue') || undefined;
    row.city = get('city') ? cityLabel(get('city')) : undefined;
    row.country = get('country') || undefined;
    row.seen = union([], splitList(get('seen')));
    row.companions = union([], splitList(get('companions')));
    const rating = get('rating');
    if (rating) {
      const r = Number(rating);
      if (Number.isInteger(r) && r >= 1 && r <= 5) row.rating = r;
      else {
        row.problems.push(`Rating "${rating}" isn't 1 to 5, so it was left out.`);
        row.unread.push('rating');
      }
    }
    const price = get('ticketPrice').replace(/[$€£,\s]/g, '');
    if (price) {
      const p = Number(price);
      if (Number.isFinite(p) && p >= 0) row.ticketPrice = p;
      else {
        row.problems.push(`Price "${get('ticketPrice')}" isn't a number, so it was left out.`);
        row.unread.push('ticketPrice');
      }
    }
    row.format = get('format') || undefined;
    row.series = get('series') || undefined;
    row.notes = get('notes') || undefined;
    row.eventId = get('id') || undefined;
    const lost = [name, ...row.seen].filter((s) => LOST.test(s));
    if (lost.length) row.problems.push(`${lost.map((s) => `"${s}"`).join(', ')} may have lost a character in the export.`);

    // The same event twice in one file becomes one row. Rows from this app's
    // export are told apart by their ID.
    const key = row.eventId ? `id|${row.eventId}` : `${norm(name)}|${row.startDate ?? row.year ?? ''}`;
    const earlier = byKey.get(key);
    if (!earlier) {
      byKey.set(key, row);
      rows.push(row);
      return;
    }
    combined++;
    earlier.lines.push(line);
    for (const f of ['endDate', 'venue', 'city', 'country', 'rating', 'ticketPrice', 'format', 'series', 'notes'] as const) {
      if (earlier[f] === undefined && row[f] !== undefined) (earlier as any)[f] = row[f];
    }
    earlier.seen = union(earlier.seen, row.seen);
    earlier.companions = union(earlier.companions, row.companions);
    earlier.unread = [...new Set([...earlier.unread, ...row.unread])];
    earlier.problems = [...new Set([...earlier.problems, ...row.problems])];
  });
  return { columns, present, rows, combined };
}

// What a row can be folded into: a logged event, or a show still waiting in
// the email review.
export type Target = { kind: 'event'; event: LoggedEvent } | { kind: 'email'; row: EmailImport };

interface Facts {
  name?: string;
  startDate?: string;
  endDate?: string;
  year?: number;
}

const factsOf = (t: Target): Facts => (t.kind === 'event' ? t.event : t.row);
export const targetId = (t: Target) => (t.kind === 'event' ? `event:${t.event.id}` : `email:${t.row.id}`);

// The same rule as findLogged for email rows: same date, and the same name
// or one name containing the other ("Robyn" and "Robyn - The Sexistential
// Tour"). Without a date on either side: the same year and the same name.
function sameEvent(row: ListRow, f: Facts): boolean {
  if (!f.name) return false;
  const a = norm(row.name);
  const b = norm(f.name);
  if (row.startDate || f.startDate) {
    if (row.startDate !== f.startDate) return false;
    return a === b || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);
  }
  return a === b && row.year !== undefined && row.year === f.year;
}

// Different names on overlapping days: maybe the same show under another
// name ("EDC 2022" and "EDC Las Vegas 2022"). Only you can say.
function sameDays(row: ListRow, f: Facts): boolean {
  if (!row.startDate || !f.startDate) return false;
  const rowEnd = row.endDate ?? row.startDate;
  const end = f.endDate ?? f.startDate;
  return row.startDate <= end && f.startDate <= rowEnd;
}

export interface Matches {
  edit?: LoggedEvent; // the event this row was exported from
  exact?: Target;
  nearby: Target[];
}

export function findMatches(row: ListRow, events: LoggedEvent[], emails: EmailImport[]): Matches {
  const edit = row.eventId ? events.find((e) => e.id === row.eventId) : undefined;
  if (edit) return { edit, nearby: [] };
  // An email row already linked to an event is that event.
  const open = emails.filter((r) => (r.status === 'new' || r.status === 'skipped') && !r.eventId);
  const targets: Target[] = [
    ...events.map((event) => ({ kind: 'event' as const, event })),
    ...open.map((r) => ({ kind: 'email' as const, row: r })),
  ];
  const exact = targets.find((t) => sameEvent(row, factsOf(t)));
  const nearby = targets.filter((t) => t !== exact && sameDays(row, factsOf(t)));
  return { exact, nearby };
}

// What the row adds to an event that already has `base`: only empty fields,
// plus acts and people it does not list yet. Nothing already there changes.
export function fillPatch(row: ListRow, base: Partial<LoggedEvent>, leaveOut: Set<string> = new Set()): { patch: EventPatch; adds: string[] } {
  const patch: EventPatch = {};
  const adds: string[] = [];
  if (!base.startDate && row.startDate) {
    patch.startDate = row.startDate;
    adds.push('date');
    if (row.endDate && !base.endDate) patch.endDate = row.endDate;
  } else if (base.startDate && base.startDate === row.startDate && !base.endDate && row.endDate) {
    patch.endDate = row.endDate;
    adds.push('end date');
  }
  if (!base.startDate && !patch.startDate && base.year === undefined && row.year !== undefined) {
    patch.year = row.year;
    adds.push('year');
  }
  for (const f of ['venue', 'city', 'country'] as const) {
    if (!base[f] && row[f]) {
      patch[f] = row[f];
      adds.push(f);
    }
  }
  const seen = base.seen ?? [];
  const known = new Set(seen.map((s) => norm(s.name)));
  const newActs = row.seen.filter((a) => !known.has(norm(a)));
  if (newActs.length) {
    patch.seen = [...toSeenInput(seen), ...newActs.map((name) => ({ name, from: 'you' as const }))];
    adds.push(`${newActs.length} act${newActs.length === 1 ? '' : 's'} seen`);
  }
  const people = base.companions ?? [];
  const knownPeople = new Set(people.map(norm));
  const newPeople = row.companions.filter((c) => !leaveOut.has(norm(c)) && !knownPeople.has(norm(c)));
  if (newPeople.length) {
    patch.companions = [...people, ...newPeople];
    adds.push(newPeople.join(', '));
  }
  if (base.rating == null && row.rating !== undefined) {
    patch.rating = row.rating;
    adds.push('rating');
  }
  if (base.ticketPrice == null && row.ticketPrice !== undefined) {
    patch.ticketPrice = row.ticketPrice;
    adds.push('price');
  }
  if (!base.format && row.format) {
    patch.format = row.format;
    adds.push('format');
  }
  if (!base.series && row.series) {
    patch.series = row.series;
    adds.push('series');
  }
  if (!base.notes && row.notes) {
    patch.notes = row.notes;
    adds.push('notes');
  }
  return { patch, adds };
}

// The whole event, for a row that becomes a new one. Fields the file does
// not give are cleared, because saving goes through the capture route and
// its parse can read a place out of a name ("Zedd in the Park").
export function newEventPatch(row: ListRow, leaveOut: Set<string> = new Set()): EventPatch {
  return {
    name: row.name,
    startDate: row.startDate ?? null,
    endDate: row.endDate ?? null,
    year: row.startDate ? undefined : (row.year ?? null),
    venue: row.venue ?? null,
    city: row.city ?? null,
    country: row.country ?? null,
    seen: row.seen.map((name) => ({ name, from: 'you' as const })),
    companions: row.companions.filter((c) => !leaveOut.has(norm(c))),
    rating: row.rating ?? null,
    ticketPrice: row.ticketPrice ?? null,
    format: row.format ?? null,
    series: row.series ?? null,
    notes: row.notes ?? null,
  };
}

export interface Change {
  field: string;
  from: string; // the app's value; empty: nothing there
  to: string; // the file's value
  // The app's value changed too since the file was written (or that can't be
  // told), so the file's value is not simply newer.
  both?: boolean;
}

const shown = (v: unknown) => (v === undefined || v === null ? '' : String(v));

// The same file or sheet row as the app last wrote it, when that is known.
export interface BaseRow {
  row: ListRow;
  present: ListField[];
}

type Scalar = string | number | null;
type ScalarKey = 'name' | 'startDate' | 'endDate' | 'year' | 'venue' | 'city' | 'country' | 'format' | 'series' | 'notes' | 'rating' | 'ticketPrice';

const SCALARS: Array<[ScalarKey, string]> = [
  ['name', 'event'],
  ['startDate', 'date'],
  ['endDate', 'end date'],
  ['year', 'year'],
  ['venue', 'venue'],
  ['city', 'city'],
  ['country', 'country'],
  ['format', 'format'],
  ['series', 'series'],
  ['notes', 'notes'],
  ['rating', 'rating'],
  ['ticketPrice', 'ticket price'],
];

// What a row says for each field; undefined where it says nothing: no
// column, or a cell that couldn't be read. The year counts only for a row
// without a date, and not when it was read from the name.
function rowValues(row: ListRow, present: ListField[]): Record<ScalarKey, Scalar | undefined> {
  const has = (f: ListField) => present.includes(f) && !row.unread.includes(f);
  const dated = has('startDate');
  const out = {} as Record<ScalarKey, Scalar | undefined>;
  out.name = row.name;
  out.startDate = dated ? (row.startDate ?? null) : undefined;
  out.endDate =
    dated && !row.unread.includes('endDate') && (present.includes('endDate') || row.endDate !== undefined)
      ? row.startDate
        ? (row.endDate ?? null)
        : null
      : undefined;
  out.year = dated && !row.startDate && !row.yearFromName ? (row.year ?? null) : undefined;
  for (const f of ['venue', 'city', 'country', 'format', 'series', 'notes', 'rating', 'ticketPrice'] as const) {
    out[f] = has(f) ? (row[f] ?? null) : undefined;
  }
  return out;
}

function appValues(e: LoggedEvent): Record<ScalarKey, Scalar> {
  return {
    name: e.name,
    startDate: e.startDate ?? null,
    endDate: e.endDate ?? null,
    year: e.startDate ? Number(e.startDate.slice(0, 4)) : (e.year ?? null),
    venue: e.venue ?? null,
    city: e.city ?? null,
    country: e.country ?? null,
    format: e.format ?? null,
    series: e.series ?? null,
    notes: e.notes ?? null,
    rating: e.rating ?? null,
    ticketPrice: e.ticketPrice ?? null,
  };
}

// What a row from this app's own export (a file or the linked sheet) changed
// on the event it came from. With `base` (the row as the app last wrote it)
// this is a three-way merge: only what the row changed since then counts,
// so a value you changed in the app since is never put back to the old one.
// A field changed on both sides is marked `both`. Without a base nothing
// tells which side is newer, so every difference is marked `both`. With
// `keepApp`, fields marked `both` keep the app's value. Acts and people are
// merged as lists: what the row added or removed is applied to the app's
// current list. Columns worked out by the app (Type, Artist, Supporting
// artists, Favourite set, Sets, Weather) are not read back.
export function editPatch(
  row: ListRow,
  event: LoggedEvent,
  present: ListField[],
  leaveOut: Set<string> = new Set(),
  base?: BaseRow,
  keepApp = false,
): { patch: EventPatch; changes: Change[] } {
  const has = (f: ListField) => present.includes(f) && !row.unread.includes(f);
  const patch: EventPatch = {};
  const changes: Change[] = [];
  const mine = rowValues(row, present);
  const was = base ? rowValues(base.row, base.present) : undefined;
  const app = appValues(event);

  for (const [f, label] of SCALARS) {
    const to = mine[f];
    if (to === undefined || to === app[f]) continue;
    const before = was?.[f];
    if (before !== undefined && to === before) continue; // the row didn't change it; the app's value stands
    const both = before === undefined || app[f] !== before;
    changes.push({ field: label, from: shown(app[f]), to: shown(to), both });
    if (keepApp && both) continue;
    (patch as Record<string, unknown>)[f] = to;
  }

  // Lists: with a base, what the row added and removed since; without one,
  // the difference from the app, marked `both`.
  const listChange = (mineList: string[], baseList: string[] | undefined, appList: string[]) => {
    const key = (xs: string[]) => new Set(xs.map(norm));
    const from = baseList ?? appList;
    const fromKeys = key(from);
    const mineKeys = key(mineList);
    const appKeys = key(appList);
    const added = mineList.filter((x) => !fromKeys.has(norm(x)) && !appKeys.has(norm(x)));
    const removedKeys = new Set([...fromKeys].filter((k) => !mineKeys.has(k) && appKeys.has(k)));
    return { added, removedKeys, both: !baseList };
  };
  if (has('seen')) {
    const baseSeen = base && base.present.includes('seen') ? base.row.seen : undefined;
    const d = listChange(row.seen, baseSeen, event.seen.map((s) => s.name));
    if (d.added.length || d.removedKeys.size) {
      const removed = event.seen.filter((s) => d.removedKeys.has(norm(s.name)));
      changes.push({ field: 'acts seen', from: removed.map((s) => s.name).join(', '), to: d.added.join(', '), both: d.both });
      if (!(keepApp && d.both)) {
        // Acts kept keep their role, source and your marks.
        patch.seen = [
          ...toSeenInput(event.seen.filter((s) => !d.removedKeys.has(norm(s.name)))),
          ...d.added.map((name) => ({ name, from: 'you' as const })),
        ];
      }
    }
  }
  if (has('companions')) {
    const want = row.companions.filter((c) => !leaveOut.has(norm(c)));
    const basePeople = base && base.present.includes('companions') ? base.row.companions : undefined;
    const d = listChange(want, basePeople, event.companions);
    if (d.added.length || d.removedKeys.size) {
      const removed = event.companions.filter((c) => d.removedKeys.has(norm(c)));
      changes.push({ field: 'went with', from: removed.join(', '), to: d.added.join(', '), both: d.both });
      if (!(keepApp && d.both)) patch.companions = [...event.companions.filter((c) => !d.removedKeys.has(norm(c))), ...d.added];
    }
  }
  return { patch, changes };
}

// Your choice for a row: a new event, folded into a target, or not imported.
// Or, for a row from this app's export, its changes applied to its event.
// keepApp: fields changed on both sides keep the app's value.
export type Choice =
  | { kind: 'new' }
  | { kind: 'skip' }
  | { kind: 'into'; target: Target }
  | { kind: 'edit'; event: LoggedEvent; base?: BaseRow; keepApp: boolean };

export interface ImportApi {
  create(text: string): Promise<LoggedEvent>;
  update(id: string, patch: EventPatch): Promise<LoggedEvent>;
  addEmail(ids: string[]): Promise<{ events: LoggedEvent[]; imports: EmailImport[] }>;
  restoreEmail(ids: string[]): Promise<unknown>;
}

export interface ImportResult {
  created: number;
  merged: number;
  edited: number;
  unchanged: number;
  failed: Array<{ row: ListRow; error: string }>;
}

// Writes the rows through the existing event routes, one at a time. A failed
// row is reported and the rest go on.
export async function runImport(
  items: Array<{ row: ListRow; choice: Choice }>,
  api: ImportApi,
  leaveOut: Set<string> = new Set(),
  present: ListField[] = [],
): Promise<ImportResult> {
  const result: ImportResult = { created: 0, merged: 0, edited: 0, unchanged: 0, failed: [] };
  // Two rows can fold into one event: the second builds on the first.
  const latest = new Map<string, LoggedEvent>();
  const fromEmail = new Map<string, string>();
  for (const { row, choice } of items) {
    try {
      if (choice.kind === 'skip') continue;
      if (choice.kind === 'edit') {
        const { patch } = editPatch(row, choice.event, present, leaveOut, choice.base, choice.keepApp);
        if (!Object.keys(patch).length) {
          result.unchanged++;
          continue;
        }
        await api.update(choice.event.id, patch);
        result.edited++;
        continue;
      }
      if (choice.kind === 'new') {
        const event = await api.create(row.name);
        await api.update(event.id, newEventPatch(row, leaveOut));
        result.created++;
        continue;
      }
      let event: LoggedEvent | undefined;
      const t = choice.target;
      if (t.kind === 'event') event = latest.get(t.event.id) ?? t.event;
      else if (fromEmail.has(t.row.id)) event = latest.get(fromEmail.get(t.row.id)!);
      else {
        // The show waiting in the email review is added first, so the event
        // keeps the email's own fields and links; your list fills the rest.
        const email = t.row;
        if (email.status === 'skipped') await api.restoreEmail([email.id]);
        const added = await api.addEmail([email.id]);
        event = added.events[0];
        if (!event) throw new Error(`"${email.name}" could not be added from the email review.`);
        fromEmail.set(email.id, event.id);
        latest.set(event.id, event);
      }
      if (!event) throw new Error('The event to merge into is gone.');
      const { patch, adds } = fillPatch(row, event, leaveOut);
      if (!adds.length) {
        if (t.kind === 'email') result.merged++;
        else result.unchanged++;
        continue;
      }
      latest.set(event.id, await api.update(event.id, patch));
      result.merged++;
    } catch (err) {
      result.failed.push({ row, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
