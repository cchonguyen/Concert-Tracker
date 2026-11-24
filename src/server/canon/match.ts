// Matching shared editions (occurrences) and the one upsert that uses it.
//
// Matching order (docs/ingest-canon-plan.md):
//   1. A stored external ID: the same edition.
//   2. Same date, same shared venue (by alias), same subject key: the same edition.
//   3. Same date and city but a different or unknown venue: never merged. A merge_suggestion row asks the owner.
// Nothing here guesses: an unknown venue, a missing date or two equal candidates is "no match" or "ambiguous".
// Every edition write goes through writeEdition.
import { randomUUID } from 'node:crypto';
import type { Edition, EditionHeader } from '../lineup/types';
import { isVerifiedStatus, type LineupStore } from '../lineup/store/types';
import { editionKeyFor, normalizeName, seriesSlugFor } from '../lineup/text';
import { writeEdition } from './editions';
import { autoMergeZeroLineupGroup } from '../lineup/canonicalIngest';

const SCAN_LIMIT = 5000;
const YEAR_WORD = /^\d{4}$/;

export interface OccurrenceQuery {
  name?: string;
  startDate?: string;
  venue?: string;
  city?: string;
  subjectKey?: string;
  externalIds?: Array<{ source: string; externalId: string }>;
}

export type MatchResult =
  | { kind: 'same'; edition: Edition; via: 'external_id' | 'date_venue_subject'; weekend?: number }
  | { kind: 'ambiguous'; editions: EditionHeader[] }
  | { kind: 'suggest'; editions: EditionHeader[] }
  | { kind: 'none' };

const isVerified = (e: Pick<EditionHeader, 'status'>) => isVerifiedStatus(e.status);
// A draft is the owner's own and is never matched.
const isShared = (e: Pick<EditionHeader, 'status'>) => e.status !== 'draft';
export const subjectOf = (e: Pick<EditionHeader, 'subjectKey' | 'seriesSlug' | 'name'>) =>
  e.subjectKey ?? e.seriesSlug ?? seriesSlugFor(e.name);

const editionCity = (e: Pick<EditionHeader, 'city' | 'seriesKind' | 'seriesCity'>): string | undefined =>
  e.city?.trim() || (e.seriesKind !== 'tour' ? e.seriesCity?.trim() : undefined) || undefined;

export function editionsMatch(a: EditionHeader, b: EditionHeader): boolean {
  if (a.status === 'draft' || b.status === 'draft') return false;
  if (!a.startDate || !b.startDate) return false;
  const subA = subjectOf(a);
  const subB = subjectOf(b);
  if (!subA || subA !== subB) return false;

  const dateMatches =
    a.startDate === b.startDate ||
    editionCoversDate(a, b.startDate).matched ||
    editionCoversDate(b, a.startDate).matched;
  if (!dateMatches) return false;

  const hasVenueIdA = Boolean(a.venueId);
  const hasVenueIdB = Boolean(b.venueId);
  if (hasVenueIdA && hasVenueIdB) {
    return a.venueId === b.venueId;
  }
  const venueA = a.venue?.trim();
  const venueB = b.venue?.trim();
  if (venueA && venueB) {
    if (normalizeName(venueA) !== normalizeName(venueB)) return false;
    const cityA = editionCity(a);
    const cityB = editionCity(b);
    if (cityA && cityB) {
      return normalizeName(cityA) === normalizeName(cityB);
    }
    return true;
  }
  if (!hasVenueIdA && !hasVenueIdB && !venueA && !venueB) {
    const cityA = editionCity(a);
    const cityB = editionCity(b);
    if (cityA && cityB) {
      return normalizeName(cityA) === normalizeName(cityB);
    }
    return false;
  }
  return false;
}

export function editionCoversDate(
  e: Pick<EditionHeader, 'startDate' | 'endDate' | 'weekends'>,
  date: string,
): { matched: boolean; weekend?: number } {
  if (!date) return { matched: false };
  if (e.weekends && e.weekends.length > 0) {
    for (const w of e.weekends) {
      const end = w.endDate ?? w.startDate;
      if (w.startDate <= date && date <= end) return { matched: true, weekend: w.weekend };
    }
    return { matched: false };
  }
  if (!e.startDate) return { matched: false };
  const end = e.endDate ?? e.startDate;
  return e.startDate <= date && date <= end ? { matched: true } : { matched: false };
}

async function venueIdOf(store: LineupStore, venue?: string): Promise<string | null> {
  const n = venue ? normalizeName(venue) : '';
  return n ? (await store.findVenueByAlias(n))?.id ?? null : null;
}

export async function matchEdition(store: LineupStore, q: OccurrenceQuery): Promise<MatchResult> {
  for (const x of q.externalIds ?? []) {
    const hit = await store.findEditionByExternalId(x.source, x.externalId);
    if (hit && isShared(hit)) return { kind: 'same', edition: hit, via: 'external_id' };
  }
  if (!q.startDate) return { kind: 'none' };
  const headers = await store.listEditionHeaders({ limit: SCAN_LIMIT });
  const onDate = headers
    .filter((e) => isShared(e))
    .map((e) => ({ edition: e, cover: editionCoversDate(e, q.startDate!) }))
    .filter((x) => x.cover.matched);
  const venueId = await venueIdOf(store, q.venue);
  // Venue unknown or not typed: the venue text decides (empty matches empty), so one (date, subject, venue) is one
  // edition even when no venue is known. Without this, every member entry with no venue created a new edition.
  const venueText = normalizeName(q.venue ?? '');
  const sameVenue = (e: EditionHeader) =>
    venueId ? e.venueId === venueId : venueText ? normalizeName(e.venue ?? '') === venueText : !e.venueId && !e.venue;
  if (q.subjectKey) {
    const same = onDate.filter((x) => subjectOf(x.edition) === q.subjectKey && sameVenue(x.edition));
    if (same.length === 1) {
      const full = await store.getEdition(same[0].edition.id);
      if (full) {
        return {
          kind: 'same',
          edition: full,
          via: 'date_venue_subject',
          ...(same[0].cover.weekend !== undefined ? { weekend: same[0].cover.weekend } : {}),
        };
      }
    }
    if (same.length > 1) return { kind: 'ambiguous', editions: same.map((x) => x.edition) };
  }
  const city = q.city ? normalizeName(q.city) : '';
  const near = city
    ? onDate
        .filter((x) => {
          const ec = editionCity(x.edition);
          return ec && normalizeName(ec) === city;
        })
        .map((x) => x.edition)
    : [];
  return near.length ? { kind: 'suggest', editions: near } : { kind: 'none' };
}

// The lineup pipeline's cache check: a verified edition for this event, found by date and subject, not by key.
// Without a date the one verified edition of the same subject and year can match. Two candidates mean no cache hit.
export async function findVerifiedEdition(
  store: LineupStore,
  q: { eventName: string; year: number; startDate?: string; venue?: string },
): Promise<Edition | null> {
  const slug = seriesSlugFor(q.eventName);
  const all = (await store.listEditionHeaders({ limit: SCAN_LIMIT, status: 'verified' })).filter(
    (e) => isVerified(e) && subjectOf(e) === slug,
  );
  let found = q.startDate
    ? all.filter((e) => editionCoversDate(e, q.startDate!).matched)
    : all.filter((e) => e.year === q.year);
  if (found.length > 1 && q.venue) {
    const venueId = await venueIdOf(store, q.venue);
    if (venueId) found = found.filter((e) => e.venueId === venueId);
  }
  return found.length === 1 ? store.getEdition(found[0].id) : null;
}

export interface SeriesEditionMatchQuery {
  name: string;
  year?: number;
  startDate?: string;
  venue?: string;
  city?: string;
  weekend?: number;
}

const cityPart = (s: string) => normalizeName(s.split(',')[0] ?? s);

export async function findSeriesEditionMatches(store: LineupStore, q: SeriesEditionMatchQuery): Promise<EditionHeader[]> {
  const tokens = normalizeName(q.name).split(' ').filter(Boolean);
  const queryYears = new Set(tokens.filter((t) => YEAR_WORD.test(t)).map(Number));
  const words = tokens.filter((t) => !YEAR_WORD.test(t));
  if (words.length === 0) return [];

  const headers = await store.listEditionHeaders({
    limit: SCAN_LIMIT,
    status: 'verified',
    ...(q.year !== undefined ? { year: q.year } : {}),
  });

  const qv = q.venue ? normalizeName(q.venue) : '';
  const qc = q.city ? cityPart(q.city) : '';

  return headers
    .filter((e) => {
      if (!isVerified(e) || !e.seriesSlug) return false;
      if (q.year !== undefined && e.year !== q.year) return false;
      if (q.year === undefined && !q.startDate && queryYears.size > 0 && !queryYears.has(e.year)) return false;

      const haystack = normalizeName(`${e.name} ${e.seriesName ?? ''} ${e.seriesBrand ?? ''} ${(e.seriesAliases ?? []).join(' ')}`)
        .split(' ')
        .filter(Boolean);
      if (!words.every((w) => haystack.some((h) => h.startsWith(w)))) return false;

      if (q.weekend !== undefined) {
        if (e.weekends && e.weekends.length > 0) {
          if (!e.weekends.some((w) => w.weekend === q.weekend)) return false;
        } else if (q.weekend > 1) {
          return false;
        }
      }

      if (q.startDate) {
        const cover = editionCoversDate(e, q.startDate);
        if (!cover.matched) return false;
        if (q.weekend !== undefined && cover.weekend !== undefined && cover.weekend !== q.weekend) return false;
      }

      const ev = e.venue ? normalizeName(e.venue) : '';
      if (qv && ev && !(qv === ev || ev.includes(qv) || qv.includes(ev))) return false;

      const rawCity = editionCity(e);
      const ec = rawCity ? cityPart(rawCity) : '';
      if (qc && ec && !(qc === ec || ec.includes(qc) || qc.includes(ec))) return false;

      return true;
    })
    .sort((a, b) => b.year - a.year || (b.startDate ?? '').localeCompare(a.startDate ?? '') || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export interface UpsertOccurrenceInput extends OccurrenceQuery {
  name: string;
  endDate?: string;
  country?: string;
  hasLineup?: boolean;
  // 'verified' for a ticket email import or canonical ingest; 'provisional' for a member's own entry.
  trust: 'verified' | 'provisional';
  actor: string;
  reason: string;
}

export interface UpsertOccurrenceResult {
  action: 'created' | 'updated' | 'unchanged' | 'ambiguous' | 'skipped_no_date';
  edition?: Edition;
  suggestedWith?: string[];
}

const empty = (v: unknown) => v === undefined || v === null || v === '';

// Verified source: fills empty fields and may replace a provisional edition's name, venue and city; it promotes
// provisional to verified. It never overwrites another verified edition's values.
// Provisional source: fills empty fields only; it never changes a status and never replaces a value.
export async function upsertOccurrence(store: LineupStore, input: UpsertOccurrenceInput): Promise<UpsertOccurrenceResult> {
  if (!input.startDate) return { action: 'skipped_no_date' };
  const name = input.name.trim();
  if (!name) return { action: 'skipped_no_date' };
  let m = await matchEdition(store, input);
  const now = new Date().toISOString();

  if (m.kind === 'ambiguous') {
    const autoMerged = await autoMergeZeroLineupGroup(store, m.editions, {
      actor: 'system:auto-merge',
      reason: 'Auto-merge zero-lineup duplicate into matching verified edition',
    });
    if (autoMerged) {
      const fullKeep = await store.getEdition(autoMerged.keep.id);
      if (fullKeep) {
        m = { kind: 'same', edition: fullKeep, via: 'date_venue_subject' };
      }
    }
  }

  if (m.kind === 'ambiguous') {
    await queueSuggestion(store, m.editions.map((e) => e.id), undefined, input);
    return { action: 'ambiguous', suggestedWith: m.editions.map((e) => e.id) };
  }

  const getVenue = async () => (input.venue?.trim() ? store.upsertVenue({ name: input.venue.trim(), city: input.city, country: input.country }) : null);

  if (m.kind === 'same') {
    const cur = m.edition;
    // A venue is looked up only when the edition has none; a matched edition keeps the venue it matched on.
    const venueRow = cur.venueId ? null : await getVenue();
    const next: Edition = { ...cur, updatedAt: now };
    const replace = input.trust === 'verified' && !isVerified(cur);
    const put = <K extends 'name' | 'venue' | 'city' | 'country' | 'endDate' | 'venueId' | 'subjectKey' | 'hasLineup'>(k: K, v: Edition[K]) => {
      if (empty(v)) return;
      if (empty(cur[k]) || (replace && k !== 'subjectKey' && k !== 'hasLineup')) next[k] = v;
    };
    put('name', name);
    put('endDate', input.endDate);
    put('venue', input.venue?.trim());
    put('city', input.city?.trim());
    put('country', input.country?.trim());
    put('venueId', venueRow?.id);
    put('subjectKey', input.subjectKey);
    put('hasLineup', input.hasLineup);
    if (replace) next.status = 'verified';
    const w = await writeEdition(store, { edition: next, actor: input.actor, reason: input.reason });
    await attachExternalIds(store, cur.id, input);
    return { action: w.changed ? 'updated' : 'unchanged', edition: w.changed ? next : cur };
  }

  const venueRow = await getVenue();
  const year = Number(input.startDate.slice(0, 4));
  let key = editionKeyFor(name, year, input.startDate);
  const id = randomUUID();
  if (await store.getEditionByKey(key)) key = `${key}-${id.slice(0, 8)}`;
  const created: Edition = {
    id,
    key,
    seriesSlug: seriesSlugFor(name),
    year,
    name,
    startDate: input.startDate,
    ...(input.endDate ? { endDate: input.endDate } : {}),
    ...(input.venue?.trim() ? { venue: input.venue.trim() } : {}),
    ...(input.city?.trim() ? { city: input.city.trim() } : {}),
    ...(input.country?.trim() ? { country: input.country.trim() } : {}),
    status: input.trust,
    ...(venueRow ? { venueId: venueRow.id } : {}),
    ...(input.subjectKey ? { subjectKey: input.subjectKey } : {}),
    ...(input.hasLineup !== undefined ? { hasLineup: input.hasLineup } : {}),
    performances: [],
    updatedAt: now,
  };
  await writeEdition(store, { edition: created, actor: input.actor, reason: input.reason });
  await attachExternalIds(store, id, input);
  if (m.kind === 'suggest') await queueSuggestion(store, m.editions.map((e) => e.id), id, input);
  return { action: 'created', edition: created, ...(m.kind === 'suggest' ? { suggestedWith: m.editions.map((e) => e.id) } : {}) };
}

async function attachExternalIds(store: LineupStore, editionId: string, input: OccurrenceQuery) {
  for (const x of input.externalIds ?? []) await store.addEditionExternalId(editionId, x.source, x.externalId);
}

// One open row per incoming edition: the owner decides. Payload holds edition ids, date and city only.
async function queueSuggestion(store: LineupStore, existingIds: string[], incomingId: string | undefined, input: OccurrenceQuery) {
  const anchor = incomingId ?? existingIds[0];
  const open = await store.listReviewItems({ status: 'open', kind: 'merge_suggestion' });
  if (open.some((r) => r.editionId === anchor && JSON.stringify((r.payload as any)?.editionIds) === JSON.stringify(existingIds))) return;
  await store.addReviewItem({
    kind: 'merge_suggestion',
    editionId: anchor,
    payload: { editionIds: existingIds, startDate: input.startDate ?? null, city: input.city ?? null, venue: input.venue ?? null },
  });
}
