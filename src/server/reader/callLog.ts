import type { AiCallRow, LineupStore } from '../lineup/store/types';

// One insert per call. Counts and sizes only: never page text, prompts, quotes or names.
// A failed write never fails the read; it is counted under reader:logfail:<YYYY-MM-DD> (best effort).
export async function logCall(store: LineupStore, row: AiCallRow, now: Date = new Date()): Promise<void> {
  try {
    await store.addAiCall(row);
    return;
  } catch {
    console.warn('ai call log write failed');
  }
  try {
    const key = `reader:logfail:${now.toISOString().slice(0, 10)}`;
    const cur = (await store.getQuota(key)) ?? { key, used: 0 };
    await store.setQuota({ ...cur, used: cur.used + 1 });
  } catch {
    // best effort
  }
}
