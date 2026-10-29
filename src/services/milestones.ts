import { wentTo } from '../server/events/attendance';
import type { LoggedEvent } from './lineupApi';

// The show counts that earn a card and a burst of confetti. Only the highest one crossed in a single change is shown,
// so a bulk import that jumps several milestones shows one card.
export const MILESTONES = [1, 10, 50, 100, 250, 500, 1000] as const;

// Artists you have seen live, counted from the events you went to (the same count the Ranking page shows).
export const ARTIST_MILESTONES = [100] as const;

export function highestMilestoneCrossed(before: number, after: number, list: readonly number[] = MILESTONES): number | null {
  let hit: number | null = null;
  for (const m of list) if (before < m && after >= m) hit = m;
  return hit;
}

export function seenArtistCount(events: LoggedEvent[], today: string): number {
  return new Set(wentTo(events, today).flatMap((e) => e.seen.map((s) => s.key))).size;
}

export function artistMilestoneLine(m: number): string {
  return `${m} artists seen live!`;
}

// The card text for each milestone. The count is written in by the caller for the big ones.
export function milestoneLine(m: number): string {
  if (m === 1) return 'Your archive has begun.';
  if (m === 10) return '10 shows in. The best is still ahead.';
  if (m === 50) return "50 shows. That's a lot of nights out!";
  if (m === 100) return '100 shows! Triple digits.';
  return `${m.toLocaleString()} shows! You're a legend of the floor.`;
}
