import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { accessConfigFromEnv, clearAccessKeys } from '../src/server/share/access.ts';
import { accessGateFromEnv, workerSettings } from '../src/server/auth/config.ts';
import { ownerMiddleware } from '../src/server/auth/gate.ts';
import { createApiApp } from '../src/server/app.ts';
import type { MemberDirectory } from '../src/server/auth/members.ts';
import type { PipelineDeps } from '../src/server/lineup/pipeline.ts';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const OWNER = 'owner@example.com';
const FRIEND = 'friend@example.com'; // the second test account
const ACCESS = { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud-1' };
const SUPABASE = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_JWT_SECRET: 'secret' };
const OWNER_ENV = { ...ACCESS, OWNER_EMAIL: OWNER };
const noDirectory = () => {
  throw new Error('the member directory must not be read here');
};

async function accessFixture() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
  const config = accessConfigFromEnv(ACCESS)!;
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tokenFor = async (email: string) => {
    const payload = { aud: ['aud-1'], iss: 'https://team.cloudflareaccess.com', exp: Math.floor(Date.now() / 1000) + 600, email, sub: `sub-${email}` };
    const data = `${enc({ alg: 'RS256', kid: 'k1' })}.${enc(payload)}`;
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(data));
    return `${data}.${Buffer.from(sig).toString('base64url')}`;
  };
  clearAccessKeys();
  return { config, tokenFor, getJson: async () => ({ keys: [jwk] }) };
}

async function serve(app: express.Express, t: { after: (fn: () => void) => void }) {
  const listening = app.listen(0);
  await new Promise((resolve) => listening.once('listening', resolve));
  t.after(() => listening.close());
  return `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
}

const gateFor = (env: Record<string, string | undefined>) => accessGateFromEnv(env, noDirectory);

test('single-owner is the default: MULTI_USER unset, "" or "off" gives the owner gate', () => {
  for (const MULTI_USER of [undefined, '', 'off', ' OFF ']) {
    const gate = gateFor({ ...OWNER_ENV, MULTI_USER });
    assert.equal(gate.kind, 'owner', `MULTI_USER=${JSON.stringify(MULTI_USER)}`);
  }
});

test('a MULTI_USER value that cannot be read as "on" is single-owner, not open', (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const MULTI_USER of ['true', 'yes', '0n', 'enabled']) {
    const gate = gateFor({ ...OWNER_ENV, MULTI_USER });
    assert.equal(gate.kind, 'owner', `MULTI_USER=${MULTI_USER}`);
  }
});

test('MULTI_USER=on (trimmed, any case) gives the member gate and reads the directory', () => {
  const full = { ...OWNER_ENV, ...SUPABASE };
  const gate = accessGateFromEnv({ ...full, MULTI_USER: ' On ' }, () => ({}) as MemberDirectory);
  assert.equal(gate.kind, 'multi');
  assert.equal(gate.kind === 'multi' && gate.jwtSecret, 'secret');
});

test('MULTI_USER given only as a Worker binding still turns members on', () => {
  const settings = workerSettings({ MULTI_USER: 'on', ...ACCESS, ...SUPABASE }, {});
  assert.equal(accessGateFromEnv(settings, () => ({}) as MemberDirectory).kind, 'multi');
});

test('the member directory is not read in single-owner mode', () => {
  assert.equal(accessGateFromEnv({ ...OWNER_ENV, MULTI_USER: 'off' }, noDirectory).kind, 'owner');
});

test('half-configured members mode is closed, never single-owner', () => {
  const gate = gateFor({ ...OWNER_ENV, MULTI_USER: 'on' });
  assert.equal(gate.kind, 'closed');
  assert.match(gate.kind === 'closed' ? gate.reason : '', /MULTI_USER=on needs SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_JWT_SECRET/);
});

test('single-owner without OWNER_EMAIL is closed', () => {
  for (const MULTI_USER of [undefined, 'off', 'true']) {
    const gate = gateFor({ ...ACCESS, MULTI_USER });
    assert.equal(gate.kind, 'closed', `MULTI_USER=${MULTI_USER}`);
  }
});

test('single-owner without the Access settings is closed', () => {
  assert.equal(gateFor({ OWNER_EMAIL: OWNER, MULTI_USER: 'off' }).kind, 'closed');
  assert.equal(gateFor({ OWNER_EMAIL: OWNER, ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com' }).kind, 'closed');
});

test('OWNER_EMAIL must be an email address', () => {
  assert.equal(gateFor({ ...ACCESS, OWNER_EMAIL: 'not-an-email' }).kind, 'closed');
});

test('owner middleware: no token is 401, a friend is 403, the owner passes', async (t) => {
  const { config, tokenFor, getJson } = await accessFixture();
  const app = express();
  app.use('/api', ownerMiddleware({ access: config, ownerEmail: OWNER, getJson, now: () => NOW }));
  app.get('/api/events', (_req, res) => res.json({ rows: 'owner data' }));
  const base = await serve(app, t);
  const get = (token?: string) => fetch(`${base}/api/events`, { headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {} });

  assert.equal((await get()).status, 401);
  assert.equal((await get(await tokenFor(FRIEND))).status, 403);
  const res = await get(await tokenFor(OWNER));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { rows: 'owner data' });
});

// The whole /api, as the Node server and the Worker build it. Only the gate
// differs between these cases.
const DEPS = { store: {} } as unknown as PipelineDeps;
const RUNNER = { kick: async () => {} };

test('closed: every /api route is 503 for everyone, and health still answers with status only', async (t) => {
  const { tokenFor } = await accessFixture();
  t.mock.method(console, 'error', () => {});
  const base = await serve(createApiApp(DEPS, RUNNER, { kind: 'closed', reason: 'test' }), t);
  for (const token of [undefined, await tokenFor(OWNER), await tokenFor(FRIEND)]) {
    const headers: Record<string, string> = token ? { 'Cf-Access-Jwt-Assertion': token } : {};
    for (const path of ['/api/events', '/api/members', '/api/me', '/api/gmail/status']) {
      assert.equal((await fetch(`${base}${path}`, { headers })).status, 503, path);
    }
  }
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(await health.json()).sort(), ['status', 'timestamp']);
});

test('owner gate: a friend gets 403 from /api, the owner gets past the check', async (t) => {
  const { config, tokenFor, getJson } = await accessFixture();
  const base = await serve(createApiApp(DEPS, RUNNER, { kind: 'owner', access: config, ownerEmail: OWNER, getJson }), t);
  assert.equal((await fetch(`${base}/api/events`)).status, 401);
  const friend = await fetch(`${base}/api/events`, { headers: { 'Cf-Access-Jwt-Assertion': await tokenFor(FRIEND) } });
  assert.equal(friend.status, 403);
  const owner = await fetch(`${base}/api/events`, { headers: { 'Cf-Access-Jwt-Assertion': await tokenFor(OWNER) } });
  assert.ok(![401, 403, 503].includes(owner.status), `owner was refused with ${owner.status}`);
});
