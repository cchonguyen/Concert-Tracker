import type { TipsSaved } from '../server/auth/prefs';

// When a page tip shows (docs/specs/quiet-tips-table.md). Pure rules; the account keeps the state
// (src/server/auth/prefs.ts) and src/components/ui/TipsContext.tsx reads and saves it.
//
// A tip shows on its first FOLD_AFTER visits, then folds away into the ? in the header.
// Your choice for a tip (the ? or the ×) wins over the visit rule. "Show all tips" shows every tip
// and stops them folding until you hide one.

export type TipKey = 'home' | 'summary' | 'table' | 'manage' | 'archive-changes' | 'canonical-artist';
export const FOLD_AFTER = 3;

export interface TipsState {
  visits: Record<string, number>; // capped at FOLD_AFTER + 1
  choice: Record<string, 'on' | 'off'>;
  showAll: boolean;
  folded: string[]; // tips whose first fold has been pointed out with the nudge
}

export const NO_TIPS: TipsState = { visits: {}, choice: {}, showAll: false, folded: [] };

// Reads what the account has. An older saved choice still counts: Home hidden becomes a hide of `home`.
export function readTips(saved: TipsSaved | null): TipsState {
  if (!saved) return NO_TIPS;
  const choice = { ...(saved.choice ?? {}) };
  if (saved.allHidden && !choice.home) choice.home = 'off';
  return { visits: { ...(saved.visits ?? {}) }, choice, showAll: saved.showAll ?? false, folded: [...(saved.folded ?? [])] };
}

// What the account stores. The old fields stay so an older open page still reads it.
export function saveTips(s: TipsState): TipsSaved {
  return { dismissed: [], allHidden: false, visits: s.visits, choice: s.choice, showAll: s.showAll, folded: s.folded };
}

export function isShown(s: TipsState, key: string): boolean {
  const c = s.choice[key];
  if (s.showAll) return c !== 'off';
  if (c) return c === 'on';
  return (s.visits[key] ?? 0) <= FOLD_AFTER;
}

// One more visit to a page with this tip. Returns the same state once the count stops mattering,
// so the caller can skip the save.
export function recordVisit(s: TipsState, key: string): TipsState {
  const n = s.visits[key] ?? 0;
  if (n > FOLD_AFTER) return s;
  return { ...s, visits: { ...s.visits, [key]: n + 1 } };
}

// The ? or the × on these tips: on shows them, off hides them.
export function chooseTips(s: TipsState, keys: string[], on: boolean): TipsState {
  const choice = { ...s.choice };
  for (const k of keys) choice[k] = on ? 'on' : 'off';
  return { ...s, choice, folded: [...new Set([...s.folded, ...keys])] };
}

// The Menu switch. Either way your earlier choices are cleared: on shows every tip, off goes back to the visit rule.
// Tips already past their visits count as pointed out, so switching off does not set off a nudge.
export function setShowAll(s: TipsState, on: boolean): TipsState {
  const past = Object.keys(s.visits).filter((k) => (s.visits[k] ?? 0) > FOLD_AFTER);
  return { ...s, showAll: on, choice: {}, folded: on ? s.folded : [...new Set([...s.folded, ...past])] };
}

// True the first time a tip is folded away by the visit rule alone: the ? gives a short nudge, once.
export const needsNudge = (s: TipsState, key: string): boolean => !isShown(s, key) && !s.choice[key] && !s.folded.includes(key);

export const markFolded = (s: TipsState, keys: string[]): TipsState => ({ ...s, folded: [...new Set([...s.folded, ...keys])] });
