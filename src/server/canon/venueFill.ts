// Bulk fill of existing editions' city, state and country (docs/specs/venue-location-fill.md). Owner only.
// Two sources, both read in code, never guessed:
//   - the edition's own city written "City, ST" (splitCity): the same words, split into city and state;
//   - the venue's one known location from the shared venue records (venueLocation).
// Only empty fields are filled; a value already there is never changed. Every write goes through writeEdition with
// a system actor and a reason, so each is logged and can be undone. A venue with several known places is offered
// as choices, never filled on its own.
import type { Edition, EditionHeader } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';
import { normalizeName } from '../lineup/text';
import { currentBudget } from '../lineup/budget';
import { splitCity } from '../events/regions';
import { writeEdition } from './editions';
import { emptyPlaceFields, samePlace, venueLocationOf, type PlaceFieldName, type VenueLocation, type VenueLocationResult } from './venueLocation';

export const VENUE_FILL_ACTOR = 'system:venue-location';
const SCAN_LIMIT = 5000;
const LOOKUP_COST = 2; // venue_aliases + canonical_venues
const WRITE_COST = 4; // getEdition, upsert, change record, margin

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
    const pick = picked && looked.kind === 'several' ? looked.choices.find((c) => samePlace(c, picked)) : undefined;
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
