// The Home feature tips' saved choice, kept per account email in this browser. Storage errors are ignored:
// a blocked store just means the tips show again on the next visit.
export interface TipsSaved {
  dismissed: string[];
  allHidden: boolean;
}

export const TIPS_EVENT = 'liveArchive:tips';

export const tipsKey = (email: string | null) => `liveArchive.tips.${email ?? 'owner'}`;

export function readTips(key: string): TipsSaved {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as TipsSaved;
  } catch {
    // Fall through to the defaults.
  }
  return { dismissed: [], allHidden: false };
}

export function writeTips(key: string, saved: TipsSaved) {
  try {
    window.localStorage.setItem(key, JSON.stringify(saved));
  } catch {
    // The choice lasts for this visit only.
  }
  window.dispatchEvent(new Event(TIPS_EVENT));
}

// "Show tips again" in the Menu and About.
export function showTipsAgain(email: string | null) {
  writeTips(tipsKey(email), { dismissed: [], allHidden: false });
}
