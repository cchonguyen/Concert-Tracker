import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import type { LineupStore } from '../lineup/store/types';
import { readAccessClaims } from '../share/access';
import type { MultiUserConfig } from './config';
import { NotInvitedError, resolveMember, type MemberDirectory, type SignedInMember } from './members';
import { mintSupabaseToken } from './supabaseJwt';

// Multi-user requests. Every /api request names its member: the Access token
// is read again here (keys cached, no request), the email is looked up in the
// invite list, and the request runs with a store limited to that member's
// rows (LineupStore.forUser), holding a 60-second Supabase token for row
// level security. The routes are unchanged: they keep calling deps.store,
// which is a stand-in that hands each call to the current request's store.

interface RequestContext {
  member: SignedInMember;
  store: LineupStore;
}

const context = new AsyncLocalStorage<RequestContext>();

export const currentMember = (): SignedInMember | null => context.getStore()?.member ?? null;

// deps.store for the API in multi-user mode. Inside a request it is that
// member's store. Outside one it is the system store: every /api request
// passes memberMiddleware first, so only the job runner and startup get here.
export function requestScopedStore(base: LineupStore): LineupStore {
  return new Proxy(base, {
    get(target, prop, receiver) {
      const scoped = context.getStore()?.store;
      const from = scoped ?? target;
      const value = Reflect.get(from, prop, scoped ? from : receiver);
      return typeof value === 'function' ? value.bind(from) : value;
    },
  });
}

// Run fn as this member, as the middleware does. For tests and for code that
// acts for a member outside a request (none yet).
export function runAsMember<T>(member: SignedInMember, store: LineupStore, fn: () => T): T {
  return context.run({ member, store }, fn);
}

// Routes a member (not the owner) may not use until their data is split per
// member: Manage and its records (people are shared records today), genre
// edits (yours win for everyone),
// Sheets and the server's Gmail check (one stored Google sign-in each).
// Lineup lookups are open to members: their review (confirmLookupForMember)
// writes only their own event.
const OWNER_ONLY: Array<[method: string | null, pattern: RegExp]> = [
  [null, /^\/api\/sheets(\/|$)/],
  [null, /^\/api\/gmail(\/|$)/],
  ['POST', /^\/api\/imports\/(email|scan)$/],
  // The music-story export is the owner's listening data, and MusicBrainz tags
  // are read through its genre map; members set their own genres (PUT).
  ['POST', /^\/api\/artist-genres\//],
];

export function ownerOnly(method: string, path: string): boolean {
  return OWNER_ONLY.some(([m, re]) => (!m || m === method) && re.test(path));
}

export interface MemberMiddlewareDeps {
  config: MultiUserConfig;
  directory: MemberDirectory;
  base: LineupStore;
  now?: () => number;
  getJson?: (url: string) => Promise<unknown>;
}

export function memberMiddleware(deps: MemberMiddlewareDeps) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const refuse = (status: number, error: string) => res.status(status).set('Cache-Control', 'no-store').json({ error });
    try {
      const now = deps.now?.() ?? Date.now();
      const claims = await readAccessClaims(req.get('cf-access-jwt-assertion'), deps.config.access, now, deps.getJson as any);
      if (!claims) return refuse(401, 'Sign in required.');
      const member = await resolveMember(claims.email, deps.directory, now);
      if (member.role !== 'owner' && ownerOnly(req.method, req.originalUrl.split('?')[0])) {
        return refuse(403, 'Only the owner can use this for now.');
      }
      if (!deps.base.forUser) throw new Error('This store cannot be limited to one member.');
      const token = await mintSupabaseToken(member, deps.config.jwtSecret, now);
      const db = createClient(deps.config.supabaseUrl, deps.config.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      const store = deps.base.forUser({ userId: member.userId, role: member.role, db: deps.base.kind === 'supabase' ? db : undefined });
      context.run({ member, store }, next);
    } catch (err) {
      if (err instanceof NotInvitedError) return refuse(403, err.message);
      console.error('Member check failed:', err instanceof Error ? err.message : String(err));
      return refuse(503, 'Could not check who you are. Try again.');
    }
  };
}
