// Backfill of shared editions from what the owner already has. A batch step run from the cron:
//   (c) existing editions get a venue_id (from their venue text, via upsertVenue + alias) and a subject_key
//       (the edition's own series slug) where missing;
//   (b) ticket email imports that became events (status 'added') become verified editions
//       (name, date, venue, city only);
//   (a) the owner's dated events become verified editions (the person typed or confirmed the date and venue).
// Items are handled in that order so (c) gives older editions the venue and subject that matching needs first.
//
// Every edition goes through upsertOccurrence / writeEdition. No model call, no new queue, no new binding.
// Never in an edition, change record or review row: companions, notes, rating, price, attendance. Only name,
// date(s), venue, city, state and country are passed on. A date, venue or subject is never inferred: an item without a full
// date is skipped, an edition without venue text gets no venue_id, and the subject is the edition's stored series slug.
//
// Idempotent two ways. The upsert of an already-matched item changes nothing, so a repeat is a no-op. And a cursor
// (app setting 'canon_backfill': ids done, and a `complete` flag) means each item is handled once and later cron
// runs cost one read. At most BATCH_SIZE items per run.
//
// Worker subrequests (the cron's budget is SUBREQUEST_LIMIT, 50 by default, shared with the rest of the cron):
//   fixed per run: 1 (cursor read) when complete; otherwise cursor read + listEvents + listImports + listEditionHeaders
//     + ownerUserId + margin = 6 (plus cursor write = 1).
//   per item: ITEM_COST = 20 at worst (venue alias lookup 2, upsertVenue 3, edition key check 2, getEdition on a
//     miss 1, upsertEdition about 5, change record 1, merge-suggestion check and write 2). Edition headers are listed
//     once per run and kept in step with our own writes (cachedEditions), so matching does not list them per item.
//   worst case, no budget: 6 + 1 + 20 * 20 = 407 subrequests. Under the default budget the run does as many items
//     as the budget allows, floor((budget left - fixed - cursor write) / 20), needing 6 + 1 + 20 = 27 minimum
//     budgetLeft for 1 item under the 50-subrequest Worker budget, and the full 20 only when SUBREQUEST_LIMIT is
//     at least about 407. An item cut off by the budget is not marked done and is retried on a later run.
import type { Edition, EditionHeader } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';
import { EditionOccurrenceConflictError } from '../lineup/store/types';
import type { LoggedEvent } from '../events/types';
import type { EmailImport } from '../events/email/types';
import { currentBudget } from '../lineup/budget';
import { seriesSlugFor } from '../lineup/text';
import { writeEdition } from './editions';
import { upsertOccurrence } from './match';
import { autoMergeZeroLineupGroup } from '../lineup/canonicalIngest';

export const BACKFILL_BATCH_SIZE = 20;
export const BACKFILL_SETTING = 'canon_backfill';
const ACTOR = 'system:canon-backfill';
const ITEM_COST = 20;
const FIXED_COST = 6;
const CURSOR_WRITE_COST = 1;
const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Cursor {
  done: string[];
  complete?: boolean;
}

export interface BackfillReport {
  created: number;
  matched: number;
  promoted: number;
  skipped_no_date: number;
  venue_set: number;
  subject_set: number;
  ambiguous: number;
  skipped_other: number; // deleted, missed, or already linked to an edition
  remaining: number;
}

export interface BackfillOptions {
  batchSize?: number;
  // Subrequests left for ordinary calls; defaults to the current Worker budget, unlimited when there is none.
  budgetLeft?: () => number;
}

const emptyReport = (): BackfillReport => ({
  created: 0, matched: 0, promoted: 0, skipped_no_date: 0, venue_set: 0, subject_set: 0, ambiguous: 0, skipped_other: 0, remaining: 0,
});

type Item =
  | { id: string; kind: 'edition'; edition: EditionHeader }
  | { id: string; kind: 'import'; row: EmailImport; event: LoggedEvent | undefined }
  | { id: string; kind: 'event'; event: LoggedEvent };

function defaultBudgetLeft(): number {
  const b = currentBudget();
  return b ? b.limit - b.reserve - b.used : Number.POSITIVE_INFINITY;
}

function toHeader(e: Edition | EditionHeader): EditionHeader {
  if (!('performances' in e)) return e;
  const { performances: _p, ...header } = e as Edition;
  return header;
}

// Editions listed once and kept in step with our own writes, so upsertOccurrence's per-item list is free.
function cachedEditions(store: LineupStore, initial: EditionHeader[]): LineupStore {
  const headerCache = new Map<string, EditionHeader>(initial.map((e) => [e.id, toHeader(e)]));
  const fullCache = new Map<string, Edition>();
  for (const item of initial) {
    if ('performances' in item && Array.isArray((item as Edition).performances)) {
      fullCache.set(item.id, item as Edition);
    }
  }
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'listEditionHeaders') return async () => [...headerCache.values()];
      if (prop === 'listEditions') {
        return async () => {
          const results: Edition[] = [];
          for (const header of headerCache.values()) {
            let full = fullCache.get(header.id);
            if (!full) {
              const fetched = await target.getEdition(header.id);
              if (fetched) {
                full = fetched;
                fullCache.set(header.id, full);
              } else {
                full = { ...header, performances: [] };
              }
            }
            results.push(full);
          }
          return results;
        };
      }
      if (prop === 'getEdition') {
        return async (id: string) => {
          const cached = fullCache.get(id);
          if (cached) return cached;
          const fetched = await target.getEdition(id);
          if (fetched) {
            fullCache.set(id, fetched);
            headerCache.set(id, toHeader(fetched));
          }
          return fetched;
        };
      }
      if (prop === 'getEditionHeaders') {
        return async (ids: string[]) => {
          return ids.map((id) => headerCache.get(id)).filter((h): h is EditionHeader => Boolean(h));
        };
      }
      if (prop === 'upsertEdition') {
        return async (e: Edition) => {
          // Only writeEdition reaches this: it is the wrapped store's own method, passed through and mirrored.
          await (Reflect.get(target, prop, target) as (e: Edition) => Promise<void>).call(target, e);
          fullCache.set(e.id, e);
          headerCache.set(e.id, toHeader(e));
        };
      }
      if (prop === 'mergeEditions') {
        return async (keepId: string, dropId: string, actor: string, reason?: string) => {
          const res = await (target.mergeEditions as any)(keepId, dropId, actor, reason);
          fullCache.delete(dropId);
          headerCache.delete(dropId);
          const updated = await target.getEdition(keepId);
          if (updated) {
            fullCache.set(keepId, updated);
            headerCache.set(keepId, toHeader(updated));
          }
          return res;
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

export async function runCanonBackfill(store: LineupStore, opts: BackfillOptions = {}): Promise<BackfillReport | null> {
  const cursor = (await store.getSetting<Cursor>(BACKFILL_SETTING)) ?? { done: [] };
  if (cursor.complete) return null;
  const budgetLeft = opts.budgetLeft ?? defaultBudgetLeft;
  const room = Math.floor((budgetLeft() - FIXED_COST - CURSOR_WRITE_COST) / ITEM_COST);
  if (room < 1) return null;

  const [events, imports, editions] = await Promise.all([
    store.listEvents(),
    store.listImports(),
    typeof store.listEditionHeaders === 'function'
      ? store.listEditionHeaders({ limit: 5000 })
      : store.listEditions(5000),
  ]);
  const done = new Set(cursor.done);
  const eventById = new Map(events.map((e) => [e.id, e]));
  const items: Item[] = [];
  for (const edition of editions) if (edition.status !== 'draft' && needsFill(edition)) items.push({ id: `edition:${edition.id}`, kind: 'edition', edition });
  const handledByImport = new Set<string>();
  for (const row of imports) {
    if (row.status !== 'added' || !row.eventId) continue;
    items.push({ id: `import:${row.id}`, kind: 'import', row, event: eventById.get(row.eventId) });
    if (row.startDate && eventById.has(row.eventId)) handledByImport.add(row.eventId);
  }
  for (const event of events) if (!handledByImport.has(event.id)) items.push({ id: `event:${event.id}`, kind: 'event', event });

  const pending = items.filter((i) => !done.has(i.id));
  const batch = pending.slice(0, Math.max(1, Math.min(opts.batchSize ?? BACKFILL_BATCH_SIZE, room)));
  const priorStatus = new Map(editions.map((e) => [e.id, e.status]));
  const shared = cachedEditions(store, editions);
  const report = emptyReport();
  const finished: string[] = [];
  let stopped = false;

  for (const item of batch) {
    if (budgetLeft() < ITEM_COST + CURSOR_WRITE_COST) {
      stopped = true;
      break;
    }
    try {
      if (item.kind === 'edition') await fillEdition(shared, item.edition, report);
      else if (item.kind === 'import') await fromImport(shared, item, priorStatus, report);
      else await fromEvent(shared, item.event, priorStatus, report);
      finished.push(item.id);
    } catch (err) {
      if (err instanceof Error && err.name === 'EditionOccurrenceConflictError') {
        const conflictErr = err as EditionOccurrenceConflictError;
        let merged = false;
        const idA = item.kind === 'edition' ? item.edition.id : conflictErr.editionId;
        const clashId =
          conflictErr.conflictingEdition?.id ??
          editions.find(
            (e) =>
              e.id !== idA &&
              e.startDate === (conflictErr.startDate ?? (item.kind === 'edition' ? item.edition.startDate : undefined)) &&
              e.venueId === (conflictErr.venueId ?? (item.kind === 'edition' ? item.edition.venueId : undefined)) &&
              e.subjectKey === (conflictErr.subjectKey ?? (item.kind === 'edition' ? item.edition.subjectKey : undefined)),
          )?.id;

        if (idA && clashId && idA !== clashId) {
          const edA = editions.find((e) => e.id === idA) ?? (await store.getEdition(idA));
          const edB = editions.find((e) => e.id === clashId) ?? (await store.getEdition(clashId));
          if (edA && edB) {
            try {
              const autoMergeRes = await autoMergeZeroLineupGroup(store, [edA, edB], {
                actor: ACTOR,
                reason: 'Auto-merge zero-lineup duplicate into matching verified edition',
              });
              if (autoMergeRes) {
                merged = true;
                const droppedSet = new Set(autoMergeRes.droppedIds);
                const kept = editions.filter((e) => !droppedSet.has(e.id));
                editions.length = 0;
                editions.push(...kept);
              }
            } catch {
              // best-effort
            }
          }
        }

        if (!merged && clashId && item.kind === 'edition') {
          try {
            const enqueue =
              typeof (store as any).enqueueReview === 'function'
                ? (store as any).enqueueReview.bind(store)
                : typeof store.addReviewItem === 'function'
                  ? store.addReviewItem.bind(store)
                  : undefined;
            if (enqueue) {
              await enqueue({
                kind: 'merge_suggestion',
                editionId: item.edition.id,
                payload: {
                  editionIds: [item.edition.id, clashId],
                  startDate: item.edition.startDate ?? null,
                  venue: item.edition.venue ?? null,
                  city: item.edition.city ?? null,
                },
              });
            }
          } catch {
            // best-effort: swallow enqueue errors so backfill still continues and marks the item done
          }
        }
        // Another edition holds this date, venue and subject: skip only this item (it is not retried).
        report.skipped_other++;
        finished.push(item.id);
        continue;
      }
      // A budget or store error stops the run; finished items are kept, the rest are retried next run.
      console.error('Canon backfill stopped:', err instanceof Error ? err.message : String(err));
      stopped = true;
      break;
    }
  }

  const all = [...cursor.done, ...finished];
  report.remaining = pending.length - finished.length;
  const complete = report.remaining === 0 && !stopped;
  if (finished.length || complete) {
    try {
      await store.putSetting<Cursor>(BACKFILL_SETTING, { done: all, ...(complete ? { complete: true } : {}) });
    } catch (err) {
      console.error('Canon backfill cursor not saved:', err instanceof Error ? err.message : String(err));
    }
  }
  return report;
}

const needsFill = (e: EditionHeader) => !e.subjectKey || (!e.venueId && Boolean(e.venue?.trim()));

async function fillEdition(store: LineupStore, header: EditionHeader, report: BackfillReport) {
  const full = await store.getEdition(header.id);
  if (!full) return;
  const next: Edition = { ...full, updatedAt: new Date().toISOString() };
  if (!full.venueId && full.venue?.trim()) {
    const venue = await store.upsertVenue({ name: full.venue.trim(), city: full.city, country: full.country });
    next.venueId = venue.id;
  }
  if (!full.subjectKey && full.seriesSlug) next.subjectKey = full.seriesSlug;
  const w = await writeEdition(store, { edition: next, before: full, actor: ACTOR, reason: 'backfill: venue and subject for an existing edition' });
  if (w.changed) {
    if (next.venueId && !full.venueId) report.venue_set++;
    if (next.subjectKey && !full.subjectKey) report.subject_set++;
  }
}

async function fromImport(store: LineupStore, item: Extract<Item, { kind: 'import' }>, prior: Map<string, string>, report: BackfillReport) {
  const { row, event } = item;
  if (!event) return void report.skipped_other++; // the event was deleted
  if (!row.startDate || !FULL_DATE.test(row.startDate)) return void report.skipped_no_date++;
  await place(store, prior, report, {
    name: row.name ?? event.name,
    startDate: row.startDate,
    endDate: row.endDate,
    venue: row.venue,
    city: row.city,
    reason: 'backfill: ticket email import that became an event',
  });
}

async function fromEvent(store: LineupStore, event: LoggedEvent, prior: Map<string, string>, report: BackfillReport) {
  if (event.editionId) return void report.skipped_other++; // already linked to an edition
  if (event.attendance === 'missed') return void report.skipped_other++;
  if (!event.startDate || !FULL_DATE.test(event.startDate)) return void report.skipped_no_date++;
  await place(store, prior, report, {
    name: event.name,
    startDate: event.startDate,
    endDate: event.endDate,
    venue: event.venue,
    city: event.city,
    region: event.region,
    country: event.country,
    reason: 'backfill: owner event with a date',
  });
}

async function place(
  store: LineupStore,
  prior: Map<string, string>,
  report: BackfillReport,
  f: { name: string; startDate: string; endDate?: string; venue?: string; city?: string; region?: string; country?: string; reason: string },
) {
  // Only these facts go in; nothing personal is read from the event.
  const r = await upsertOccurrence(store, {
    name: f.name,
    startDate: f.startDate,
    ...(f.endDate ? { endDate: f.endDate } : {}),
    ...(f.venue ? { venue: f.venue } : {}),
    ...(f.city ? { city: f.city } : {}),
    ...(f.region ? { region: f.region } : {}),
    ...(f.country ? { country: f.country } : {}),
    subjectKey: seriesSlugFor(f.name),
    trust: 'verified',
    actor: ACTOR,
    reason: f.reason,
  });
  if (r.action === 'skipped_no_date') report.skipped_no_date++;
  else if (r.action === 'ambiguous') report.ambiguous++;
  else if (r.action === 'created') {
    report.created++;
    if (r.edition) prior.set(r.edition.id, 'verified');
  } else {
    report.matched++;
    const before = r.edition ? prior.get(r.edition.id) : undefined;
    if (r.edition && before && before !== 'verified' && before !== 'confirmed' && r.edition.status === 'verified') {
      report.promoted++;
      prior.set(r.edition.id, 'verified');
    }
  }
}
