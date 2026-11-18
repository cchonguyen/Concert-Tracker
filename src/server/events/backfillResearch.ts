// Slice 11.19: a cron step that researches events still 'pending' (saved before queue research existed, or whose
// queue message failed). At most RESEARCH_BATCH_SIZE events per run (the cron fires every minute).
//
// Ladder rungs 1 to 3: the catalog lookup, the structured finders (Ticketmaster, setlist.fm, Clashfinder) and, since
// Slice 3.3, Brave (rung 3) only when the free finders leave a gap (researchEvent, leavesGap). No reader model (rung 4).
// The monthly Brave counter (200 queries a month, braveBudget.ts) now gates the live Brave calls: braveCapFetcher
// wraps the fetcher in createDeps (lineup/service.ts), so Brave requests made by queued research are counted there.
//
// Never infers a date: an event with a full date, or a year and a city, is researched (batchable); an event with only
// a year (or nothing) is not, and is listed for the person to confirm (yearOnlyEvents; Fill gaps shows the same list). Persist rules are
// runQueuedResearch's: the catalog is written only for the owner or in single-user mode (researchCatalogFor).
//
// Idempotent: runQueuedResearch skips an event that is no longer 'pending', so a researched event leaves the
// queue. An event whose research failed (still 'pending') is retried only after RETRY_AFTER_MS, tracked in the
// app setting 'research_backfill' (id -> attempt time), so one stuck event never blocks the rest every minute.
// An event with details.checkedAt inside that window is also skipped.
//
// Worker subrequests (the cron's budget is SUBREQUEST_LIMIT, 50 by default, shared with the rest of the cron):
//   fixed per run: 3 (attempts read, listEvents, attempts write) = FIXED_COST.
//   per event: ITEM_COST = 25 at worst: getEvent + putEvent 2, 3 finders, 3 again when the typed name differs,
//     3 place pages, catalog rung 1 (3), rung 2 persistence (up to 11) and Brave's 2 = 27 (the queue message's worst case).
//   worst case, no budget: 3 + 5 * 27 = 138 subrequests. Under the default 50 the step runs only as many events as
//     the budget left allows (checked before each event), so 1 event a run at 50 and all 5 once SUBREQUEST_LIMIT is
//     at least about 130. An event cut off is not marked and is retried on a later run.
import type { LoggedEvent } from './types';
import type { LineupStore } from '../lineup/store/types';
import { currentBudget } from '../lineup/budget';
import { researchCatalogFor, runQueuedResearch, type DetailFinder } from './details';
import type { Fetcher } from '../lineup/types';
import { loadRefusals, refusalFetcher, saveRefusals } from './refusedHosts';

export { BRAVE_MONTHLY_CAP, BRAVE_SETTING, braveUsed, takeBrave, monthOf } from './braveBudget';
export type { BraveCount } from './braveBudget';

export const RESEARCH_BATCH_SIZE = 5;
export const RESEARCH_SETTING = 'research_backfill';
// Slice 3.4: the batch runs for members too once this app setting is { "on": true }. Off by default, so the owner
// batch runs alone until it has worked in production.
export const RESEARCH_MEMBERS_SETTING = 'research_batch_members';
export function membersResearchOn(value: { on?: boolean } | null | undefined): boolean {
  return value?.on === true;
}
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const FIXED_COST = 3;
const ITEM_COST = 27;
const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Slice 3.1: an event with a full date is researched as before. So is one with a year and a city but no date:
// the structured finders search that year in that city, and what they find is a candidate for your tap, never
// filled on its own (a year-only event has no full date for researchEvent to match). A year alone is not enough.
export function batchable(e: LoggedEvent): boolean {
  if (e.startDate && FULL_DATE.test(e.startDate)) return true;
  return Boolean(e.year && e.city);
}

// ---- Events the person must confirm ----

// Waiting for research (or a date) and with only a year: never researched into a date, listed instead.
// Fill gaps shows this same list (src/components/FillGaps.tsx repeats the test; keep them in step).
export function yearOnlyEvents(events: LoggedEvent[]): LoggedEvent[] {
  return events.filter(
    (e) => (e.details.status === 'pending' || e.details.status === 'needs_date') && !(e.startDate && FULL_DATE.test(e.startDate)) && Boolean(e.year),
  );
}

// ---- The cron step ----

interface Attempts {
  at: Record<string, string>;
}

export interface ResearchBackfillOptions {
  batchSize?: number;
  budgetLeft?: () => number;
  role?: 'owner' | 'member';
  userId?: string;
  // The unscoped store the shared catalog lives in (as the queue consumer passes); defaults to `store`.
  catalogStore?: LineupStore;
}

export interface ResearchBackfillReport {
  researched: number;
  skipped_recent: number;
  year_only: number;
}

function defaultBudgetLeft(): number {
  const b = currentBudget();
  return b ? b.limit - b.reserve - b.used : Number.POSITIVE_INFINITY;
}

export async function runResearchBackfill(
  store: LineupStore,
  finders: DetailFinder[],
  fetcher: Fetcher,
  now: Date,
  opts: ResearchBackfillOptions = {},
): Promise<ResearchBackfillReport | null> {
  const budgetLeft = opts.budgetLeft ?? defaultBudgetLeft;
  if (budgetLeft() < FIXED_COST + ITEM_COST) return null;
  const pending: LoggedEvent[] =
    'listPendingResearchEvents' in store && typeof (store as any).listPendingResearchEvents === 'function'
      ? await (store as any).listPendingResearchEvents()
      : (await store.listEvents()).filter((e) => e.details.status === 'pending');
  const report: ResearchBackfillReport = { researched: 0, skipped_recent: 0, year_only: yearOnlyEvents(pending).length };
  if (!pending.length) return report;

  const attempts = (await store.getSetting<Attempts>(RESEARCH_SETTING)) ?? { at: {} };
  const cutoff = now.getTime() - RETRY_AFTER_MS;
  const recent = (iso?: string) => Boolean(iso) && Date.parse(iso!) > cutoff;
  const next: Attempts = { at: Object.fromEntries(Object.entries(attempts.at).filter(([, t]) => recent(t))) };
  let changed = Object.keys(next.at).length !== Object.keys(attempts.at).length;

  // Slice 3.3: Brave is allowed here too; researchEvent calls it only when the free finders leave a gap.
  const usable = finders;
  const catalog = researchCatalogFor(opts.role, opts.userId, opts.catalogStore ?? store);
  const batch = opts.batchSize ?? RESEARCH_BATCH_SIZE;
  const room = (n: number) => budgetLeft() >= ITEM_COST + n;
  // Slice 4.3: hosts that refused in the last 30 days are not asked again; new refusals are saved at the end.
  const refusedBefore = await loadRefusals(store, now);
  const refusals = { ...refusedBefore };
  const guarded = refusalFetcher(fetcher, refusals, now);
  for (const e of pending) {
    if (report.researched >= batch || !room(1)) break;
    if (!batchable(e)) continue; // a year with no city, or no year: listed, never researched
    if (recent(next.at[e.id]) || recent(e.details.checkedAt)) {
      report.skipped_recent++;
      continue;
    }
    next.at[e.id] = now.toISOString();
    changed = true;
    report.researched++;
    try {
      await runQueuedResearch(store, e.id, usable, guarded, now, catalog);
    } catch (err) {
      // Stays pending; tried again after RETRY_AFTER_MS. No fallback.
      console.error(`Research backfill ${e.id} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
  try {
    await saveRefusals(store, refusedBefore, refusals, now);
  } catch (err) {
    console.error('Refused hosts not saved:', err instanceof Error ? err.message : String(err));
  }
  if (changed) {
    try {
      await store.putSetting<Attempts>(RESEARCH_SETTING, next);
    } catch (err) {
      console.error('Research backfill attempts not saved:', err instanceof Error ? err.message : String(err));
    }
  }
  return report;
}
