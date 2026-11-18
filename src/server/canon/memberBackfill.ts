// Member backfill (slice 12.6). A cron batch that turns existing members' dated events into `provisional` shared
// editions, the same shape as a member's own entry (Slice 11.23, persistOwnEntry in events/details.ts).
//
// Who is walked: members with a user id, role 'member' and not blocked, who accepted notice version NOTICE_VERSION.
// Anyone else is counted as skipped and their events are never read. Each walked member's dated events are read
// through that member's scoped store (forUser). Only the event's name, full YYYY-MM-DD start date, typed end date,
// typed venue and typed city are passed on (venue/city/endDate only when the person typed them, as in
// persistOwnEntry). Attendance, price, notes, companions, rating and ids never leave the member's store, and no user
// id, email or event id goes into an edition, a change reason, a trace or a log line.
//
// Writes go through upsertOccurrence on the SERVICE store (the member scoped store only reads events and keeps the
// cursor). Actor 'member:entry', trust 'provisional' (fills empty fields only; never a status change).
//
// Cursor: per member, in that member's own settings ('canon_member_backfill': { done: event ids, complete? }).
// A member with `complete` costs one settings read per run. A few items per run (default 5, across all members),
// and only while the subrequest budget allows. An item cut off by the budget is not marked done.
//
// Owner override (Slice 12.10): an owner-set app setting MEMBER_BACKFILL_OVERRIDE_SETTING `{ until }` lets the walk
// include members of any notice version while `until` is a future ISO time. It is time-boxed and expires by itself.
// It changes nothing else: owners, blocked members, users without an id, the field list and the cursor rules stay.
//
// Worker subrequests: per walked member about 4 (notice read, cursor read, listEvents, cursor write), per item at
// worst ITEM_COST = 16 (match and venue lookup, edition write, change record). An item is started only when the
// budget covers it plus the cursor write. A run that does nothing returns null.
import type { LineupStore } from '../lineup/store/types';
import type { LoggedEvent } from '../events/types';
import { currentBudget } from '../lineup/budget';
import { seriesSlugFor } from '../lineup/text';
import { NOTICE_SETTING, NOTICE_VERSION } from '../auth/routes';
import { upsertOccurrence } from './match';

export const MEMBER_BACKFILL_BATCH_SIZE = 5;
export const MEMBER_BACKFILL_SETTING = 'canon_member_backfill';
export const MEMBER_BACKFILL_OVERRIDE_SETTING = 'member_backfill_override';
const ITEM_COST = 16;
const MEMBER_FIXED_COST = 4;
const CURSOR_WRITE_COST = 1;
const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Cursor {
  done: string[];
  complete?: boolean;
}

export interface MemberBackfillReport {
  members: number; // accepted members walked this run
  created: number;
  matched: number;
  skipped: number; // members not walked (not accepted, no scoped store) and events that are not candidates
  remaining: number; // candidate events still waiting, in the members walked this run
}

export interface MemberBackfillOptions {
  budgetLeft?: () => number;
  batchSize?: number;
  anyNotice?: boolean; // owner override (Slice 12.10): walk members whatever notice version they accepted
}

// True only while `until` is a valid ISO date strictly after `now`. Missing, garbage or past values are off.
export function overrideActive(value: { until?: string } | null | undefined, now: Date): boolean {
  const until = value?.until;
  if (typeof until !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(until)) return false;
  const t = Date.parse(until);
  return Number.isFinite(t) && t > now.getTime();
}

export interface MemberBackfillMember {
  userId: string | null;
  role: string;
  blocked?: boolean;
}

function defaultBudgetLeft(): number {
  const b = currentBudget();
  return b ? b.limit - b.reserve - b.used : Number.POSITIVE_INFINITY;
}

const isCandidate = (e: LoggedEvent) =>
  !e.editionId && Boolean(e.name?.trim()) && typeof e.startDate === 'string' && FULL_DATE.test(e.startDate);

export async function runMemberBackfill(
  service: LineupStore,
  members: MemberBackfillMember[],
  opts: MemberBackfillOptions = {},
): Promise<MemberBackfillReport | null> {
  const budgetLeft = opts.budgetLeft ?? defaultBudgetLeft;
  const batchSize = Math.max(1, opts.batchSize ?? MEMBER_BACKFILL_BATCH_SIZE);
  const report: MemberBackfillReport = { members: 0, created: 0, matched: 0, skipped: 0, remaining: 0 };
  let items = 0; // items started across all members this run
  let didWork = false;
  const prefetched =
    typeof service.listUserSettingsByKeys === 'function'
      ? await service.listUserSettingsByKeys([NOTICE_SETTING, MEMBER_BACKFILL_SETTING])
      : null;
  const settingsByUser = new Map<string, Map<string, unknown>>();
  if (prefetched) {
    for (const row of prefetched) {
      const m = settingsByUser.get(row.userId) ?? new Map<string, unknown>();
      m.set(row.key, row.data);
      settingsByUser.set(row.userId, m);
    }
  }

  for (const m of members) {
    if (m.role === 'owner' || m.blocked || !m.userId) continue;
    if (items >= batchSize) break;
    if (budgetLeft() < MEMBER_FIXED_COST + ITEM_COST + CURSOR_WRITE_COST) break;

    const scoped = service.forUser?.({ userId: m.userId, role: 'member' });
    if (!scoped) {
      report.skipped++;
      continue;
    }
    const cached = settingsByUser.get(m.userId);
    const notice = prefetched
      ? ((cached?.get(NOTICE_SETTING) as { version: number } | undefined) ?? null)
      : await scoped.getSetting<{ version: number }>(NOTICE_SETTING);
    if (!opts.anyNotice && notice?.version !== NOTICE_VERSION) {
      report.skipped++;
      continue;
    }
    report.members++;

    const cursor =
      (prefetched
        ? (cached?.get(MEMBER_BACKFILL_SETTING) as Cursor | undefined)
        : await scoped.getSetting<Cursor>(MEMBER_BACKFILL_SETTING)) ?? { done: [] };
    if (cursor.complete) continue;

    const done = new Set(cursor.done);
    const events = await scoped.listEvents();
    const pending: LoggedEvent[] = [];
    for (const e of events) {
      if (!isCandidate(e)) {
        report.skipped++;
        continue;
      }
      if (!done.has(e.id)) pending.push(e);
    }

    const finished: string[] = [];
    let stopped = false;
    for (const event of pending) {
      if (items >= batchSize || budgetLeft() < ITEM_COST + CURSOR_WRITE_COST) {
        stopped = true;
        break;
      }
      items++;
      didWork = true;
      try {
        const typed = (f: 'venue' | 'city') => (event.sources?.[f]?.sourceType === 'user' ? event[f] : undefined);
        const r = await upsertOccurrence(service, {
          name: event.name,
          startDate: event.startDate as string,
          ...(event.endDate && event.sources?.endDate?.sourceType === 'user' ? { endDate: event.endDate } : {}),
          venue: typed('venue'),
          city: typed('city'),
          subjectKey: seriesSlugFor(event.name),
          externalIds: [],
          trust: 'provisional',
          actor: 'member:entry',
          reason: 'Member backfill: dated entry from before the shared catalogue',
        });
        if (r.action === 'created') report.created++;
        else if (r.action === 'ambiguous' || r.action === 'skipped_no_date') report.skipped++;
        else report.matched++;
        finished.push(event.id);
      } catch (err) {
        if (err instanceof Error && err.name === 'EditionOccurrenceConflictError') {
          // Another edition holds this date, venue and subject: skip only this item (it is not retried).
          report.skipped++;
          finished.push(event.id);
          continue;
        }
        // A budget or store error stops this member; finished items are kept, the rest are retried next run.
        console.error('Member backfill stopped:', err instanceof Error ? err.message : String(err));
        stopped = true;
        break;
      }
    }

    const left = pending.length - finished.length;
    report.remaining += left;
    if (finished.length || left === 0) {
      try {
        const complete = left === 0 && !stopped;
        await scoped.putSetting<Cursor>(MEMBER_BACKFILL_SETTING, {
          done: [...cursor.done, ...finished],
          ...(complete ? { complete: true } : {}),
        });
      } catch (err) {
        console.error('Member backfill cursor not saved:', err instanceof Error ? err.message : String(err));
      }
    }
    if (stopped) break;
  }

  return didWork || report.remaining > 0 ? report : null;
}
