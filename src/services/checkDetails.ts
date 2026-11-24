// The source rows of the Check details card. Pure, so the rows can be tested against the reply alone.
import type { DetailCandidate, DetailsStatus } from '../server/events/types';
import { MONTH_SHORT } from '../server/lineup/months';

export const CHECK_SOURCES = [
  { type: 'ticketmaster', label: 'Ticketmaster' },
  { type: 'setlistfm', label: 'setlist.fm' },
  { type: 'clashfinder', label: 'Clashfinder' },
] as const;

export type CheckRowState = 'checking' | 'found' | 'none' | 'off';
export interface CheckRow {
  label: string;
  state: CheckRowState;
}

// While a check runs, every row says checking. Afterwards a row says what the reply supports: found when a candidate
// came from that source, not set up when the source is switched off, no listing when the check ran and it did not
// come up. A reply that did not search (needs a date first) gives no rows.
export function checkRows(input: {
  busy: boolean;
  checkedAt?: string;
  status: DetailsStatus;
  candidates: DetailCandidate[];
  enabled: (type: string) => boolean | undefined;
}): CheckRow[] {
  if (input.busy) return CHECK_SOURCES.map((s) => ({ label: s.label, state: 'checking' }));
  if (!input.checkedAt || input.status === 'needs_date') return [];
  return CHECK_SOURCES.map((s) => {
    if (input.status === 'off' || input.enabled(s.type) === false) return { label: s.label, state: 'off' };
    const found = input.candidates.some((c) => c.sources.some((src) => src.sourceType === s.type));
    return { label: s.label, state: found ? 'found' : 'none' };
  });
}

// "Checked today", "Checked 1 day ago", "Checked 3 days ago" from the stored check time.
export function checkedLabel(checkedAt: string | undefined, now: number): string | null {
  if (!checkedAt) return null;
  const then = Date.parse(checkedAt);
  if (Number.isNaN(then)) return null;
  const days = Math.floor(Math.max(0, now - then) / 86_400_000);
  if (days < 1) return 'Checked today';
  return days === 1 ? 'Checked 1 day ago' : `Checked ${days} days ago`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = MONTH_SHORT;

// Shows only what the date says: a full date gets its weekday (worked out from that date alone), a month or a year
// shows as given with no weekday, anything else is missing.
export function candidateDateLabel(date: string | undefined): string | null {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(date?.trim() ?? '');
  if (!m) return null;
  const year = Number(m[1]);
  if (!m[2]) return String(year);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  if (!m[3]) return `${MONTHS[month - 1]} ${year}`;
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${WEEKDAYS[d.getUTCDay()]} ${day} ${MONTHS[month - 1]} ${year}`;
}

export interface CandidateRowParts {
  name: string;
  date: string;
  venue: string;
  place: string;
  sourceCount: number;
  sourceText: string;
}

// The words for one picker row. Missing fields are named as missing, never guessed. Sources that agree are counted by page.
export function candidateRowParts(c: DetailCandidate): CandidateRowParts {
  const place = [c.city, c.region].map((p) => p?.trim()).filter((p): p is string => Boolean(p));
  const sourceCount = new Set(c.sources.map((s) => s.sourceUrl || s.sourceType)).size;
  return {
    name: c.name?.trim() || 'No name given',
    date: candidateDateLabel(c.startDate) ?? 'no date yet',
    venue: c.venue?.trim() || 'no venue yet',
    place: place.length ? place.join(', ') : 'no city yet',
    sourceCount,
    sourceText: sourceCount === 1 ? '1 source' : `${sourceCount} sources`,
  };
}
