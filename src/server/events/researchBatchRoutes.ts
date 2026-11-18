import { Router } from 'express';
import type { LineupStore } from '../lineup/store/types';
import { currentMember } from '../auth/requestScope';
import { membersResearchOn, RESEARCH_MEMBERS_SETTING } from './backfillResearch';

// Slice 3.4 owner control: whether the event research batch also runs for accepted members. Off by default.
// The owner switches it in Manage (MembersPanel); a member gets 403.
export function researchBatchRouter(store: LineupStore): Router {
  const router = Router();
  const fail = (res: any, err: unknown, status = 400) => res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  const ownerOnly = (_req: any, res: any, next: any) => (currentMember()?.role === 'owner' ? next() : fail(res, new Error('Only the owner can do this.'), 403));

  router.get('/members/research-batch', ownerOnly, async (_req, res) => {
    try {
      const value = await store.getSetting<{ on?: boolean }>(RESEARCH_MEMBERS_SETTING);
      res.json({ on: membersResearchOn(value) });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  router.put('/members/research-batch', ownerOnly, async (req, res) => {
    if (typeof req.body?.on !== 'boolean') return fail(res, new Error('on must be true or false.'));
    try {
      await store.putSetting(RESEARCH_MEMBERS_SETTING, { on: req.body.on, changedAt: new Date().toISOString() });
      res.json({ on: req.body.on });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  return router;
}
