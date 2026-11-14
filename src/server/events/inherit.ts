// Inheritance for events linked to a shared edition (slice 11.12; docs/ingest-canon-plan.md).
//
// A linked event shows the edition's value for a shared field unless the person overrode that field.
// What they first typed is kept in `captured` (written once, never deleted). The event's own columns
// always hold the person's own latest value, so unlinking can fall back to them.
//
//   resolved field = override, else the edition's value (when it has one), else the event's own value.
//   unlinked field = override, else captured, else the event's own value.
//
// Nothing here calls a model, writes an edition or invents a value. Review rows carry only ids, the field
// name and the old and new public value; never a personal field.
import type { Edition, ReviewQueueItem } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';
import type { CapturedFields, EventOverrides } from '../lineup/types';
import type { LoggedEvent } from './types';
import { applyPatch, EventPatch } from './service';

type Shared = 'name' | 'startDate' | 'endDate' | 'venue' | 'city' | 'country';
// Event field, key in captured/overrides, and the edition field it follows.
const SHARED: Array<{ field: Shared; key: keyof CapturedFields }> = [
  { field: 'name', key: 'name' },
  { field: 'startDate', key: 'start_date' },
  { field: 'endDate', key: 'end_date' },
  { field: 'venue', key: 'venue' },
  { field: 'city', key: 'city' },
  { field: 'country', key: 'country' },
];

const clean = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

// The shared-fact fields as they stand now.
export function capturedFrom(e: LoggedEvent): CapturedFields {
  return {
    name: e.name,
    year: e.year ?? null,
    month: e.month ?? null,
    start_date: e.startDate ?? null,
    end_date: e.endDate ?? null,
    venue: e.venue ?? null,
    city: e.city ?? null,
    region: e.region ?? null,
    country: e.country ?? null,
  };
}

// Written once: an event that already has captured keeps it.
export function ensureCaptured(e: LoggedEvent): LoggedEvent {
  return e.captured ? e : { ...e, captured: capturedFrom(e) };
}

// What a reader sees. Without an edition (or when it is not loaded) the event's own values stand.
export function resolveEvent(e: LoggedEvent, edition: Edition | null | undefined): LoggedEvent {
  if (!e.editionId || !edition || edition.id !== e.editionId) return e;
  const out: LoggedEvent = { ...e };
  const overrides = e.overrides ?? {};
  for (const { field, key } of SHARED) {
    if (key in overrides) (out as any)[field] = overrides[key] ?? undefined;
    else {
      const v = clean(edition[field]);
      if (v !== undefined) (out as any)[field] = v;
    }
  }
  if (out.startDate !== e.startDate && out.startDate) {
    out.year = Number(out.startDate.slice(0, 4));
    out.month = undefined;
  }
  return out;
}

export const resolveEvents = (events: LoggedEvent[], editions: Edition[]): LoggedEvent[] => {
  const byId = new Map(editions.map((ed) => [ed.id, ed]));
  return events.map((e) => resolveEvent(e, e.editionId ? byId.get(e.editionId) : undefined));
};

export interface OverrideChange {
  field: Shared;
  old: string | null; // the edition's public value
  new: string | null;
}

export interface LinkedPatchResult {
  event: LoggedEvent;
  changes: OverrideChange[]; // new overrides, one review row each
}

// Applies a patch. Unlinked: the person's own values change and captured stays as first written.
// Linked: a shared field that ends up different from what the person saw becomes an override (or drops
// its override when it now equals the edition's value); the event's own columns keep the person's value.
// With `recapture`, an event never edited since it was created takes this patch as what was first
// imported, once.
export function applyLinkedPatch(
  event: LoggedEvent,
  edition: Edition | null,
  patch: EventPatch,
  now: Date,
  opts: { recapture?: boolean } = {},
): LinkedPatchResult {
  const base = ensureCaptured(event);
  const linked = Boolean(base.editionId && edition && edition.id === base.editionId);
  if (!linked) {
    let next = applyPatch(base, patch, now);
    if (opts.recapture && event.updatedAt === event.createdAt && !event.editionId) next = { ...next, captured: capturedFrom(next) };
    return { event: next, changes: [] };
  }
  const seen = resolveEvent(base, edition);
  const patched = applyPatch(seen, patch, now);
  const overrides: EventOverrides = { ...(base.overrides ?? {}) };
  const changes: OverrideChange[] = [];
  const next: LoggedEvent = { ...patched };
  for (const { field, key } of SHARED) {
    const before = clean(seen[field]);
    const after = clean(patched[field]);
    if (field in patch && before !== after) {
      const fromEdition = clean(edition![field]);
      if (after !== undefined && after === fromEdition) delete overrides[key];
      else {
        (overrides as any)[key] = after ?? null;
        changes.push({ field, old: fromEdition ?? null, new: after ?? null });
      }
      (next as any)[field] = after;
    } else {
      // Not changed by this patch: keep the person's own stored value, not the edition's.
      (next as any)[field] = base[field];
    }
  }
  next.overrides = overrides;
  return { event: next, changes };
}

// Detaches from the edition. Each shared field falls back to the override, else what was first typed
// (captured), else the event's own value. Overrides are cleared; captured stays.
export function unlinkEvent(event: LoggedEvent, now: Date): LoggedEvent {
  const base = ensureCaptured(event);
  const out: LoggedEvent = { ...base, editionId: undefined, overrides: {}, updatedAt: now.toISOString() };
  const overrides = base.overrides ?? {};
  const captured = base.captured ?? {};
  for (const { field, key } of SHARED) {
    const v = key in overrides ? overrides[key] : key in captured ? captured[key] : base[field];
    (out as any)[field] = typeof v === 'string' && v.trim() ? v : undefined;
  }
  if (out.startDate) {
    out.year = Number(out.startDate.slice(0, 4));
    out.month = undefined;
  } else if (!(captured.year == null)) {
    out.year = captured.year ?? undefined;
    out.month = captured.month ?? undefined;
  }
  if (!('region' in overrides) && 'region' in captured) out.region = clean(captured.region);
  return out;
}

// One review row per override: ids, field name and the old and new public value only.
export async function recordOverrides(store: LineupStore, event: LoggedEvent, changes: OverrideChange[]): Promise<ReviewQueueItem[]> {
  const rows: ReviewQueueItem[] = [];
  if (!event.editionId) return rows;
  for (const c of changes) {
    rows.push(
      await store.addReviewItem({
        kind: 'override',
        editionId: event.editionId,
        eventId: event.id,
        payload: { field: c.field, old: c.old, new: c.new },
      }),
    );
  }
  return rows;
}

// Every reader of the event log that shows or matches on venue, date or city goes through this, so a
// linked event is seen with its edition's values (the same view GET /api/events gives).
export async function listResolvedEvents(store: Pick<LineupStore, 'listEvents' | 'getEditions'>): Promise<LoggedEvent[]> {
  const raw = await store.listEvents();
  const ids = [...new Set(raw.map((e) => e.editionId).filter((id): id is string => Boolean(id)))];
  return resolveEvents(raw, ids.length ? await store.getEditions(ids) : []);
}
