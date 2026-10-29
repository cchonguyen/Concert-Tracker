import { prefsApi } from './lineupApi';
import type { Prefs, TipsSaved } from '../server/auth/prefs';

// The Home tips and the milestone mark live on the account (src/server/auth/prefs.ts). This module keeps one
// read of them per page, so Home, the Menu and About share it. Storage errors and a dropped connection leave
// the page with the last copy it read; the next load asks the account again.
export const TIPS_EVENT = 'liveArchive:tips';
export const DEFAULT_TIPS: TipsSaved = { dismissed: [], allHidden: false };

let cache: Promise<Prefs> | null = null;

// Tips and the milestone mark used to be kept in each browser's localStorage. The first read after this change
// sends what this browser has to the account. Tips go only when the account has none yet, and the milestone
// only ever moves up on the server, so a newer copy on the account is never overwritten.
const tipsLocalKey = (email: string | null) => `liveArchive.tips.${email ?? 'owner'}`;
const milestoneLocalKey = (email: string | null) => `liveArchive.milestone.${email ?? 'owner'}`;

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function forgetLocal(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to remove if storage is blocked.
  }
}

async function fetchAndMove(email: string | null): Promise<Prefs> {
  let prefs = await prefsApi.get();
  try {
    const localTips = readLocal(tipsLocalKey(email));
    if (prefs.tips === null && localTips) {
      prefs = await prefsApi.saveTips(JSON.parse(localTips) as TipsSaved);
    }
    if (prefs.tips !== null) forgetLocal(tipsLocalKey(email));
    const localMilestone = Number(readLocal(milestoneLocalKey(email)) ?? 0);
    if (localMilestone > 0) {
      prefs = await prefsApi.saveMilestone(localMilestone);
      forgetLocal(milestoneLocalKey(email));
    }
  } catch {
    // Keep this browser's copy and try again on the next read.
  }
  return prefs;
}

export function loadPrefs(email: string | null): Promise<Prefs> {
  cache ??= fetchAndMove(email).catch((err) => {
    cache = null;
    throw err;
  });
  return cache;
}

// Saves the tips choice. The tiles listen for TIPS_EVENT and read it again. A failed save asks the account again.
export async function writeTips(saved: TipsSaved) {
  try {
    cache = Promise.resolve(await prefsApi.saveTips(saved));
  } catch {
    cache = null;
  }
  window.dispatchEvent(new Event(TIPS_EVENT));
}

// "Show tips again" in the Menu and About.
export const showTipsAgain = () => writeTips(DEFAULT_TIPS);

// Records a milestone shown on this page. A failed save means the card may show again after a reload.
export function recordMilestone(milestone: number) {
  prefsApi.saveMilestone(milestone).then(
    (prefs) => {
      cache = Promise.resolve(prefs);
    },
    () => {
      cache = null;
    },
  );
}
