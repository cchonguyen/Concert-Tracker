import type { EditionWeekend } from '../server/lineup/types';

const DAY_MS = 86_400_000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKEND_NUMBER_RE = /\b(?:weekend|wknd)\s*([1-9])\b|\bw([1-9])\b/i;

export function isIsoDate(value: string | null | undefined): value is string {
  return typeof value === 'string' && ISO_DATE_RE.test(value.trim());
}

/**
 * Shifts a YYYY-MM-DD date by `days` using UTC arithmetic so DST/local timezone never shifts days.
 */
export function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.trim().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function diffIsoDays(from: string, to: string): number {
  const [fy, fm, fd] = from.trim().split('-').map(Number);
  const [ty, tm, td] = to.trim().split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS);
}

export interface SeedMultiWeekendsInput {
  name?: string;
  startDate?: string | null;
  endDate?: string | null;
  confirmedWeekends?: EditionWeekend[] | null;
}

export interface SeedMultiWeekendsResult {
  weekends: EditionWeekend[];
  draftBadges: Record<number, string>;
}

/**
 * Seeds two weekend rows when switching an edition to multi-weekend mode:
 * - Uses factual `confirmedWeekends` when >= 2 are already available.
 * - Detects an explicit Weekend 1 / Weekend 2 token in `name` (without matching "Vampire Weekend").
 * - Otherwise seeds W2 (+7d) from a short single-weekend date range, or splits an 8-11 day span.
 */
export function seedMultiWeekends({
  name,
  startDate,
  endDate,
  confirmedWeekends,
}: SeedMultiWeekendsInput): SeedMultiWeekendsResult {
  if (confirmedWeekends && confirmedWeekends.length >= 2) {
    return {
      weekends: [...confirmedWeekends]
        .sort((a, b) => a.weekend - b.weekend)
        .map((w) => ({
          weekend: w.weekend,
          startDate: w.startDate,
          ...(w.endDate ? { endDate: w.endDate } : {}),
        })),
      draftBadges: {},
    };
  }

  const match = (name ?? '').match(WEEKEND_NUMBER_RE);
  const detected = match ? Number(match[1] ?? match[2]) : null;
  const start = startDate?.trim() ?? '';
  const end = endDate?.trim() ?? '';
  const hasStart = isIsoDate(start);
  const hasEnd = isIsoDate(end);
  const span = hasStart && hasEnd ? diffIsoDays(start, end) : null;

  if (hasStart && detected === 2) {
    return {
      weekends: [
        {
          weekend: 1,
          startDate: shiftIsoDate(start, -7),
          ...(hasEnd ? { endDate: shiftIsoDate(end, -7) } : {}),
        },
        {
          weekend: 2,
          startDate: start,
          ...(hasEnd ? { endDate: end } : {}),
        },
      ],
      draftBadges: { 1: 'Draft (-7d) — confirm' },
    };
  }

  if (hasStart && (detected === 1 || (!detected && (span === null || (span >= 0 && span <= 4))))) {
    return {
      weekends: [
        {
          weekend: 1,
          startDate: start,
          ...(hasEnd ? { endDate: end } : {}),
        },
        {
          weekend: 2,
          startDate: shiftIsoDate(start, 7),
          ...(hasEnd ? { endDate: shiftIsoDate(end, 7) } : {}),
        },
      ],
      draftBadges: { 2: 'Draft (+7d) — confirm' },
    };
  }

  if (hasStart && hasEnd && !detected && span !== null && span >= 7 && span <= 11) {
    return {
      weekends: [
        {
          weekend: 1,
          startDate: start,
          endDate: shiftIsoDate(end, -7),
        },
        {
          weekend: 2,
          startDate: shiftIsoDate(start, 7),
          endDate: end,
        },
      ],
      draftBadges: {
        1: 'Draft (split) — confirm',
        2: 'Draft (split) — confirm',
      },
    };
  }

  return {
    weekends: [
      { weekend: 1, startDate: '' },
      { weekend: 2, startDate: '' },
    ],
    draftBadges: {},
  };
}
