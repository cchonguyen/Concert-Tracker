// Matching shared editions (occurrences) and the one upsert that uses it (slice 11.11).
//
// Matching order (docs/ingest-canon-plan.md):
//   1. A stored external ID: the same edition.
//   2. Same date, same shared venue (by alias), same subject key: the same edition.
//   3. Same date and city but a different or unknown venue: never merged. A merge_suggestion row asks the owner.
// Nothing here guesses: an unknown venue, a missing date or two equal candidates is "no match" or "ambiguous".
// Every edition write goes through writeEdition.
import { randomUUID } from 'node:crypto';
import type { Edition } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';
import { editionKeyFor, normalizeName, seriesSlugFor } from '../lineup/text';
import { writeEdition } from './editions';

const SCAN_LIMIT = 5000;

export interface OccurrenceQuery {
  name?: string;
  startDate?: string;
  venue?: string;
  city?: string;
  subjectKey?: string;
  externalIds?: Array<{ source: string; externalId: string }>;
}

export type MatchResult =
  | { kind: 'same'; edition: Edition; via: 'external_id' | 'date_venue_subject' }
  | { kind: 'ambiguous'; editions: Edition[] }
  | { kind: 'suggest'; editions: Edition[] }
  | { kind: 'none' };

const isVerified = (e: Edition) => e.status === 'verified' || e.status === 'confirmed';
// A draft is the owner's own and is never matched.
const isShared = (e: Edition) => e.status !== 'draft';
const subjectOf = (e: Edition) => e.subjectKey ?? e.seriesSlug;

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
  const onDate = (await store.listEditions(SCAN_LIMIT)).filter((e) => isShared(e) && e.startDate === q.startDate);
  const venueId = await venueIdOf(store, q.venue);
  // Venue unknown or not typed: the venue text decides (empty matches empty), so one (date, subject, venue) is one
  // edition even when no venue is known. Without this, every member entry with no venue created a new edition.
  const venueText = normalizeName(q.venue ?? '');
  const sameVenue = (e: Edition) =>
    venueId ? e.venueId === venueId : venueText ? normalizeName(e.venue ?? '') === venueText : !e.venueId && !e.venue;
  if (q.subjectKey) {
    const same = onDate.filter((e) => e.subjectKey === q.subjectKey && sameVenue(e));
    if (same.length === 1) return { kind: 'same', edition: same[0], via: 'date_venue_subject' };
    if (same.length > 1) return { kind: 'ambiguous', editions: same };
  }
  const city = q.city ? normalizeName(q.city) : '';
  const near = city ? onDate.filter((e) => e.city && normalizeName(e.city) === city) : [];
  return near.length ? { kind: 'suggest', editions: near } : { kind: 'none' };
}

// The lineup pipeline's cache check: a verified edition for this event, found by date and subject, not by key.
// Without a date the one verified edition of the same subject and year can match. Two candidates mean no cache hit.
export async function findVerifiedEdition(
  store: LineupStore,
  q: { eventName: string; year: number; startDate?: string; venue?: string },
): Promise<Edition | null> {
  const slug = seriesSlugFor(q.eventName);
  const all = (await store.listEditions(SCAN_LIMIT)).filter((e) => isVerified(e) && subjectOf(e) === slug);
  let found = q.startDate
    ? all.filter((e) => e.startDate === q.startDate)
    : all.filter((e) => e.year === q.year);
  if (found.length > 1 && q.venue) {
    const venueId = await venueIdOf(store, q.venue);
    if (venueId) found = found.filter((e) => e.venueId === venueId);
  }
  return found.length === 1 ? found[0] : null;
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
  const m = await matchEdition(store, input);
  const now = new Date().toISOString();

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
