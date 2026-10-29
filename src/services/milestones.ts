import type { LoggedEvent } from '../server/events/types';
import { wentTo } from '../server/events/attendance';
import { distinctActs } from './home';

// The show counts that earn a card and a burst of confetti. Only the highest one crossed in a single change is shown,
// so a bulk import that jumps several milestones shows one card.
export const MILESTONES = [1, 10, 50, 100, 250, 500, 1000] as const;

// The distinct-artist counts that earn the same card. Only acts seen at events you went to count (see distinctActs).
export const ARTIST_MILESTONES = [100] as const;

export function highestMilestoneCrossed(before: number, after: number, marks: readonly number[] = MILESTONES): number | null {
  let hit: number | null = null;
  for (const m of marks) if (before < m && after >= m) hit = m;
  return hit;
}

// Both counts the cards watch: every show in the log, and the distinct acts seen at the shows you went to.
export interface MilestoneCounts {
  shows: number;
  artists: number;
}

export function milestoneCounts(events: LoggedEvent[], today: string): MilestoneCounts {
  return { shows: events.length, artists: distinctActs(wentTo(events, today)) };
}

// The card text for each milestone. The count is written in by the caller for the big ones.
export function milestoneLine(m: number): string {
  if (m === 1) return 'Your archive has begun.';
  if (m === 10) return '10 shows in. The best is still ahead.';
  if (m === 50) return "50 shows. That's a lot of nights out!";
  if (m === 100) return '100 shows! Triple digits.';
  return `${m.toLocaleString()} shows! You're a legend of the floor.`;
}

export function artistMilestoneLine(m: number): string {
  if (m === 100) return "100 artists seen! That's a lineup you built yourself.";
  return `${m.toLocaleString()} artists seen! Quite a lineup.`;
}

// Records that a milestone was shown for this account, so it fires once. Returns false when it was shown before.
// Without storage the card can repeat on reload; the card itself still works, so it returns true.
export function claimMilestone(key: string, hit: number): boolean {
  try {
    if (Number(window.localStorage.getItem(key) ?? 0) >= hit) return false;
    window.localStorage.setItem(key, String(hit));
  } catch {
    // Storage is unavailable or full; see above.
  }
  return true;
}
