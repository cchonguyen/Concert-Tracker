// The source rows of the Check details card. Pure, so the rows can be tested against the reply alone.
import type { DetailCandidate, DetailsStatus } from '../server/events/types';

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
