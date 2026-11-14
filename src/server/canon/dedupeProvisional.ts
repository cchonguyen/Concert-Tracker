// Merges duplicate `provisional` shared editions (the KREAM incident, 2026-11-14). Before the match fix in match.ts,
// every member entry with no venue created its own edition, so one show could appear dozens of times.
//
// Scope: only editions with status 'provisional'. A verified, confirmed or draft edition is never read as a key or
// dropped. Key: subject, start date, venue id and venue text. Within a group the edition with the most acts is kept
// (then the lowest id, so every run picks the same one). The others go through mergeEditions, which moves events,
// acts, external ids and review rows, deletes the dropped row and records a change. No row is deleted directly.
//
// Bounded: at most `limit` merges per call, and only while the subrequest budget covers each merge. Runs before the
// member backfill in the cron, so the backfill's ambiguity check sees one edition per key.
import type { Edition } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';
import { normalizeName } from '../lineup/text';
import { currentBudget } from '../lineup/budget';

const SCAN_LIMIT = 5000;
export const DEDUPE_MERGE_LIMIT = 40;
const MERGE_COST = 2;
export const DEDUPE_ACTOR = 'system:dedupe';
export const DEDUPE_REASON = 'Duplicate provisional edition from the member backfill (same name, date and venue)';

export interface DedupeReport {
  groups: number; // duplicate groups found this run
  merged: number; // editions folded into a kept edition
}

function defaultBudgetLeft(): number {
  const b = currentBudget();
  return b ? b.limit - b.reserve - b.used : Number.POSITIVE_INFINITY;
}

export const provisionalKey = (e: Edition) =>
  [e.subjectKey ?? e.seriesSlug, e.startDate ?? '', e.venueId ?? '', normalizeName(e.venue ?? '')].join('|');

export async function dedupeProvisionalEditions(
  store: LineupStore,
  opts: { limit?: number; budgetLeft?: () => number } = {},
): Promise<DedupeReport | null> {
  const limit = Math.max(0, opts.limit ?? DEDUPE_MERGE_LIMIT);
  const budgetLeft = opts.budgetLeft ?? defaultBudgetLeft;
  const groups = new Map<string, Edition[]>();
  for (const e of await store.listEditions(SCAN_LIMIT)) {
    if (e.status !== 'provisional' || !e.startDate) continue;
    const k = provisionalKey(e);
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }

  const report: DedupeReport = { groups: 0, merged: 0 };
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    report.groups++;
    list.sort((a, b) => b.performances.length - a.performances.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const [keep, ...drops] = list;
    for (const drop of drops) {
      if (report.merged >= limit || budgetLeft() < MERGE_COST) return report.groups || report.merged ? report : null;
      await store.mergeEditions(keep.id, drop.id, DEDUPE_ACTOR, DEDUPE_REASON);
      report.merged++;
    }
  }
  return report.groups || report.merged ? report : null;
}
