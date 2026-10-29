import { Router } from 'express';
import { clearMemberCache, type MemberDirectory } from './members';
import { currentMember } from './requestScope';
import type { LineupStore } from '../lineup/store/types';

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

// Your data, on your request. Export is everything saved under your account
// as stored (an encrypted note stays encrypted; the browser decrypts it).
// Deleting removes your Supabase Auth user and, by cascade, your events,
// imports, lookups, share links and settings. Supabase backups keep deleted
// rows until the backup window ends. The owner's account is not deletable here.
export function accountRouter(directory: MemberDirectory, store: LineupStore): Router {
  const router = Router();
  const fail = (res: any, status: number, error: string) => res.status(status).json({ error });

  router.get('/account/export', async (_req, res) => {
    try {
      const me = currentMember();
      const [events, imports, links, jobs, entities] = await Promise.all([
        store.listEvents(),
        store.listImports(),
        store.listShareLinks(),
        store.listJobs(1000),
        store.listEntities().catch(() => []),
      ]);
      res.set('Content-Disposition', 'attachment; filename="liveArchive-export.json"');
      res.json({
        exportedAt: new Date().toISOString(),
        account: { email: me?.email ?? null, role: me?.role ?? null },
        // Notes and the people who went are encrypted when the vault is on; the
        // browser decrypts them into the file you download (services/exportBundle.ts).
        events,
        // Your records. A person with a vault has an encrypted name (nameEncrypted).
        records: entities.map((e) => ({
          id: e.id,
          kind: e.kind,
          name: e.name,
          ...(e.nameEncrypted ? { nameEncrypted: e.nameEncrypted } : {}),
          attrs: e.attrs,
          mergedIntoId: e.mergedIntoId ?? null,
        })),
        emailImports: imports,
        // The link's code is never kept, so only its settings and dates are exported.
        shareLinks: links.map((l) => ({ id: l.id, createdAt: l.createdAt, revokedAt: l.revokedAt ?? null, settings: l.settings })),
        lookups: jobs.map((j) => ({ id: j.id, eventId: j.eventId ?? null, status: j.status, createdAt: j.createdAt })),
      });
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  router.delete('/account', async (req, res) => {
    const me = currentMember();
    if (!me) return fail(res, 401, 'Sign in required.');
    if (me.role === 'owner') return fail(res, 403, 'The owner account cannot be deleted here.');
    if (typeof req.body?.confirm !== 'string' || req.body.confirm.trim().toLowerCase() !== me.email) {
      return fail(res, 400, 'Type your email address to confirm.');
    }
    try {
      await directory.removeMember(me.email);
      clearMemberCache(me.email);
      res.json({ ok: true });
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  return router;
}
