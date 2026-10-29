import { Router } from 'express';
import { clearMemberCache, type MemberDirectory } from './members';
import { currentMember } from './requestScope';

// GET /api/me tells the page who is signed in, so it can hide what a member
// cannot use. /api/members is the owner's invite list.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function singleOwnerMeRouter(): Router {
  const router = Router();
  router.get('/me', (_req, res) => res.json({ multiUser: false, role: 'owner', email: null }));
  return router;
}

export function membersRouter(directory: MemberDirectory): Router {
  const router = Router();
  const fail = (res: any, err: unknown, status = 400) => res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  const ownerOnly = (_req: any, res: any, next: any) => (currentMember()?.role === 'owner' ? next() : fail(res, new Error('Only the owner can do this.'), 403));

  router.get('/me', (_req, res) => {
    const me = currentMember();
    res.json({ multiUser: true, role: me?.role ?? 'member', email: me?.email ?? null });
  });

  router.get('/members', ownerOnly, async (_req, res) => {
    try {
      res.json({ members: (await directory.listMembers()).map((m) => ({ email: m.email, role: m.role, joined: Boolean(m.userId), invitedAt: m.invitedAt })) });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  router.post('/members', ownerOnly, async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email) || email.length > 200) return fail(res, new Error('Enter a valid email address.'));
    try {
      await directory.inviteMember(email);
      res.status(201).json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/members/:email', ownerOnly, async (req, res) => {
    const email = decodeURIComponent(req.params.email).trim().toLowerCase();
    try {
      await directory.removeMember(email);
      clearMemberCache(email);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
