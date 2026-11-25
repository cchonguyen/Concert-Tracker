// Bulk fill of existing editions' city, state and country (docs/specs/venue-location-fill.md). Owner only.
// Two sources, both read in code, never guessed:
//   - the edition's own city written "City, ST" (splitCity): the same words, split into city and state;
//   - the venue's one known location from the shared venue records (venueLocation).
// Only empty fields are filled; a value already there is never changed. Every write goes through writeEdition with
// a system actor and a reason, so each is logged and can be undone. A venue with several known places is offered
// as choices. When one of those places clearly leads among the shared editions at that venue (leadingPlace), its
// city, state and country are also inferred for the empty fields (docs/specs/inferred-values.md). An inference is
// labelled and stored apart from the edition's own columns, which are never written by it.
import type { Edition, EditionHeader, InferenceInput } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';
import { normalizeName } from '../lineup/text';
import { currentBudget } from '../lineup/budget';
import { splitCity } from '../events/regions';
import { writeEdition } from './editions';
import { inferEditionField } from './inferences';
import { emptyPlaceFields, venueLocationOf, type PlaceFieldName, type VenueLocation, type VenueLocationResult } from './venueLocation';

export const VENUE_FILL_ACTOR = 'system:venue-location';
export const VENUE_INFER_ACTOR = 'system:venue-infer';
export const VENUE_INFER_RULE = 'venue-most-used-place';
const SCAN_LIMIT = 5000;
const SUPPORT_LIMIT = 10;
const LOOKUP_COST = 2; // venue_aliases + canonical_venues
// getEdition (edition row + its acts) 2, upsertEdition up to 5 (series check, edition row, artists,
// clear and re-insert acts), change record 1. Counted low (4) this ran out mid-write on 2026-11-24.
export const WRITE_COST = 8;

type Place = Partial<Record<PlaceFieldName, string>>;

export interface VenueFill {
  editionId: string;
  name: string;
  venue?: string;
  before: Place;
  after: Place; // the place fields once filled
  from: Array<'city' | 'venue'>; // where the new values came from
}

export interface VenueFillChoice {
  editionId: string;
  name: string;
  venue: string;
  before: Place;
  choices: VenueLocation[];
}

export interface VenueFillPlan {
  fills: VenueFill[];
  choices: VenueFillChoice[];
  // Editions with an empty place field that were not looked at because the request budget ran out.
  unchecked: number;
}

const clean = (v: string | undefined | null) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const placeOf = (e: Pick<EditionHeader, 'city' | 'region' | 'country'>): Place => {
  const out: Place = {};
  for (const f of ['city', 'region', 'country'] as const) if (clean(e[f])) out[f] = clean(e[f]);
  return out;
};
const missing = (p: Place) => !p.city || !p.region || !p.country;

function defaultBudgetLeft(): number {
  const b = currentBudget();
  return b ? b.limit - b.reserve - b.used : Number.POSITIVE_INFINITY;
}

// The fill for one edition from its own city text and the venue's lookup result. Null when nothing changes.
export function fillFor(
  e: Pick<EditionHeader, 'id' | 'name' | 'venue' | 'city' | 'region' | 'country'>,
  found: VenueLocationResult,
): { fill: VenueFill | null; choice: VenueFillChoice | null } {
  const before = placeOf(e);
  const from: VenueFill['from'] = [];
  let after: Place = { ...before };
  // "City, ST": the same words, split. A state already stored that disagrees stops the split (splitCity).
  const split = splitCity({ ...before });
  if (split.city !== before.city && split.region) {
    after = { ...after, city: split.city, region: after.region ?? split.region, ...(after.country || !split.country ? {} : { country: split.country }) };
    from.push('city');
  }
  let choice: VenueFillChoice | null = null;
  if (found.kind === 'one') {
    const patch = emptyPlaceFields(after, found.location);
    if (Object.keys(patch).length) {
      after = { ...after, ...patch };
      from.push('venue');
    }
  } else if (found.kind === 'several' && missing(after) && e.venue) {
    const choices = found.choices.filter((c) => Object.keys(emptyPlaceFields(after, c)).length);
    if (choices.length > 1) choice = { editionId: e.id, name: e.name, venue: e.venue, before: after, choices };
  }
  const changed = (['city', 'region', 'country'] as const).some((f) => after[f] !== before[f]);
  return { fill: changed ? { editionId: e.id, name: e.name, venue: clean(e.venue), before, after, from } : null, choice };
}

// The preview: every edition whose empty city, state or country can be filled, and the venues that need a choice.
export async function planVenueFill(
  store: LineupStore,
  opts: { budgetLeft?: () => number; editionIds?: ReadonlySet<string> } = {},
): Promise<VenueFillPlan> {
  const budgetLeft = opts.budgetLeft ?? defaultBudgetLeft;
  const headers = (await store.listEditionHeaders({ limit: SCAN_LIMIT })).filter(
    (e) => (!opts.editionIds || opts.editionIds.has(e.id)) && missing(placeOf(e)),
  );
  const looked = new Map<string, VenueLocationResult>();
  const plan: VenueFillPlan = { fills: [], choices: [], unchecked: 0 };
  for (const e of headers) {
    const venue = clean(e.venue);
    let found: VenueLocationResult = { kind: 'none' };
    if (venue) {
      const key = normalizeName(venue);
      const cached = looked.get(key);
      if (cached) found = cached;
      else if (budgetLeft() < LOOKUP_COST) {
        plan.unchecked++;
        continue;
      } else {
        found = venueLocationOf(await store.listVenuesByAlias(key));
        looked.set(key, found);
      }
    }
    const { fill, choice } = fillFor(e, found);
    if (fill) plan.fills.push(fill);
    if (choice) plan.choices.push(choice);
  }
  return plan;
}

export interface VenueFillResult {
  filled: Array<{ editionId: string; changeId: string | null }>;
  skipped: number; // nothing left to fill (filled or edited since the preview), or unknown
  left: number; // not written because the request budget ran out; run again
}

// Writes the fills for these editions, worked out again now (blanks only). `picks` are the owner's chosen
// locations for venues with several places.
export async function applyVenueFill(
  store: LineupStore,
  input: { editionIds?: string[]; picks?: Array<{ editionId: string; location: VenueLocation }>; actor?: string; budgetLeft?: () => number },
): Promise<VenueFillResult> {
  const budgetLeft = input.budgetLeft ?? defaultBudgetLeft;
  const actor = input.actor ?? VENUE_FILL_ACTOR;
  const result: VenueFillResult = { filled: [], skipped: 0, left: 0 };
  const picks = new Map((input.picks ?? []).map((p) => [p.editionId, p.location]));
  const ids = [...new Set([...(input.editionIds ?? []), ...picks.keys()])];
  for (const id of ids) {
    if (budgetLeft() < WRITE_COST + LOOKUP_COST) {
      result.left++;
      continue;
    }
    const edition = await store.getEdition(id);
    if (!edition) {
      result.skipped++;
      continue;
    }
    const looked: VenueLocationResult = clean(edition.venue)
      ? venueLocationOf(await store.listVenuesByAlias(normalizeName(edition.venue!)))
      : { kind: 'none' };
    // A pick must be one of the places the venue records hold for this venue; anything else is ignored.
    const picked = picks.get(id);
    const pick = picked && looked.kind === 'several' ? looked.choices.find((c) => venueLocationOf([c, picked]).kind === 'one') : undefined;
    const found: VenueLocationResult = pick ? { kind: 'one', location: pick } : looked;
    const { fill } = fillFor(edition, found);
    if (!fill) {
      result.skipped++;
      continue;
    }
    const next: Edition = { ...edition, updatedAt: new Date().toISOString() };
    for (const f of ['city', 'region', 'country'] as const) {
      if (fill.after[f]) next[f] = fill.after[f];
    }
    const why = [
      fill.from.includes('city') ? `state split from the city "${edition.city}"` : '',
      fill.from.includes('venue') ? `location from venue "${edition.venue}"${pick ? ' (chosen by the owner)' : ''}` : '',
    ].filter(Boolean);
    const w = await writeEdition(store, { edition: next, before: edition, actor, reason: `Venue fill: ${why.join('; ')}` });
    result.filled.push({ editionId: id, changeId: w.change?.id ?? null });
  }
  return result;
}

// An edition's own place, with "City, ST" split. Null when it has no city, since such an edition counts for nothing.
function editionPlace(e: Pick<EditionHeader, 'city' | 'region' | 'country'>): VenueLocation | null {
  const split = splitCity({ city: clean(e.city), region: clean(e.region), country: clean(e.country) });
  const city = clean(split.city);
  if (!city) return null;
  const region = clean(split.region);
  const country = clean(split.country);
  return { city, ...(region ? { region } : {}), ...(country ? { country } : {}) };
}

export interface LeadingPlace {
  location: VenueLocation;
  count: number; // editions whose own place is this one
  total: number; // editions counted for exactly one of the places
  editionIds: string[]; // the supporting editions (at most SUPPORT_LIMIT)
}

// The place that most of a venue's editions are in, when it clearly leads: at least 2 editions, and more than all the
// other places together. An edition with no city, or one that matches no place or more than one, counts for nothing.
export function leadingPlace(
  choices: VenueLocation[],
  editionsAtVenue: Array<Pick<EditionHeader, 'id' | 'city' | 'region' | 'country'>>,
): LeadingPlace | null {
  const ids: string[][] = choices.map(() => []);
  for (const e of editionsAtVenue) {
    const place = editionPlace(e);
    if (!place) continue;
    const hits = choices.flatMap((c, i) => (venueLocationOf([c, place]).kind === 'one' ? [i] : []));
    if (hits.length === 1) ids[hits[0]].push(e.id);
  }
  const total = ids.reduce((n, list) => n + list.length, 0);
  let best = -1;
  for (let i = 0; i < ids.length; i++) if (best < 0 || ids[i].length > ids[best].length) best = i;
  if (best < 0) return null;
  const count = ids[best].length;
  if (count < 2 || count <= total - count) return null;
  return { location: choices[best], count, total, editionIds: ids[best].slice(0, SUPPORT_LIMIT) };
}

// Infers the most-used place for the empty city, state and country of the editions at a venue with several places.
// Each inference is written through inferEditionField (a reason, named inputs, logged, undoable).
export async function inferVenuePlaces(
  store: LineupStore,
  opts: { actor?: string; budgetLeft?: () => number; editionIds?: ReadonlySet<string> } = {},
): Promise<{ inferred: Array<{ editionId: string; fields: string[] }>; left: number }> {
  const budgetLeft = opts.budgetLeft ?? defaultBudgetLeft;
  const actor = opts.actor ?? VENUE_INFER_ACTOR;
  const out: { inferred: Array<{ editionId: string; fields: string[] }>; left: number } = { inferred: [], left: 0 };
  const plan = await planVenueFill(store, { budgetLeft, editionIds: opts.editionIds });
  if (!plan.choices.length) return out;
  const headers = await store.listEditionHeaders({ limit: SCAN_LIMIT });
  const groups = new Map<string, EditionHeader[]>();
  for (const h of headers) {
    const v = clean(h.venue);
    if (!v) continue;
    const k = normalizeName(v);
    groups.set(k, [...(groups.get(k) ?? []), h]);
  }
  // The leader per venue, worked out once from the venue records' full list of places.
  const leaders = new Map<string, LeadingPlace | null>();
  for (const c of plan.choices) {
    if (budgetLeft() < WRITE_COST + LOOKUP_COST) {
      out.left++;
      continue;
    }
    const key = normalizeName(c.venue);
    if (!leaders.has(key)) {
      const found = venueLocationOf(await store.listVenuesByAlias(key));
      leaders.set(key, found.kind === 'several' ? leadingPlace(found.choices, groups.get(key) ?? []) : null);
    }
    const leader = leaders.get(key);
    if (!leader) continue;
    const edition = await store.getEdition(c.editionId);
    if (!edition) continue;
    // An edition with a city must be in the leading place; a city elsewhere is never overridden by inference.
    const own = editionPlace(edition);
    if (own && venueLocationOf([leader.location, own]).kind !== 'one') continue;
    const label = [leader.location.city, leader.location.region, leader.location.country].filter(Boolean).join(', ');
    const reason = `Most shared editions at ${c.venue} are in ${label} (${leader.count} of ${leader.total})`;
    const inputs: InferenceInput[] = leader.editionIds.map((id) => ({ kind: 'record' as const, table: 'event_editions', id }));
    const fields: string[] = [];
    for (const f of ['city', 'region', 'country'] as const) {
      const value = leader.location[f];
      if (!value || clean(edition[f])) continue;
      const r = await inferEditionField(store, { edition, field: f, value, reason, rule: VENUE_INFER_RULE, inputs, actor });
      if (r.ok) fields.push(f);
    }
    if (fields.length) out.inferred.push({ editionId: c.editionId, fields });
  }
  return out;
}
