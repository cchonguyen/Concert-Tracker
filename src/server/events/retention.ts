// Retention for the Recently deleted trash and the Log. The nightly job calls runRetention once a day.
// Trash is kept 90 days; the Log is kept one year.

export const TRASH_DAYS = 90;
export const LOG_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// The job runs every minute from the worker's cron. Only the 03:00 UTC tick does the work.
export function isRetentionTime(now: Date): boolean {
  return now.getUTCHours() === 3 && now.getUTCMinutes() === 0;
}

export function retentionCutoffs(now: Date): { trashBefore: string; logBefore: string } {
  return {
    trashBefore: new Date(now.getTime() - TRASH_DAYS * DAY_MS).toISOString(),
    logBefore: new Date(now.getTime() - LOG_DAYS * DAY_MS).toISOString(),
  };
}

export interface RetentionStore {
  purgeDeletedEvents(olderThan: string): Promise<number>;
  purgeActivity(olderThan: string): Promise<number>;
}

export async function runRetention(store: RetentionStore, now: Date): Promise<{ events: number; activity: number }> {
  const cutoffs = retentionCutoffs(now);
  const events = await store.purgeDeletedEvents(cutoffs.trashBefore);
  const activity = await store.purgeActivity(cutoffs.logBefore);
  return { events, activity };
}
