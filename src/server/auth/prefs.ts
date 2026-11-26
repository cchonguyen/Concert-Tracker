import { Router } from 'express';
import type { LineupStore } from '../lineup/store/types';
import { ARTIST_MILESTONES, MILESTONES } from '../../services/milestones';

// The Home tips and the milestone mark, kept on the account (user_settings in
// multi-user, app_settings for a single owner) instead of in each browser.
// See ARCHITECTURE.md ("Home" and "Milestones") and migration 0027.

export const TIPS_SETTING = 'tips';
export const MILESTONE_SETTING = 'milestone';

// Tile keys are short lowercase words (src/components/FeatureTiles.tsx). The
// server only checks their shape, so a new tile needs no change here.
const TILE_KEY = /^[a-z]{1,20}$/;
const MAX_DISMISSED = 20;
// Page tip keys: lowercase words joined by hyphens ("archive-changes").
const TIP_KEY = /^[a-z]+(-[a-z]+)*$/;
const MAX_TIPS = 30;
const MAX_VISITS = 10;

// dismissed and allHidden are the first Home-cards choice; the rest are the page tips
// (src/services/tips.ts, docs/specs/quiet-tips-table.md). Older saves have only the first two.
export interface TipsSaved {
  dismissed: string[];
  allHidden: boolean;
  visits?: Record<string, number>;
  choice?: Record<string, 'on' | 'off'>;
  showAll?: boolean;
  folded?: string[];
}

// The highest milestone shown for each kind of card; 0 when none yet.
export interface MilestoneSaved {
  shows: number;
  artists: number;
}

export interface Prefs {
  tips: TipsSaved | null; // null until the account has saved a choice
  milestone: MilestoneSaved;
}

export const NO_MILESTONE: MilestoneSaved = { shows: 0, artists: 0 };

export class PrefsError extends Error {}

// Checks a tips choice sent by the page. Throws PrefsError for anything else.
export function cleanTips(input: unknown): TipsSaved {
  if (!input || typeof input !== 'object') throw new PrefsError('Tips must be an object.');
  const { dismissed = [], allHidden = false, visits, choice, showAll, folded } = input as Record<string, unknown>;
  if (!Array.isArray(dismissed) || dismissed.length > MAX_DISMISSED) throw new PrefsError('Dismissed tips must be a short list.');
  if (!dismissed.every((k) => typeof k === 'string' && TILE_KEY.test(k))) throw new PrefsError('Each dismissed tip must be a tile key.');
  if (typeof allHidden !== 'boolean') throw new PrefsError('allHidden must be true or false.');
  const out: TipsSaved = { dismissed: [...new Set(dismissed as string[])], allHidden };
  if (visits !== undefined) out.visits = tipMap(visits, 'Visits', (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_VISITS);
  if (choice !== undefined) out.choice = tipMap(choice, 'Tip choices', (v) => v === 'on' || v === 'off');
  if (showAll !== undefined) {
    if (typeof showAll !== 'boolean') throw new PrefsError('showAll must be true or false.');
    out.showAll = showAll;
  }
  if (folded !== undefined) {
    if (!Array.isArray(folded) || folded.length > MAX_TIPS || !folded.every((k) => typeof k === 'string' && TIP_KEY.test(k))) {
      throw new PrefsError('Folded tips must be a short list of tip keys.');
    }
    out.folded = [...new Set(folded as string[])];
  }
  return out;
}

function tipMap<T>(input: unknown, name: string, ok: (v: unknown) => boolean): Record<string, T> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PrefsError(`${name} must be an object.`);
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_TIPS) throw new PrefsError(`${name} must be a short list.`);
  for (const [k, v] of entries) {
    if (!TIP_KEY.test(k) || !ok(v)) throw new PrefsError(`${name} must use tip keys and allowed values.`);
  }
  return Object.fromEntries(entries) as Record<string, T>;
}

// Checks a milestone patch: any of shows (a MILESTONES count) and artists (an ARTIST_MILESTONES count), each 0 for none.
export function cleanMilestone(input: unknown): Partial<MilestoneSaved> {
  if (!input || typeof input !== 'object') throw new PrefsError('Milestone must be an object.');
  const { shows, artists } = input as Record<string, unknown>;
  const out: Partial<MilestoneSaved> = {};
  if (shows !== undefined) {
    if (shows !== 0 && !(MILESTONES as readonly number[]).includes(shows as number)) throw new PrefsError('Shows milestone must be a milestone count.');
    out.shows = shows as number;
  }
  if (artists !== undefined) {
    if (artists !== 0 && !(ARTIST_MILESTONES as readonly number[]).includes(artists as number)) throw new PrefsError('Artists milestone must be a milestone count.');
    out.artists = artists as number;
  }
  return out;
}

export function prefsRouter(store: LineupStore): Router {
  const router = Router();
  const fail = (res: any, err: unknown, status = 400) => res.status(status).json({ error: err instanceof Error ? err.message : String(err) });

  async function read(): Promise<Prefs> {
    const [tips, milestone] = await Promise.all([
      store.getSetting<TipsSaved>(TIPS_SETTING),
      store.getSetting<MilestoneSaved>(MILESTONE_SETTING),
    ]);
    return { tips: tips ?? null, milestone: { ...NO_MILESTONE, ...(milestone ?? {}) } };
  }

  router.get('/me/prefs', async (_req, res) => {
    try {
      res.json(await read());
    } catch (err) {
      fail(res, err, 500);
    }
  });

  // Sends any of { tips, milestone }. Each milestone kind only ever moves up, so an
  // older browser that sends a lower count cannot bring the card back.
  router.put('/me/prefs', async (req, res) => {
    const body = req.body ?? {};
    try {
      const tips = body.tips === undefined ? undefined : cleanTips(body.tips);
      const milestone = body.milestone === undefined ? undefined : cleanMilestone(body.milestone);
      if (tips) await store.putSetting(TIPS_SETTING, tips);
      if (milestone) {
        const current = { ...NO_MILESTONE, ...((await store.getSetting<MilestoneSaved>(MILESTONE_SETTING)) ?? {}) };
        const next = { shows: Math.max(current.shows, milestone.shows ?? 0), artists: Math.max(current.artists, milestone.artists ?? 0) };
        await store.putSetting(MILESTONE_SETTING, next);
      }
      res.json(await read());
    } catch (err) {
      fail(res, err, err instanceof PrefsError ? 400 : 500);
    }
  });

  return router;
}
