import { dispatch } from './helpers/testApp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type express from 'express';
import { clearAccessKeys } from '../src/server/share/access.ts';
import { accessGateFromEnv, type MemberStores } from '../src/server/auth/config.ts';
import { createApiApp } from '../src/server/app.ts';
import type { PipelineDeps } from '../src/server/lineup/pipeline.ts';
import { clearMemberCache } from '../src/server/auth/members.ts';

// Every registered /api route, called as a signed-in stranger (no members row),
// must answer 403 with code "not_invited" and nothing else, except the two
// request-access calls, which answer their own state. Nothing from the archive
// may leave the server. See ARCHITECTURE.md, Public pages.

const ACCESS = { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud-1' };
const SUPABASE = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_JWT_SECRET: 'secret' };
const STRANGER = 'stranger@example.com';
const ALLOWED = new Set(['GET /api/access-requests/mine', 'POST /api/access-requests']);
// Answers before the member check, with no archive data: the Worker serves it for start-up.
const PUBLIC_ROUTES = new Set(['GET /api/health']);

async function accessFixture() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = async (email: string) => {
    const payload = { aud: ['aud-1'], iss: 'https://team.cloudflareaccess.com', exp: Math.floor(Date.now() / 1000) + 600, email, sub: `sub-${email}` };
    const data = `${enc({ alg: 'RS256', kid: 'k1' })}.${enc(payload)}`;
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(data));
    return `${data}.${Buffer.from(sig).toString('base64url')}`;
  };
  return { token, keys: { keys: [jwk] } };
}

// Every route the API registers, from the Express router stack (routers mount under /api).
function registeredRoutes(app: express.Express): string[] {
  const found = new Set<string>();
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) found.add(`${method.toUpperCase()} ${prefix}${layer.route.path}`);
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, '/api');
      }
    }
  };
  walk((app as any).router.stack, '');
  return [...found].map((r) => r.replace(/:(\w+)/g, 'x'));
}

test('every /api route refuses a stranger with not_invited, except the two request-access calls', async (t) => {
  clearMemberCache();
  clearAccessKeys();
  const fixture = await accessFixture();
  // The key set comes from the team's certificate URL; serve it locally. Calls to the test server use the real fetch.
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/cdn-cgi/access/certs')) return Response.json(fixture.keys);
    return realFetch(input, init);
  });

  // A store that holds no members and no requests: a stranger is never found.
  const store = {
    findMember: async () => null,
    createAuthUser: async () => 'u',
    linkMember: async () => {},
    listMembers: async () => [],
    inviteMember: async () => {},
    removeMember: async () => {},
    hasActiveUser: async () => false,
    submit: async () => 'sent',
    view: async () => 'none',
    list: async () => [],
    pendingCount: async () => 0,
    settings: async () => ({ paused: false, cap: 20 }),
    saveSettings: async () => ({ paused: false, cap: 20 }),
    setStatus: async () => {},
  } as unknown as MemberStores;
  const gate = accessGateFromEnv({ ...ACCESS, ...SUPABASE, MULTI_USER: 'on' }, () => store);
  assert.equal(gate.kind, 'multi');

  const app = createApiApp({ store: {} } as unknown as PipelineDeps, { kick: async () => {} } as any, gate);
  const token = await fixture.token(STRANGER);

  const routes = registeredRoutes(app);
  assert.ok(routes.length > 20, `only ${routes.length} routes were found`);
  const seen: string[] = [];
  for (const route of routes) {
    if (PUBLIC_ROUTES.has(route)) continue;
    const [method, path] = route.split(' ');
    const res = await dispatch(app, {
      method,
      url: path,
      headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': token },
      body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
    });
    const body = (() => {
      try {
        return res.json<Record<string, unknown>>();
      } catch {
        return {};
      }
    })();
    seen.push(route);
    if (ALLOWED.has(route)) {
      assert.equal(res.status, 200, route);
      assert.deepEqual(Object.keys(body), ['state'], `${route} answers its own state only`);
    } else {
      assert.equal(res.status, 403, route);
      assert.equal(body.code, 'not_invited', route);
      assert.deepEqual(Object.keys(body).sort(), ['code', 'email', 'error'], `${route} answers the refusal only`);
      assert.equal(body.email, STRANGER, route);
    }
  }
  assert.deepEqual(seen.filter((r) => ALLOWED.has(r)).sort(), [...ALLOWED].sort(), 'both request-access calls were checked');
});
