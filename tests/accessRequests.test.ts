import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { accessConfigFromEnv, clearAccessKeys } from '../src/server/share/access.ts';
import { memberMiddleware } from '../src/server/auth/requestScope.ts';
import { accessRequestOwnerRouter, accessRequestRouter } from '../src/server/auth/requestRoutes.ts';
import { membersRouter } from '../src/server/auth/routes.ts';
import { clearMemberCache, type MemberDirectory } from '../src/server/auth/members.ts';
import { cleanSettingsPatch, type AccessRequestStore } from '../src/server/auth/requests.ts';
import { runJob, type PipelineDeps } from '../src/server/lineup/pipeline.ts';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const ACCESS = { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud-1' };

// A signed Access token for an email, checked against a generated key (as in multiUserAuth.test.ts).
async function accessFixture() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = async (email: string, sub: string) => {
    const payload = { aud: ['aud-1'], iss: 'https://team.cloudflareaccess.com', exp: Math.floor(NOW / 1000) + 600, email, sub };
    const data = `${enc({ alg: 'RS256', kid: 'k1' })}.${enc(payload)}`;
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(data));
    return `${data}.${Buffer.from(sig).toString('base64url')}`;
  };
  clearAccessKeys();
  return { token, getJson: async () => ({ keys: [jwk] }) };
}

// The member directory, as rows: members with a blocked flag.
function memberRows(rows: Record<string, { role: 'owner' | 'member'; blocked?: boolean }>) {
  const dir: MemberDirectory = {
    async findMember(email) {
      const r = rows[email];
      return r ? { email, userId: `u-${email}`, role: r.role, blocked: Boolean(r.blocked) } : null;
    },
    createAuthUser: async (email) => `u-${email}`,
    linkMember: async () => {},
    listMembers: async () => [],
    inviteMember: async () => {},
    removeMember: async () => {},
    hasActiveUser: async () => true,
  };
  return dir;
}

// The request store, recording calls. Its answers are set by each test.
function requestStore(answers: { submit?: string; view?: string; cap?: number; paused?: boolean; pending?: number } = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  let settings = { paused: answers.paused ?? false, cap: answers.cap ?? 20 };
  const store: AccessRequestStore = {
    async submit(email, sub) {
      calls.push(['submit', email, sub]);
      return (answers.submit ?? 'sent') as 'sent' | 'closed';
    },
    async view(email, sub) {
      calls.push(['view', email, sub]);
      return (answers.view ?? 'none') as 'none' | 'sent' | 'closed';
    },
    async list() {
      return [{ email: 'cy@example.com', status: 'pending', source: 'requested', requestedAt: '2026-10-29T10:00:00Z', statusChangedAt: '2026-10-29T10:00:00Z', hasAccount: false, blocked: false }];
    },
    async pendingCount() {
      return answers.pending ?? 1;
    },
    async settings() {
      return settings;
    },
    async saveSettings(patch) {
      settings = { ...settings, ...patch };
      return settings;
    },
    async setStatus(email, to) {
      calls.push(['setStatus', email, to]);
    },
  };
  return { store, calls };
}

async function appFixture(rows: Record<string, { role: 'owner' | 'member'; blocked?: boolean }>, answers: Parameters<typeof requestStore>[0] = {}) {
  const access = await accessFixture();
  const config = { access: accessConfigFromEnv(ACCESS)!, supabaseUrl: 'https://x.supabase.co', anonKey: 'anon', jwtSecret: 'secret' };
  const directory = memberRows(rows);
  const { store, calls } = requestStore(answers);
  // The base store: only what the middleware and /me use.
  const base = { kind: 'file', forUser: () => ({}), getSetting: async () => null } as any;
  const app = express();
  app.use(express.json());
  app.use('/api', accessRequestRouter({ config, directory, requests: store, now: () => NOW, getJson: access.getJson as any }));
  app.use('/api', memberMiddleware({ config, directory, base, now: () => NOW, getJson: access.getJson as any }));
  app.use('/api', membersRouter(directory, base, store));
  app.use('/api', accessRequestOwnerRouter(store));
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  const call = async (email: string | null, path: string, init: { method?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (email) headers['Cf-Access-Jwt-Assertion'] = await access.token(email, `sub-${email}`);
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
  return { call, calls, close: () => server.close() };
}

const OWNER = 'owner@example.com';
const FRIEND = 'friend@example.com';
const STRANGER = 'stranger@example.com';
const ROWS = { [OWNER]: { role: 'owner' as const }, [FRIEND]: { role: 'member' as const } };

test('asking: a signed-in stranger asks with the token email, and sees only their own state', async () => {
  clearMemberCache();
  const f = await appFixture(ROWS, { submit: 'sent', view: 'none' });
  try {
    assert.equal((await f.call(null, '/api/access-requests', { method: 'POST' })).status, 401);
    // The email in a body is ignored: the token's email is the identity.
    const asked = await f.call(STRANGER, '/api/access-requests', { method: 'POST', body: { email: OWNER } });
    assert.equal(asked.status, 200);
    assert.deepEqual(asked.body, { state: 'sent' });
    assert.deepEqual(f.calls[0], ['submit', STRANGER, `sub-${STRANGER}`]);
    assert.deepEqual((await f.call(STRANGER, '/api/access-requests/mine')).body, { state: 'none' });
  } finally {
    f.close();
  }
});

test('asking: the pause and the cap answer closed, and a member goes on to the app (never asks)', async () => {
  clearMemberCache();
  const f = await appFixture(ROWS, { submit: 'closed' });
  try {
    assert.deepEqual((await f.call(STRANGER, '/api/access-requests', { method: 'POST' })).body, { state: 'closed' });
    const member = await f.call(FRIEND, '/api/access-requests', { method: 'POST' });
    assert.equal(member.status, 404);
    assert.equal(f.calls.filter(([name]) => name === 'submit').length, 1);
  } finally {
    f.close();
  }
});

test('refusals: a stranger gets code not_invited with their own email; owner-only refusals carry no code', async () => {
  clearMemberCache();
  const f = await appFixture(ROWS);
  try {
    const refused = await f.call(STRANGER, '/api/me');
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'not_invited');
    assert.equal(refused.body.email, STRANGER);
    const ownerOnly = await f.call(FRIEND, '/api/access-requests');
    assert.equal(ownerOnly.status, 403);
    assert.equal(ownerOnly.body.code, undefined);
    assert.equal(ownerOnly.body.email, undefined);
  } finally {
    f.close();
  }
});

test('the owner sees the history and the pending count; status changes are checked', async () => {
  clearMemberCache();
  const f = await appFixture(ROWS, { pending: 3 });
  try {
    const list = await f.call(OWNER, '/api/access-requests');
    assert.equal(list.status, 200);
    assert.equal(list.body.pending, 1);
    assert.equal(list.body.requests[0].email, 'cy@example.com');
    assert.equal((await f.call(OWNER, '/api/me')).body.pendingRequests, 3);
    assert.equal((await f.call(FRIEND, '/api/me')).body.pendingRequests, 0);
    assert.equal((await f.call(OWNER, '/api/access-requests/cy%40example.com', { method: 'PUT', body: { to: 'bogus' } })).status, 400);
    assert.equal((await f.call(OWNER, '/api/access-requests/cy%40example.com', { method: 'PUT', body: { to: 'left' } })).status, 400);
    assert.equal((await f.call(OWNER, '/api/access-requests/not-an-email', { method: 'PUT', body: { to: 'declined' } })).status, 400);
    assert.equal((await f.call(FRIEND, '/api/access-requests/cy%40example.com', { method: 'PUT', body: { to: 'declined' } })).status, 403);
    assert.equal((await f.call(OWNER, '/api/access-requests/Cy%40Example.com', { method: 'PUT', body: { to: 'accepted' } })).status, 200);
    assert.deepEqual(f.calls.at(-1), ['setStatus', 'cy@example.com', 'accepted']);
  } finally {
    f.close();
  }
});

test('settings: pause is on or off, the cap is a whole number from 1 to 100', async () => {
  assert.deepEqual(cleanSettingsPatch({ paused: true, cap: 20 }), { paused: true, cap: 20 });
  assert.deepEqual(cleanSettingsPatch({}), {});
  assert.throws(() => cleanSettingsPatch({ cap: 0 }), /1 to 100/);
  assert.throws(() => cleanSettingsPatch({ cap: 101 }), /1 to 100/);
  assert.throws(() => cleanSettingsPatch({ cap: 2.5 }), /1 to 100/);
  assert.throws(() => cleanSettingsPatch({ cap: '20' }), /1 to 100/);
  assert.throws(() => cleanSettingsPatch({ paused: 'yes' }), /on or off/);
  const f = await appFixture(ROWS);
  try {
    assert.equal((await f.call(OWNER, '/api/access-requests/settings', { method: 'PUT', body: { cap: 500 } })).status, 400);
    const saved = await f.call(OWNER, '/api/access-requests/settings', { method: 'PUT', body: { cap: 5, paused: true } });
    assert.deepEqual(saved.body.settings, { paused: true, cap: 5 });
  } finally {
    f.close();
  }
});

test('a blocked member is refused at once, even with a cached entry on this instance', async () => {
  clearMemberCache();
  const rows: Record<string, { role: 'owner' | 'member'; blocked?: boolean }> = { ...ROWS };
  const f = await appFixture(rows);
  try {
    assert.equal((await f.call(FRIEND, '/api/me')).status, 200);
    rows[FRIEND] = { role: 'member', blocked: true };
    // The owner's block clears this instance's cache; other instances catch up within 15 seconds.
    assert.equal((await f.call(OWNER, `/api/access-requests/${encodeURIComponent(FRIEND)}`, { method: 'PUT', body: { to: 'declined' } })).status, 200);
    const refused = await f.call(FRIEND, '/api/me');
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'not_invited');
  } finally {
    f.close();
  }
});

test('a blocked member\'s lookup job is parked, with no outside call', async () => {
  const saved: any[] = [];
  const job: any = { id: 'j1', kind: 'event', status: 'queued', stage: 'collect', attempts: 0, userId: 'u-friend', pendingExtraction: [], input: {} };
  const deps = {
    store: { getJob: async () => job, updateJob: async (j: any) => saved.push({ ...j }) },
    now: () => new Date(NOW),
    hasActiveUser: async (userId: string) => userId !== 'u-friend',
  } as unknown as PipelineDeps;
  const parked = await runJob(deps, 'j1');
  assert.equal(parked?.status, 'waiting_quota');
  assert.match(parked?.waitingReason ?? '', /blocked or removed/);
  assert.equal(parked?.nextAttemptAt, undefined);
  assert.equal(saved.length, 1);
});
