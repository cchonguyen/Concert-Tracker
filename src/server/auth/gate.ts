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
