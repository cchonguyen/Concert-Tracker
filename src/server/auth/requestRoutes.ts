import { Router, type NextFunction, type Request, type Response } from 'express';
import { readAccessClaims } from '../share/access';
import type { MultiUserConfig } from './config';
import { clearMemberCache, NotInvitedError, resolveMember, type MemberDirectory } from './members';
import { currentMember } from './requestScope';
import { cleanSettingsPatch, type AccessRequestStore } from './requests';
import type { EmailNotifier } from '../email/notifier';

// Request access (ARCHITECTURE.md "Request access"). The public router is
// mounted before memberMiddleware: a signed-in stranger may ask, and sees only
// their own state. The owner's router sits behind the member check.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUSES = ['pending', 'accepted', 'declined'] as const;

export interface RequestRouteDeps {
  config: MultiUserConfig;
  directory: MemberDirectory;
  requests: AccessRequestStore;
  now?: () => number;
  getJson?: (url: string) => Promise<unknown>;
}

export function accessRequestRouter(deps: RequestRouteDeps): Router {
  const router = Router();
  const json = (res: Response, status: number, body: unknown) => res.status(status).set('Cache-Control', 'no-store').json(body);

  // Runs for a stranger; a member goes on to the app. The Access token is read
  // here again (keys cached), so the email and sub come from it, never a body.
  const asStranger = (answer: (email: string, sub: string | null) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = deps.now?.() ?? Date.now();
      const claims = await readAccessClaims(req.get('cf-access-jwt-assertion'), deps.config.access, now, deps.getJson as any);
      if (!claims) return json(res, 401, { error: 'Sign in required.' });
      try {
        await resolveMember(claims.email, deps.directory, now);
      } catch (err) {
        if (!(err instanceof NotInvitedError)) throw err;
        return json(res, 200, await answer(claims.email, claims.sub ?? null));
      }
      return next();
    } catch (err) {
      console.error('Request access check failed:', err instanceof Error ? err.message : String(err));
      json(res, 503, { error: 'Could not check your request. Try again.' });
    }
  };

  // One request per email, ever. Pressing again changes nothing (see requests.ts).
  router.post('/access-requests', asStranger(async (email, sub) => ({ state: await deps.requests.submit(email, sub) })));
  router.get('/access-requests/mine', asStranger(async (email, sub) => ({ state: await deps.requests.view(email, sub) })));
  return router;
}

// The owner's side, behind memberMiddleware and the owner check.
export function accessRequestOwnerRouter(requests: AccessRequestStore, notifier?: EmailNotifier): Router {
  const router = Router();
  const fail = (res: Response, err: unknown, status = 400) => res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  const ownerOnly = (_req: Request, res: Response, next: NextFunction) =>
    currentMember()?.role === 'owner' ? next() : fail(res, new Error('Only the owner can do this.'), 403);

  router.get('/access-requests', ownerOnly, async (_req, res) => {
    try {
      const [rows, settings] = await Promise.all([requests.list(), requests.settings()]);
      res.json({ requests: rows, settings, pending: rows.filter((r) => r.status === 'pending').length });
    } catch (err) {
      fail(res, err, 500);
    }
  });

  // Before /access-requests/:email, so "settings" is never read as an email.
  router.put('/access-requests/settings', ownerOnly, async (req, res) => {
    try {
      res.json({ settings: await requests.saveSettings(cleanSettingsPatch(req.body)) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Every status change, including a ban of an email that never asked (to "declined").
  router.put('/access-requests/:email', ownerOnly, async (req, res) => {
    const email = decodeURIComponent(String(req.params.email)).trim().toLowerCase();
    const to = req.body?.to;
    if (!EMAIL.test(email) || email.length > 200) return fail(res, new Error('Enter a valid email address.'));
    if (!STATUSES.includes(to)) return fail(res, new Error('Choose pending, accepted or declined.'));
    const sendEmail = req.body?.sendEmail !== false;
    try {
      await requests.setStatus(email, to);
      clearMemberCache(email);
      if (to === 'accepted' && notifier && sendEmail) {
        const mail = await notifier.sendWelcome(email);
        return res.json({ ok: true, emailSent: mail.sent, ...(mail.reason ? { emailReason: mail.reason } : {}) });
      }
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
