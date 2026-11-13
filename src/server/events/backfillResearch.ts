// Slice 11.19: a cron step that researches events still 'pending' (saved before queue research existed, or whose
// queue message failed). At most RESEARCH_BATCH_SIZE events per run (the cron fires every minute).
//
// Ladder rungs 1 and 2 only: the catalog lookup and the structured finders (Ticketmaster, setlist.fm, Clashfinder).
// No reader model (rung 4). Brave (rung 3) is NOT used here: this backfill filters it out of the finders. The monthly
// Brave counter below (200 queries a month, resets by calendar month) is built and tested so a later slice can gate
// Brave with it; nothing calls it yet.
//
// Never infers a date: an event with a full date is researched; an event with only a year (or nothing) is not,
// and is listed for the person to confirm (yearOnlyEvents; Fill gaps shows the same list). Persist rules are
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
//     3 place pages, catalog rung 1 (3) and rung 2 persistence (up to 11) = 25 (the queue message's 27 minus Brave's 2).
//   worst case, no budget: 3 + 5 * 25 = 128 subrequests. Under the default 50 the step runs only as many events as
//     the budget left allows (checked before each event), so 1 event a run at 50 and all 5 once SUBREQUEST_LIMIT is
//     at least about 130. An event cut off is not marked and is retried on a later run.
import type { LoggedEvent } from './types';
import type { LineupStore } from '../lineup/store/types';
import { currentBudget } from '../lineup/budget';
import { researchCatalogFor, runQueuedResearch, type DetailFinder } from './details';
import type { Fetcher } from '../lineup/types';

export const RESEARCH_BATCH_SIZE = 5;
export const RESEARCH_SETTING = 'research_backfill';
export const BRAVE_MONTHLY_CAP = 200;
export const BRAVE_SETTING = 'brave_monthly';
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const FIXED_COST = 3;
const ITEM_COST = 25;
const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---- Brave monthly counter (not yet used by the backfill) ----

interface BraveCount {
  month: string; // YYYY-MM (UTC)
  used: number;
}

const monthOf = (now: Date) => now.toISOString().slice(0, 7);

export async function braveUsed(store: Pick<LineupStore, 'getSetting'>, now: Date): Promise<number> {
  const c = await store.getSetting<BraveCount>(BRAVE_SETTING);
  return c && c.month === monthOf(now) ? c.used : 0;
}

// Takes `n` Brave queries from this month's allowance. False (and nothing taken) when it would pass the cap.
export async function takeBrave(store: Pick<LineupStore, 'getSetting' | 'putSetting'>, now: Date, n = 1): Promise<boolean> {
  const used = await braveUsed(store, now);
  if (used + n > BRAVE_MONTHLY_CAP) return false;
  await store.putSetting<BraveCount>(BRAVE_SETTING, { month: monthOf(now), used: used + n });
  return true;
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
  const events = await store.listEvents();
  const pending = events.filter((e) => e.details.status === 'pending');
  const report: ResearchBackfillReport = { researched: 0, skipped_recent: 0, year_only: yearOnlyEvents(events).length };
  if (!pending.length) return report;

  const attempts = (await store.getSetting<Attempts>(RESEARCH_SETTING)) ?? { at: {} };
  const cutoff = now.getTime() - RETRY_AFTER_MS;
  const recent = (iso?: string) => Boolean(iso) && Date.parse(iso!) > cutoff;
  const next: Attempts = { at: Object.fromEntries(Object.entries(attempts.at).filter(([, t]) => recent(t))) };
  let changed = Object.keys(next.at).length !== Object.keys(attempts.at).length;

  const usable = finders.filter((f) => f.id !== 'discovered'); // no Brave (rung 3) here
  const catalog = researchCatalogFor(opts.role, opts.userId, opts.catalogStore ?? store);
  const batch = opts.batchSize ?? RESEARCH_BATCH_SIZE;
  const room = (n: number) => budgetLeft() >= ITEM_COST + n;
  for (const e of pending) {
    if (report.researched >= batch || !room(1)) break;
    if (!e.startDate || !FULL_DATE.test(e.startDate)) continue; // year-only or undated: listed, never researched
    if (recent(next.at[e.id]) || recent(e.details.checkedAt)) {
      report.skipped_recent++;
      continue;
    }
    next.at[e.id] = now.toISOString();
    changed = true;
    report.researched++;
    try {
      await runQueuedResearch(store, e.id, usable, fetcher, now, catalog);
    } catch (err) {
      // Stays pending; tried again after RETRY_AFTER_MS. No fallback.
      console.error(`Research backfill ${e.id} failed:`, err instanceof Error ? err.message : String(err));
    }
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
