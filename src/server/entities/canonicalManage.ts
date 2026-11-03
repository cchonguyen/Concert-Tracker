import type { ArtistIdentity, Edition } from '../lineup/types';
import { normalizeName } from '../lineup/text';

// Canonical editions for the owner's Global Archive (spec Phase 1).
// Only shared facts: no personal attendance, prices, notes or companions.
// Only confirmed editions are shown to members' suggestions (owner sees both).

// The newest editions the archive loads in one request (Workers' subrequest budget).
export const CANONICAL_EDITION_LIMIT = 200;

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

// Only the owner may use /api/manage/canonical/* (spec section 5). Members get 403.
export const isOwner = (member: { role?: string } | null | undefined): boolean => member?.role === 'owner';

export type ArtistOrigin = 'from_me' | 'community_import' | 'unmanaged_fetch';

export interface CanonicalArtistSummary {
  key: string;
  name: string;
  mbid: string | null;
  origins: ArtistOrigin[];
  editionsCount: number;
  // Null until the cross-member "seen" aggregate exists. Never a guessed zero.
  communityCount: number | null;
}

// Unifies the owner's catalog (spec 3.2). Counts only; no member names.
// origins: from_me = in the owner's own seen names; unmanaged_fetch = in
// canonical_artists; community_import is not set until the aggregate exists.
export function unifyArtists(input: {
  canonical: ArtistIdentity[];
  ownerNames: string[];
  editions: Edition[];
  // From communityCounts(): name key -> members. Omit or null leaves communityCount null.
  communityCounts?: Map<string, number> | null;
}): CanonicalArtistSummary[] {
  const byKey = new Map<string, CanonicalArtistSummary>();
  const ensure = (key: string, name: string, mbid?: string): CanonicalArtistSummary => {
    let row = byKey.get(key);
    if (!row) {
      row = { key, name, mbid: mbid ?? null, origins: [], editionsCount: 0, communityCount: null };
      byKey.set(key, row);
    }
    return row;
  };
  for (const a of input.canonical) {
    const row = ensure(a.key, a.name, a.mbid);
    if (!row.origins.includes('unmanaged_fetch')) row.origins.push('unmanaged_fetch');
  }
  for (const n of input.ownerNames) {
    const key = normalizeName(n);
    if (!key) continue;
    const row = ensure(key, n);
    if (!row.origins.includes('from_me')) row.origins.push('from_me');
  }
  for (const e of input.editions) {
    if (e.status !== 'confirmed') continue;
    for (const p of e.performances) {
      const row = byKey.get(p.artistKey);
      if (row) row.editionsCount += 1;
    }
  }
  // With counts, every row gets a number (0 when no live event has it). Without, null: unknown, not zero.
  if (input.communityCounts) {
    for (const row of byKey.values()) row.communityCount = input.communityCounts.get(row.key) ?? 0;
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// The acts of one canonical artist across editions (for the artist detail view).
export interface ArtistAppearance {
  editionId: string;
  editionName: string;
  year: number;
  startDate: string | null;
  venue: string | null;
  city: string | null;
  status: Edition['status'];
  billing: string | null;
  set: string | null;
  days: string[];
  stages: string[];
}

export function appearancesOf(editions: Edition[], artistKey: string): ArtistAppearance[] {
  const out: ArtistAppearance[] = [];
  for (const e of editions) {
    for (const p of e.performances) {
      if (p.artistKey !== artistKey) continue;
      out.push({
        editionId: e.id,
        editionName: e.name,
        year: e.year,
        startDate: e.startDate ?? null,
        venue: e.venue ?? null,
        city: e.city ?? null,
        status: e.status,
        billing: p.billing ?? null,
        set: p.set ?? null,
        days: p.days,
        stages: p.stages,
      });
    }
  }
  return out.sort((a, b) => b.year - a.year || a.editionName.localeCompare(b.editionName));
}
