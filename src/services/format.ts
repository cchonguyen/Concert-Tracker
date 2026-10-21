import type { LoggedEvent, SeenAct } from '../server/events/types';
import { eventScale, KIND_LABELS, LineupFacts } from '../server/events/scale';

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

export function placeLabel(e: Pick<LoggedEvent, 'venue' | 'city'>): string | null {
  return [e.venue, e.city].filter(Boolean).join(' · ') || null;
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

// "Concert", "Festival", or empty while it is not known yet.
export function kindLabel(e: LoggedEvent, facts?: LineupFacts): string {
  const kind = eventScale(e, facts).kind;
  return kind ? KIND_LABELS[kind] : '';
}

// One row per event, for a spreadsheet.
export function eventsToCsv(events: LoggedEvent[], editions: Record<string, LineupFacts> = {}): string {
  const header = [
    'Date',
    'End date',
    'Year',
    'Event',
    'Type',
    'Venue',
    'City',
    'Country',
    'Artist',
    'Supporting artists',
    'Saw',
    'Went with',
    'Rating',
    'Ticket price',
    'Notes',
  ];
  const rows = events.map((e) => [
    e.startDate,
    e.endDate,
    e.startDate ? e.startDate.slice(0, 4) : e.year,
    e.name,
    kindLabel(e, editions[e.id]),
    e.venue,
    e.city,
    e.country,
    artistsOf(e.seen).map((s) => s.name).join('; '),
    supportOf(e.seen).map((s) => s.name).join('; '),
    e.seen.map((s) => s.name).join('; '),
    e.companions.join('; '),
    e.rating,
    e.ticketPrice,
    e.notes,
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

export function downloadText(filename: string, text: string, type = 'text/csv'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// The sources that confirm the event's current date, if stage 1 checked it.
// Empty when the date is unchecked, or was changed after the check.
export function dateConfirmations(e: LoggedEvent): LoggedEvent['details']['candidates'][number]['sources'] {
  if (!e.startDate || (e.details.status !== 'matched' && e.details.status !== 'resolved')) return [];
  const c = e.details.candidates[0];
  const covers = c && (c.startDate === e.startDate || (c.startDate && c.endDate && c.startDate <= e.startDate && e.startDate <= c.endDate));
  return covers ? c.sources.filter((s) => s.fields.includes('startDate')) : [];
}
