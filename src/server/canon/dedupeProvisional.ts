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
import type { EditionHeader } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';
import { normalizeName, seriesSlugFor } from '../lineup/text';
import { currentBudget } from '../lineup/budget';
import { autoMergeZeroLineupGroup } from '../lineup/canonicalIngest';
import { editionsMatch, subjectOf } from './match';

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

export const provisionalKey = (e: Pick<EditionHeader, 'subjectKey' | 'seriesSlug' | 'name' | 'startDate' | 'venueId' | 'venue'>) =>
  [e.subjectKey ?? e.seriesSlug ?? seriesSlugFor(e.name), e.startDate ?? '', e.venueId ?? '', normalizeName(e.venue ?? '')].join('|');

export async function dedupeProvisionalEditions(
  store: LineupStore,
  opts: { limit?: number; budgetLeft?: () => number } = {},
): Promise<DedupeReport | null> {
  const limit = Math.max(0, opts.limit ?? DEDUPE_MERGE_LIMIT);
  const budgetLeft = opts.budgetLeft ?? defaultBudgetLeft;
  const allHeaders = await store.listEditionHeaders({ limit: SCAN_LIMIT });
  const groups = new Map<string, EditionHeader[]>();
  for (const e of allHeaders) {
    if (e.status !== 'provisional' || !e.startDate) continue;
    const k = provisionalKey(e);
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }

  const dupGroups = [...groups.values()].filter((list) => list.length >= 2);
  const droppedIds = new Set<string>();
  const report: DedupeReport = { groups: 0, merged: 0 };

  if (dupGroups.length > 0) {
    const dupEditionIds = dupGroups.flat().map((e) => e.id);
    const actCounts = new Map<string, number>();
    for (const ref of await store.listEditionArtistRefs({ editionIds: dupEditionIds })) {
      actCounts.set(ref.editionId, (actCounts.get(ref.editionId) ?? 0) + 1);
    }

    for (const list of dupGroups) {
      report.groups++;
      list.sort(
        (a, b) =>
          (actCounts.get(b.id) ?? 0) - (actCounts.get(a.id) ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      const [keep, ...drops] = list;
      for (const drop of drops) {
        if (report.merged >= limit || budgetLeft() < MERGE_COST) return report.groups || report.merged ? report : null;
        await store.mergeEditions(keep.id, drop.id, DEDUPE_ACTOR, DEDUPE_REASON);
        report.merged++;
        droppedIds.add(drop.id);
      }
    }
  }

  // Pass 2: Auto-merge matching 0-lineup edition into populated verified edition
  if (report.merged < limit && budgetLeft() >= MERGE_COST) {
    const remainingHeaders = allHeaders.filter((e) => e.status !== 'draft' && !droppedIds.has(e.id));
    const subjectBuckets = new Map<string, EditionHeader[]>();
    for (const e of remainingHeaders) {
      const subj = subjectOf(e);
      if (!subj) continue;
      const list = subjectBuckets.get(subj) ?? [];
      list.push(e);
      subjectBuckets.set(subj, list);
    }

    for (const list of subjectBuckets.values()) {
      if (list.length < 2) continue;
      if (report.merged >= limit || budgetLeft() < MERGE_COST) break;

      const unvisited = new Set(list.map((e) => e.id));
      const idToHeader = new Map(list.map((e) => [e.id, e]));

      while (unvisited.size > 0) {
        if (report.merged >= limit || budgetLeft() < MERGE_COST) break;

        const startId = unvisited.values().next().value!;
        unvisited.delete(startId);
        const queue = [startId];
        const cluster: string[] = [startId];

        while (queue.length > 0) {
          const currId = queue.shift()!;
          const currHeader = idToHeader.get(currId)!;
          for (const otherId of [...unvisited]) {
            const otherHeader = idToHeader.get(otherId)!;
            if (editionsMatch(currHeader, otherHeader)) {
              unvisited.delete(otherId);
              queue.push(otherId);
              cluster.push(otherId);
            }
          }
        }

        if (cluster.length >= 2) {
          const clusterHeaders = cluster.map((id) => idToHeader.get(id)!);
          const autoMerged = await autoMergeZeroLineupGroup(store, clusterHeaders, {
            actor: 'system:auto-merge',
            reason: 'Auto-merge zero-lineup duplicate into matching verified edition',
          });
          if (autoMerged) {
            report.groups++;
            report.merged += autoMerged.droppedIds.length;
            for (const id of autoMerged.droppedIds) {
              droppedIds.add(id);
            }
          }
        }
      }
    }
  }

  return report.groups || report.merged ? report : null;
}
