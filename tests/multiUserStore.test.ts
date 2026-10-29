import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { LoggedEvent } from '../src/server/events/types.ts';
import { createShareLink } from '../src/server/share/links.ts';
import { frontDoor } from '../src/server/share/door.ts';
import { accessConfigFromEnv, clearAccessKeys } from '../src/server/share/access.ts';
import { memberMiddleware, ownerOnly, requestScopedStore, currentMember } from '../src/server/auth/requestScope.ts';
import { clearMemberCache, type MemberDirectory } from '../src/server/auth/members.ts';
import type { MultiUserConfig } from '../src/server/auth/config.ts';
import type { LookupJob } from '../src/server/lineup/types.ts';
import { membersRouter } from '../src/server/auth/routes.ts';

const ev = (id: string, patch: Partial<LoggedEvent> = {}): LoggedEvent => ({
  id, input: id, name: id, sources: {}, details: { status: 'resolved', candidates: [], notes: [] },
  seen: [], daysAttended: [], companions: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...patch,
});
const job = (id: string): LookupJob => ({
  id, kind: 'lineup', input: { name: id } as any, editionKey: id, status: 'queued', stage: 'collect', attempts: 0,
  pendingExtraction: [], discoveryDone: false, facts: {}, log: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});
const OWNER = { userId: 'u-owner', role: 'owner' as const };
const ANN = { userId: 'u-ann', role: 'member' as const };
const BOB = { userId: 'u-bob', role: 'member' as const };

async function base() {
  return new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'multi-user-')));
}

test('file store: each member lists only their own events, imports, jobs and settings', async () => {
  const s = await base();
  await s.forUser(OWNER).putEvent(ev('o1'));
  await s.forUser(ANN).putEvents([ev('a1'), ev('a2')]);
  await s.forUser(BOB).putEvent(ev('b1'));
  await s.forUser(ANN).createJob(job('ja'));
  await s.forUser(ANN).putSetting('displayName', 'Ann');
  const ids = async (u: { userId: string; role: 'owner' | 'member' }) => (await s.forUser(u).listEvents()).map((e) => e.id).sort();
  assert.deepEqual(await ids(OWNER), ['o1']);
  assert.deepEqual(await ids(ANN), ['a1', 'a2']);
  assert.deepEqual(await ids(BOB), ['b1']);
  assert.equal(await s.forUser(BOB).getEvent('a1'), null);
  assert.equal(await s.forUser(BOB).getJob('ja'), null);
  assert.deepEqual((await s.forUser(ANN).listJobs(10)).map((j) => j.id), ['ja']);
  assert.equal((await s.forUser(ANN).getJob('ja'))?.userId, 'u-ann');
  assert.equal(await s.forUser(BOB).getSetting('displayName'), null);
  assert.equal(await s.forUser(ANN).getSetting('displayName'), 'Ann');
});

test('file store: a member cannot overwrite or delete another member\'s row', async () => {
  const s = await base();
  await s.forUser(ANN).putEvent(ev('a1', { name: 'Ann show' }));
  await assert.rejects(s.forUser(BOB).putEvent(ev('a1', { name: 'Bob took it' })), /belongs to another member/);
  await s.forUser(BOB).deleteEvent('a1');
  assert.equal((await s.forUser(ANN).getEvent('a1'))?.name, 'Ann show');
});

test('file store: rows from before multi-user belong to the owner only; the owner keeps app-wide settings', async () => {
  const s = await base();
  await s.putEvent(ev('old'));
  await s.putSetting('email_scan_browser', { streamA: 'x' });
  assert.deepEqual((await s.forUser(OWNER).listEvents()).map((e) => e.id), ['old']);
  assert.deepEqual(await s.forUser(ANN).listEvents(), []);
  assert.deepEqual(await s.forUser(OWNER).getSetting('email_scan_browser'), { streamA: 'x' });
  assert.equal(await s.forUser(ANN).getSetting('email_scan_browser'), null);
});

test('share page: a member\'s link shows only that member\'s events', async () => {
  const s = await base();
  await s.forUser(OWNER).putEvent(ev('owner-show', { name: 'OWNER_SHOW', startDate: '2025-03-01' }));
  await s.forUser(ANN).putEvent(ev('ann-show', { name: 'ANN_SHOW', startDate: '2025-04-01' }));
  const settings = { displayName: 'Ann', timeZone: 'UTC', showDates: true, showVenues: true, showFormat: false };
  const now = new Date('2026-10-29T12:00:00Z');
  const { code } = await createShareLink(s.forUser(ANN), settings, now);
  const res = (await frontDoor(new Request(`https://x.example/s/${code}`), { store: async () => s, access: null, now: () => now }))!;
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.ok(body.includes('ANN_SHOW'));
  assert.ok(!body.includes('OWNER_SHOW'));
  // A member's link is invisible to other members' own listings.
  assert.deepEqual(await s.forUser(BOB).listShareLinks(), []);
});

test('owner-only routes: Manage, Sheets, Gmail, server scans and lineup confirm', () => {
  for (const [m, p] of [['GET', '/api/entities'], ['PATCH', '/api/entities/x'], ['GET', '/api/sheets'], ['GET', '/api/gmail/connect'], ['POST', '/api/imports/email'], ['PUT', '/api/artist-genres/k']]) {
    assert.equal(ownerOnly(m, p), true, `${m} ${p}`);
  }
  for (const [m, p] of [['GET', '/api/events'], ['POST', '/api/events'], ['GET', '/api/imports'], ['POST', '/api/imports/proposals'], ['GET', '/api/share'], ['GET', '/api/artist-genres'], ['GET', '/api/lookups'], ['POST', '/api/lookups'], ['POST', '/api/lookups/j1/run'], ['POST', '/api/lookups/j1/confirm'], ['POST', '/api/events/lineups'], ['POST', '/api/events/e1/lineup'], ['GET', '/api/me']]) {
    assert.equal(ownerOnly(m, p), false, `${m} ${p}`);
  }
});

// The middleware over a real Express app, with Access tokens like Cloudflare's.
async function apiFixture() {
  const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tokenFor = async (email: string) => {
    const data = `${enc({ alg: 'RS256', kid: 'k1' })}.${enc({ aud: ['aud'], iss: 'https://t.cloudflareaccess.com', exp: Math.floor(Date.now() / 1000) + 600, email, sub: email })}`;
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(data));
    return `${data}.${Buffer.from(sig).toString('base64url')}`;
  };
  clearAccessKeys();
  clearMemberCache();
  const rows: Record<string, { userId: string | null; role: 'owner' | 'member' }> = {
    'owner@example.com': { userId: OWNER.userId, role: 'owner' },
    'ann@example.com': { userId: ANN.userId, role: 'member' },
    'bob@example.com': { userId: BOB.userId, role: 'member' },
  };
  const directory: MemberDirectory = {
    findMember: async (email) => (rows[email] ? { email, ...rows[email] } : null),
    createAuthUser: async () => { throw new Error('unused'); },
    linkMember: async () => {},
    listMembers: async () => Object.entries(rows).map(([email, r]) => ({ email, ...r, invitedAt: '2026-01-01T00:00:00Z' })),
    inviteMember: async (email) => { if (rows[email]) throw new Error('That email is already invited.'); rows[email] = { userId: null, role: 'member' }; },
    removeMember: async (email) => { if (rows[email]?.role === 'owner') throw new Error('The owner cannot be removed.'); delete rows[email]; },
  };
  const config: MultiUserConfig = { access: accessConfigFromEnv({ ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com', ACCESS_AUD: 'aud' })!, supabaseUrl: 'https://x.supabase.co', anonKey: 'anon', jwtSecret: 'secret' };
  const store = await base();
  const app = express();
  app.use(express.json());
  app.use('/api', memberMiddleware({ config, directory, base: store, getJson: async () => ({ keys: [jwk] }) }));
  app.use('/api', membersRouter(directory));
  const scoped = requestScopedStore(store);
  app.get('/api/events', async (_req, res) => res.json({ me: currentMember()?.email, events: (await scoped.listEvents()).map((e) => e.id) }));
  app.post('/api/events', async (req, res) => { await scoped.putEvent(ev(req.body.id)); res.json({ ok: true }); });
  app.get('/api/entities', (_req, res) => res.json({ entities: [] }));
  const server = app.listen(0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (email: string | null, route: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (email) headers['cf-access-jwt-assertion'] = await tokenFor(email);
    const r = await fetch(`${url}${route}`, { ...init, headers });
    return { status: r.status, body: await r.json() as any };
  };
  return { call, close: () => server.close() };
}

test('API: no token is 401, a stranger 403, a member sees only their rows, members cannot use owner-only routes', async () => {
  const { call, close } = await apiFixture();
  try {
    assert.equal((await call(null, '/api/events')).status, 401);
    assert.equal((await call('stranger@example.com', '/api/events')).status, 403);
    assert.equal((await call('ann@example.com', '/api/events', { method: 'POST', body: JSON.stringify({ id: 'a1' }) })).status, 200);
    assert.equal((await call('bob@example.com', '/api/events', { method: 'POST', body: JSON.stringify({ id: 'b1' }) })).status, 200);
    const ann = await call('ann@example.com', '/api/events');
    assert.deepEqual(ann.body, { me: 'ann@example.com', events: ['a1'] });
    assert.deepEqual((await call('bob@example.com', '/api/events')).body.events, ['b1']);
    assert.deepEqual((await call('owner@example.com', '/api/events')).body.events, []);
    assert.equal((await call('ann@example.com', '/api/entities')).status, 403);
    assert.equal((await call('owner@example.com', '/api/entities')).status, 200);
  } finally {
    close();
  }
});

test('API: concurrent requests from two members never see each other\'s rows', async () => {
  const { call, close } = await apiFixture();
  try {
    await call('ann@example.com', '/api/events', { method: 'POST', body: JSON.stringify({ id: 'a1' }) });
    await call('bob@example.com', '/api/events', { method: 'POST', body: JSON.stringify({ id: 'b1' }) });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => call(i % 2 ? 'ann@example.com' : 'bob@example.com', '/api/events')));
    results.forEach((r, i) => assert.deepEqual(r.body.events, [i % 2 ? 'a1' : 'b1']));
  } finally {
    close();
  }
});

test('API: /me says who you are; only the owner lists, invites and removes members', async () => {
  const { call, close } = await apiFixture();
  try {
    assert.deepEqual((await call('ann@example.com', '/api/me')).body, { multiUser: true, role: 'member', email: 'ann@example.com' });
    assert.equal((await call('owner@example.com', '/api/me')).body.role, 'owner');
    assert.equal((await call('ann@example.com', '/api/members')).status, 403);
    assert.equal((await call('ann@example.com', '/api/members', { method: 'POST', body: JSON.stringify({ email: 'cy@example.com' }) })).status, 403);
    const invite = (email: unknown) => call('owner@example.com', '/api/members', { method: 'POST', body: JSON.stringify({ email }) });
    assert.equal((await invite('not an email')).status, 400);
    assert.equal((await invite('Cy@Example.com')).status, 201);
    assert.equal((await invite('cy@example.com')).status, 400);
    const list = (await call('owner@example.com', '/api/members')).body.members;
    assert.deepEqual(list.find((m: any) => m.email === 'cy@example.com'), { email: 'cy@example.com', role: 'member', joined: false, invitedAt: list.find((m: any) => m.email === 'cy@example.com').invitedAt });
    assert.equal((await call('owner@example.com', '/api/members/owner%40example.com', { method: 'DELETE' })).status, 400);
    assert.equal((await call('owner@example.com', '/api/members/cy%40example.com', { method: 'DELETE' })).status, 200);
    assert.equal((await call('cy@example.com', '/api/events')).status, 403);
  } finally {
    close();
  }
});

test('member lineup review: ticks go to the member\'s own event only; nothing shared is written', async () => {
  const { confirmLookupForMember } = await import('../src/server/lineup/learning.ts');
  const s = await base();
  const mine = s.forUser(ANN);
  await mine.putEvent(ev('e1', { name: 'Fest 2025' }));
  const j: LookupJob = {
    ...job('j1'),
    status: 'needs_review',
    stage: 'done',
    eventId: 'e1',
    editionKey: 'fest/2025',
    input: { eventName: 'Fest', year: 2025 } as any,
    candidate: {
      performers: [
        { key: 'velvet tide', name: 'Velvet Tide', days: [], stages: [], status: 'billed', confidence: 0.9, sources: [{ sourceType: 'promoter', sourceUrl: 'https://fest.example', quotedSpan: 'Velvet Tide', evidence: 'billed', extractor: 'x' }] },
        { key: 'moon garden', name: 'Moon Garden', days: [], stages: [], status: 'billed', confidence: 0.9, sources: [] },
      ],
    } as any,
  };
  await mine.createJob(j);
  const result = await confirmLookupForMember(mine, (await mine.getJob('j1'))!, {
    performers: [
      { key: 'velvet tide', name: 'Velvet Tide', accepted: true, seen: true },
      { key: 'moon garden', name: 'Moon Garden', accepted: true, seen: false },
      { name: 'My Friend DJ', accepted: true, seen: true },
    ],
  });
  assert.deepEqual((await mine.getEvent('e1'))!.seen.map((a) => [a.name, a.from]), [['Velvet Tide', 'lineup'], ['My Friend DJ', 'you']]);
  assert.equal(result.edition.status, 'draft');
  assert.deepEqual(result.edition.performances.map((p) => p.name).sort(), ['Moon Garden', 'Velvet Tide']);
  // Nothing shared: no edition, series, corrections, stats, blocklist or aliases.
  assert.equal(await s.getEditionByKey('fest/2025'), null);
  assert.equal(await s.getSeries('fest'), null);
  assert.deepEqual(await s.getSourceStats(), []);
  assert.deepEqual(await s.getAliases(), {});
  assert.equal((await mine.getJob('j1'))!.status, 'confirmed');
  // Another member cannot review or see it.
  assert.equal(await s.forUser(BOB).getJob('j1'), null);
  // A lookup not tied to one of their events is refused.
  await mine.createJob({ ...job('j2'), status: 'needs_review' });
  await assert.rejects(confirmLookupForMember(mine, (await mine.getJob('j2'))!, { performers: [] }), /not attached to one of your events/);
});
