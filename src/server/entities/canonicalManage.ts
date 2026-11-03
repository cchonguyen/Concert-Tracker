import type { Edition } from '../lineup/types';

// Canonical editions for the owner's Global Archive (spec Phase 1).
// Only shared facts: no personal attendance, prices, notes or companions.
// Only confirmed editions are shown to members' suggestions (owner sees both).

export type EditionStatusFilter = 'all' | 'confirmed' | 'draft';

export interface CanonicalEditionSummary {
  id: string;
  key: string;
  seriesSlug: string;
  year: number;
  name: string;
  startDate: string | null;
  endDate: string | null;
  venue: string | null;
  city: string | null;
  status: Edition['status'];
  performanceCount: number;
  hasSetTimes: boolean;
}

export function summarizeEdition(e: Edition): CanonicalEditionSummary {
  return {
    id: e.id,
    key: e.key,
    seriesSlug: e.seriesSlug,
    year: e.year,
    name: e.name,
    startDate: e.startDate ?? null,
    endDate: e.endDate ?? null,
    venue: e.venue ?? null,
    city: e.city ?? null,
    status: e.status,
    performanceCount: e.performances.length,
    // Set times exist only where a source timed them (AGENTS.md): a set is timed when it has days or stages.
    hasSetTimes: e.performances.some((p) => p.days.length > 0 || p.stages.length > 0),
  };
}

// Filters and sorts the editions: newest year first, then name.
export function listCanonicalEditions(editions: Edition[], opts: { query?: string; status?: EditionStatusFilter } = {}): CanonicalEditionSummary[] {
  const status = opts.status ?? 'all';
  const q = (opts.query ?? '').trim().toLowerCase();
  return editions
    .filter((e) => status === 'all' || e.status === status)
    .filter((e) => !q || [e.name, e.seriesSlug, e.venue ?? ''].some((s) => s.toLowerCase().includes(q)))
    .map(summarizeEdition)
    .sort((a, b) => b.year - a.year || a.name.localeCompare(b.name));
}
