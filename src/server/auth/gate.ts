import type { NextFunction, Request, Response } from 'express';
import { readAccessClaims, type AccessConfig } from '../share/access';

// The guards for the two single-owner gates (config.ts). Multi-user uses
// memberMiddleware (requestScope.ts). Each answers every /api request it
// refuses, so no route behind it runs.

const refuse = (res: Response, status: number, error: string) => res.status(status).set('Cache-Control', 'no-store').json({ error });

// Single-owner: the Access sign-in must be OWNER_EMAIL. Anyone else is 403.
export function ownerMiddleware(deps: { access: AccessConfig; ownerEmail: string; getJson?: (url: string) => Promise<unknown>; now?: () => number }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const claims = await readAccessClaims(req.get('cf-access-jwt-assertion'), deps.access, deps.now?.() ?? Date.now(), deps.getJson);
      if (!claims) return refuse(res, 401, 'Sign in required.');
      if (claims.email !== deps.ownerEmail) return refuse(res, 403, 'This account does not have access.');
      next();
    } catch (err) {
      console.error('Owner check failed:', err instanceof Error ? err.message : String(err));
      refuse(res, 503, 'Could not check who you are. Try again.');
    }
  };
}

// Closed: the config cannot be read, so nothing under /api runs.
export function closedMiddleware(reason: string) {
  console.error(`Access is closed: ${reason}`);
  return (_req: Request, res: Response) => refuse(res, 503, 'Access is not configured. Nothing is shown until it is.');
}

// Local development: /api answers only to this machine. A request is let
// through only when it arrives on loopback, with no forwarding header (a proxy
// or tunnel would add one) and a loopback Host. The dev server listens on
// 127.0.0.1 in this mode, so nothing else can reach it.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export function isLocalRequest(req: Request): boolean {
  const address = req.socket.remoteAddress ?? '';
  if (!LOOPBACK.has(address)) return false;
  if (req.get('x-forwarded-for') || req.get('forwarded') || req.get('cf-connecting-ip')) return false;
  return LOOPBACK_HOST.test(req.get('host') ?? '');
}

export function localOwnerMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isLocalRequest(req)) return refuse(res, 403, 'Local development only.');
    next();
  };
}
