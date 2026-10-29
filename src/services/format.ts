import type { LoggedEvent, SeenAct, WeatherDay } from '../server/events/types';
import { isCiphertext } from './vault';
import { eventScale, KIND_LABELS, LineupFacts } from '../server/events/scale';
import { norm } from './listImport';
import { seenSlots, slotLabel } from '../server/events/seen';
import { cityWithRegion } from '../server/events/regions';
import { attendanceOf, AttendanceState } from '../server/events/attendance';

const day = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });

// "Sat, Oct 5, 2024", "May 16 – 18, 2025", "Oct 2024", "2024", or null when unknown.
export function whenLabel(e: Pick<LoggedEvent, 'startDate' | 'endDate' | 'year' | 'month'>): string | null {
  if (e.startDate && e.endDate && e.endDate !== e.startDate) {
    const sameMonth = e.startDate.slice(0, 7) === e.endDate.slice(0, 7);
    const start = day(e.startDate, { month: 'short', day: 'numeric' });
    const end = sameMonth ? String(Number(e.endDate.slice(8))) : day(e.endDate, { month: 'short', day: 'numeric' });
    return `${start} – ${end}, ${e.endDate.slice(0, 4)}`;
  }
  if (e.startDate) return day(e.startDate, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  if (e.year && e.month) return day(`${e.year}-${String(e.month).padStart(2, '0')}-01`, { month: 'short', year: 'numeric' });
  if (e.year) return String(e.year);
  return null;
}

// Format holds one or more values in your words, stored as one text field
// separated by commas ("Club night, Rave"), so the CSV and the sheet keep it
// in one column.
export function formatsOf(format?: string | null): string[] {
  const seen = new Set<string>();
  return (format ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
}

export const joinFormats = (formats: string[]): string | null => formatsOf(formats.join(',')).join(', ') || null;

export function placeLabel(e: Pick<LoggedEvent, 'venue' | 'city' | 'region'>): string | null {
  return [e.venue, cityWithRegion(e.city, e.region)].filter(Boolean).join(' · ') || null;
}

export function eventYear(e: LoggedEvent): number | null {
  return e.startDate ? Number(e.startDate.slice(0, 4)) : e.year ?? null;
}

export function datesBetween(start?: string, end?: string): string[] {
  if (!start) return [];
  const out: string[] = [];
  const cur = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end || start}T00:00:00Z`);
  while (cur <= last && out.length < 14) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Who you saw, split the way the event shows it: Artist is the headliners
// plus every act with no role stated; Supporting only acts billed as support.
export const artistsOf = (seen: SeenAct[]) => seen.filter((s) => s.role !== 'support');
export const supportOf = (seen: SeenAct[]) => seen.filter((s) => s.role === 'support');

// Names you've entered on your events, most used first, one spelling each
// (the one you used most).
function pastNames(names: string[][]): string[] {
  const byKey = new Map<string, { count: number; names: Map<string, number> }>();
  for (const list of names) {
    for (const name of list) {
      const k = norm(name);
      if (!k) continue;
      const entry = byKey.get(k) ?? { count: 0, names: new Map() };
      entry.count += 1;
      entry.names.set(name, (entry.names.get(name) ?? 0) + 1);
      byKey.set(k, entry);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.count - a.count)
    .map((e) => [...e.names.entries()].sort((a, b) => b[1] - a[1])[0][0]);
}

// Acts you've seen and people you went with, across your events.
export const pastArtistNames = (events: LoggedEvent[]) => pastNames(events.map((e) => e.seen.map((s) => s.name)));
export const pastCompanionNames = (events: LoggedEvent[]) => pastNames(events.map((e) => e.companions));

// Names matching what you're typing: those starting with it first, then
// those with a word starting with it. Names already on the event are left out.
export function matchNames(query: string, names: string[], exclude: Set<string>, limit = 8): string[] {
  const q = norm(query);
  if (!q) return [];
  const starts: string[] = [];
  const words: string[] = [];
  for (const n of names) {
    const k = norm(n);
    if (exclude.has(k)) continue;
    if (k.startsWith(q)) starts.push(n);
    else if (` ${k}`.includes(` ${q}`)) words.push(n);
  }
  return [...starts, ...words].slice(0, limit);
}

// What a suggestion field lists under the input: the first few when it is
// empty (as a browser's own list does on focus), else the matches for what
// you typed, leaving out the value already there.
export function suggestionsFor(query: string, suggestions: string[], limit = 8): string[] {
  if (!norm(query)) return suggestions.slice(0, limit);
  return matchNames(query, suggestions, new Set([norm(query)]), limit);
}

export const favouriteOf = (seen: SeenAct[]) => seen.find((s) => s.favourite);

// WMO weather codes, as Open-Meteo reports them.
export function weatherWord(code?: number): string {
  if (code === undefined) return '';
  if (code === 0) return 'Clear';
  if (code === 1) return 'Mainly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'Rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'Snow';
  if (code >= 95) return 'Thunderstorm';
  return '';
}

const f = (c: number) => Math.round((c * 9) / 5 + 32);

// "Clear · 31°/22°C (88°/72°F) · 2 mm"
export function weatherLine(d: WeatherDay): string {
  const temps =
    d.high !== undefined && d.low !== undefined
      ? `${Math.round(d.high)}°/${Math.round(d.low)}°C (${f(d.high)}°/${f(d.low)}°F)`
      : d.high !== undefined
        ? `${Math.round(d.high)}°C (${f(d.high)}°F)`
        : '';
  const rain = d.precipitation ? `${Math.round(d.precipitation * 10) / 10} mm` : '';
  return [weatherWord(d.code), temps, rain].filter(Boolean).join(' · ');
}

export function weatherText(e: LoggedEvent): string {
  const days = e.weather?.days ?? [];
  if (days.length === 1) return weatherLine(days[0]);
  return days.map((d) => `${day(d.date, { month: 'short', day: 'numeric' })}: ${weatherLine(d)}`).join('; ');
}

// "Concert", "Festival", or empty while it is not known yet.
export function kindLabel(e: LoggedEvent, facts?: LineupFacts): string {
  const kind = eventScale(e, facts).kind;
  return kind ? KIND_LABELS[kind] : '';
}

export type SheetCell = string | number | undefined;

const WENT_CELL: Record<AttendanceState, string> = { went: 'Yes', upcoming: 'Upcoming', confirm: 'Not confirmed', missed: 'No' };

// One row per event, for a spreadsheet: the CSV export and the linked Google
// Sheet. "ID" is last so a sheet or file read back matches each row to its
// event ("Import a list", "Sync with Google Sheets").
export function eventRows(
  events: LoggedEvent[],
  editions: Record<string, LineupFacts> = {},
): { header: string[]; rows: SheetCell[][] } {
  const header = [
    'Date',
    'End date',
    'Year',
    'Event',
    'Series',
    'Weekend',
    'Type',
    // Worked out, not read back: Yes, Upcoming, Not confirmed or No.
    'Went',
    'Format',
    'Venue',
    'City',
    'State',
    'Country',
    // "Saw" comes first so reading this file back ("Import a list") takes every act.
    'Saw',
    'Artist',
    'Supporting artists',
    'Favourite set',
    'Sets',
    'Went with',
    'Rating',
    'Ticket price',
    'Weather',
    'Notes',
    'ID',
  ];
  const today = new Date().toISOString().slice(0, 10);
  const rows = events.map((e) => [
    e.startDate,
    e.endDate,
    e.startDate ? Number(e.startDate.slice(0, 4)) : e.year,
    e.name,
    e.series,
    e.weekend,
    kindLabel(e, editions[e.id]),
    WENT_CELL[attendanceOf(e, today)],
    e.format,
    e.venue,
    e.city,
    e.region,
    e.country,
    e.seen.map((s) => s.name).join('; '),
    artistsOf(e.seen).map((s) => s.name).join('; '),
    supportOf(e.seen).map((s) => s.name).join('; '),
    favouriteOf(e.seen)?.name,
    seenSlots(e.seen)
      .filter((slot) => slot.length > 1 || slot[0].set || slot[0].asSolo)
      .map(slotLabel)
      .join('; '),
    e.companions.join('; '),
    e.rating,
    e.ticketPrice,
    weatherText(e),
    // An encrypted note is not exported: only your browser can read it.
    isCiphertext(e.notes) ? '' : e.notes,
    e.id,
  ]);
  return { header, rows };
}

export function eventsToCsv(events: LoggedEvent[], editions: Record<string, LineupFacts> = {}): string {
  const { header, rows } = eventRows(events, editions);
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

// The sources that confirm the event's current date, if stage 1 checked it.
// Empty when the date is unchecked, or was changed after the check.
export function dateConfirmations(e: LoggedEvent): LoggedEvent['details']['candidates'][number]['sources'] {
  if (!e.startDate || (e.details.status !== 'matched' && e.details.status !== 'resolved')) return [];
  const c = e.details.candidates[0];
  const covers = c && (c.startDate === e.startDate || (c.startDate && c.endDate && c.startDate <= e.startDate && e.startDate <= c.endDate));
  return covers ? c.sources.filter((s) => s.fields.includes('startDate')) : [];
}
