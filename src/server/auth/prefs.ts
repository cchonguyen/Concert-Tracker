import { Router } from 'express';
import type { LineupStore } from '../lineup/store/types';
import { MILESTONES } from '../../services/milestones';

// The Home tips and the milestone mark, kept on the account (user_settings in
// multi-user, app_settings for a single owner) instead of in each browser.
// See ARCHITECTURE.md ("Home" and "Milestones") and migration 0027.

export const TIPS_SETTING = 'tips';
export const MILESTONE_SETTING = 'milestone';

// Tile keys are short lowercase words (src/components/FeatureTiles.tsx). The
// server only checks their shape, so a new tile needs no change here.
const TILE_KEY = /^[a-z]{1,20}$/;
const MAX_DISMISSED = 20;

export interface TipsSaved {
  dismissed: string[];
  allHidden: boolean;
}

export interface Prefs {
  tips: TipsSaved | null; // null until the account has saved a choice
  milestone: number; // the highest milestone shown so far; 0 when none
}

export class PrefsError extends Error {}

// Checks a tips choice sent by the page. Throws PrefsError for anything else.
export function cleanTips(input: unknown): TipsSaved {
  if (!input || typeof input !== 'object') throw new PrefsError('Tips must be an object.');
  const { dismissed, allHidden } = input as Record<string, unknown>;
  if (!Array.isArray(dismissed) || dismissed.length > MAX_DISMISSED) throw new PrefsError('Dismissed tips must be a short list.');
  if (!dismissed.every((k) => typeof k === 'string' && TILE_KEY.test(k))) throw new PrefsError('Each dismissed tip must be a tile key.');
  if (typeof allHidden !== 'boolean') throw new PrefsError('allHidden must be true or false.');
  return { dismissed: [...new Set(dismissed as string[])], allHidden };
}

// A milestone is one of the counts in services/milestones.ts, or 0 for none.
export function cleanMilestone(input: unknown): number {
  if (input === 0) return 0;
  if (!(MILESTONES as readonly number[]).includes(input as number)) throw new PrefsError('Milestone must be one of the milestone counts.');
  return input as number;
}

export function prefsRouter(store: LineupStore): Router {
  const router = Router();
  const fail = (res: any, err: unknown, status = 400) => res.status(status).json({ error: err instanceof Error ? err.message : String(err) });

  async function read(): Promise<Prefs> {
    const [tips, milestone] = await Promise.all([
      store.getSetting<TipsSaved>(TIPS_SETTING),
      store.getSetting<{ shown: number }>(MILESTONE_SETTING),
    ]);
    return { tips: tips ?? null, milestone: milestone?.shown ?? 0 };
  }

  router.get('/me/prefs', async (_req, res) => {
    try {
      res.json(await read());
    } catch (err) {
      fail(res, err, 500);
    }
  });

  // Sends any of { tips, milestone }. The milestone only ever moves up, so an
  // older browser that sends a lower count cannot bring the card back.
  router.put('/me/prefs', async (req, res) => {
    const body = req.body ?? {};
    try {
      const tips = body.tips === undefined ? undefined : cleanTips(body.tips);
      const milestone = body.milestone === undefined ? undefined : cleanMilestone(body.milestone);
      if (tips) await store.putSetting(TIPS_SETTING, tips);
      if (milestone !== undefined) {
        const current = (await store.getSetting<{ shown: number }>(MILESTONE_SETTING))?.shown ?? 0;
        if (milestone > current) await store.putSetting(MILESTONE_SETTING, { shown: milestone });
      }
      res.json(await read());
    } catch (err) {
      fail(res, err, err instanceof PrefsError ? 400 : 500);
    }
  });

  return router;
}
