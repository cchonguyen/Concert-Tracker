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
import { accountRouter, membersRouter } from '../src/server/auth/routes.ts';
import { vaultGuard, vaultRouter } from '../src/server/auth/vault.ts';
import { peopleRouter } from '../src/server/entities/people.ts';

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

test('owner-only routes: Gmail, server scans and music-story/MusicBrainz genres', () => {
  for (const [m, p] of [['GET', '/api/gmail/connect'], ['POST', '/api/imports/email'], ['POST', '/api/artist-genres/music-story'], ['POST', '/api/artist-genres/musicbrainz']]) {
    assert.equal(ownerOnly(m, p), true, `${m} ${p}`);
  }
  for (const [m, p] of [['GET', '/api/events'], ['POST', '/api/events'], ['GET', '/api/imports'], ['POST', '/api/imports/proposals'], ['GET', '/api/share'], ['GET', '/api/artist-genres'], ['PUT', '/api/artist-genres/k'], ['GET', '/api/lookups'], ['POST', '/api/lookups'], ['POST', '/api/lookups/j1/run'], ['POST', '/api/lookups/j1/confirm'], ['POST', '/api/events/lineups'], ['POST', '/api/events/e1/lineup'], ['GET', '/api/me'], ['GET', '/api/entities'], ['PATCH', '/api/entities/x'], ['GET', '/api/people'], ['GET', '/api/sheets'], ['PUT', '/api/sheets/values'], ['POST', '/api/sheets/link']]) {
    assert.equal(ownerOnly(m, p), false, `${m} ${p}`);
  }
  // The Gmail callback address also brings Sheets sign-ins back; only those pass.
  assert.equal(ownerOnly('GET', '/api/gmail/callback', { state: 'sheets-abc' }), false);
  assert.equal(ownerOnly('GET', '/api/gmail/callback', { state: 'gmail-abc' }), true);
  assert.equal(ownerOnly('GET', '/api/gmail/callback'), true);
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
  const scoped = requestScopedStore(store);
  app.use('/api', membersRouter(directory, scoped));
  app.use('/api', vaultGuard(scoped));
  app.use('/api', vaultRouter(scoped));
  app.use('/api', accountRouter(directory, scoped));
  app.use('/api', peopleRouter(scoped));
  app.get('/api/sheets', (_req, res) => res.json({}));
  app.get('/api/gmail/connect', (_req, res) => res.json({}));
  app.get('/api/events', async (_req, res) => res.json({ me: currentMember()?.email, events: (await scoped.listEvents()).map((e) => e.id) }));
  app.post('/api/events', async (req, res) => { await scoped.putEvent(ev(req.body.id, { notes: req.body.notes })); res.json({ ok: true }); });
  app.get('/api/entities', (_req, res) => res.json({ entities: [] }));
  app.patch('/api/events/:id', async (req, res) => {
    const { applyPatch } = await import('../src/server/events/service.ts');
    const event = await scoped.getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'No such event.' });
    try {
      const next = applyPatch(event, req.body, new Date());
      await scoped.putEvent(next);
      res.json(next);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
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
    // The first-sign-in notice: pending until this member accepts, and only theirs.
    assert.equal((await call('ann@example.com', '/api/me')).body.noticeAccepted, false);
    assert.equal((await call('ann@example.com', '/api/me/notice', { method: 'POST', body: '{}' })).status, 200);
    assert.equal((await call('ann@example.com', '/api/me')).body.noticeAccepted, true);
    assert.equal((await call('bob@example.com', '/api/me')).body.noticeAccepted, false);
    assert.equal((await call('stranger@example.com', '/api/events')).status, 403);
    assert.equal((await call('ann@example.com', '/api/events', { method: 'POST', body: JSON.stringify({ id: 'a1' }) })).status, 200);
    assert.equal((await call('bob@example.com', '/api/events', { method: 'POST', body: JSON.stringify({ id: 'b1' }) })).status, 200);
    const ann = await call('ann@example.com', '/api/events');
    assert.deepEqual(ann.body, { me: 'ann@example.com', events: ['a1'] });
    assert.deepEqual((await call('bob@example.com', '/api/events')).body.events, ['b1']);
    assert.deepEqual((await call('owner@example.com', '/api/events')).body.events, []);
    assert.equal((await call('ann@example.com', '/api/gmail/connect')).status, 403);
    assert.equal((await call('ann@example.com', '/api/entities')).status, 200);
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
    assert.deepEqual((await call('ann@example.com', '/api/me')).body, { multiUser: true, role: 'member', email: 'ann@example.com', noticeAccepted: false });
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
  assert.deepEqual(await s.getBlocklist(['fest.example', '*']), []);
  assert.deepEqual(await s.getExamples('fest.example'), []);
  assert.equal((await mine.getJob('j1'))!.status, 'confirmed');
  // Another member cannot review or see it.
  assert.equal(await s.forUser(BOB).getJob('j1'), null);
  // A lookup not tied to one of their events is refused.
  await mine.createJob({ ...job('j2'), status: 'needs_review' });
  await assert.rejects(confirmLookupForMember(mine, (await mine.getJob('j2'))!, { performers: [] }), /not attached to one of your events/);
});

const MATERIAL = {
  vaultSalt: 'c2FsdHNhbHRzYWx0c2FsdA==',
  kdfAlg: 'PBKDF2-SHA256',
  pbkdf2Iterations: 600000,
  passphraseSalt: 'cGFzc3NhbHRwYXNzc2FsdA==',
  wrappedByPassphrase: 'w1:aXZpdml2aXZpdml2:Y2lwaGVydGV4dGNpcGhlcnRleHQ=',
  wrappedByRecovery: 'w1:aXZpdml2aXZpdml2:cmVjb3ZlcnljaXBoZXJ0ZXh0',
};
const CIPHERTEXT = 'v1:aXZpdml2aXZpdml2:c2VjcmV0bm90ZQ==';

test('vault: key material is per member; once on, plaintext notes are refused and ciphertext is kept', async () => {
  const { call, close } = await apiFixture();
  try {
    const save = (email: string, id: string, notes?: string) => call(email, '/api/events', { method: 'POST', body: JSON.stringify({ id, notes }) });
    assert.deepEqual((await call('ann@example.com', '/api/vault')).body, { state: 'plaintext', material: null });
    assert.equal((await save('ann@example.com', 'a0', 'plain note before the vault')).status, 200);
    assert.equal((await call('ann@example.com', '/api/vault', { method: 'PUT', body: JSON.stringify({ material: { ...MATERIAL, pbkdf2Iterations: 5 } }) })).status, 400);
    assert.equal((await call('ann@example.com', '/api/vault', { method: 'PUT', body: JSON.stringify({ material: { ...MATERIAL, wrappedByPassphrase: 'not wrapped' } }) })).status, 400);
    assert.equal((await call('ann@example.com', '/api/vault', { method: 'PUT', body: JSON.stringify({ material: MATERIAL }) })).status, 200);
    assert.equal((await call('ann@example.com', '/api/vault', { method: 'PUT', body: JSON.stringify({ material: MATERIAL }) })).status, 409);
    assert.deepEqual((await call('ann@example.com', '/api/vault')).body, { state: 'encrypted', material: MATERIAL });
    // Ann's plaintext is refused; ciphertext, no note, and an empty note are fine.
    const refused = await save('ann@example.com', 'a1', 'a plaintext note');
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /encrypted in the browser/);
    assert.equal((await save('ann@example.com', 'a2', CIPHERTEXT)).status, 200);
    assert.equal((await save('ann@example.com', 'a3')).status, 200);
    assert.equal((await save('ann@example.com', 'a4', 'v1:forged plaintext')).status, 400);
    // Nothing was stored for the refused saves.
    assert.deepEqual((await call('ann@example.com', '/api/events')).body.events.sort(), ['a0', 'a2', 'a3']);
    // Bob has no vault, and cannot see Ann's.
    assert.deepEqual((await call('bob@example.com', '/api/vault')).body, { state: 'plaintext', material: null });
    assert.equal((await save('bob@example.com', 'b1', 'bob plaintext is fine')).status, 200);
    // A passphrase change may only replace the passphrase wrapping.
    const rewrap = (m: object) => call('ann@example.com', '/api/vault/rewrap', { method: 'POST', body: JSON.stringify({ material: m }) });
    assert.equal((await rewrap({ ...MATERIAL, wrappedByPassphrase: 'w1:bmV3aXZuZXdpdg==:bmV3d3JhcHBlZA==', passphraseSalt: 'bmV3c2FsdG5ld3NhbHQ=' })).status, 200);
    assert.equal((await rewrap({ ...MATERIAL, wrappedByRecovery: 'w1:eHh4eHh4eHg=:eXl5eXl5' })).status, 400);
    assert.equal((await call('bob@example.com', '/api/vault/rewrap', { method: 'POST', body: JSON.stringify({ material: MATERIAL }) })).status, 404);
  } finally {
    close();
  }
});

test('account: export is your rows only; deletion needs your email, removes you, and is refused for the owner', async () => {
  const { call, close } = await apiFixture();
  try {
    await call('ann@example.com', '/api/events', { method: 'POST', body: JSON.stringify({ id: 'a1' }) });
    await call('bob@example.com', '/api/events', { method: 'POST', body: JSON.stringify({ id: 'b1' }) });
    const exp = (await call('ann@example.com', '/api/account/export')).body;
    assert.deepEqual(exp.events.map((e: any) => e.id), ['a1']);
    assert.deepEqual(exp.account, { email: 'ann@example.com', role: 'member' });
    assert.ok(!JSON.stringify(exp).includes('b1'));
    const del = (email: string, confirm?: string) => call(email, '/api/account', { method: 'DELETE', body: JSON.stringify({ confirm }) });
    assert.equal((await del('ann@example.com')).status, 400);
    assert.equal((await del('ann@example.com', 'bob@example.com')).status, 400);
    assert.equal((await del('owner@example.com', 'owner@example.com')).status, 403);
    assert.equal((await del('ann@example.com', 'Ann@Example.com')).status, 200);
    assert.equal((await call('ann@example.com', '/api/events')).status, 403);
    assert.deepEqual((await call('bob@example.com', '/api/events')).body.events, ['b1']);
  } finally {
    close();
  }
});

// ---- Per-member records (0020) and people in the vault -----------------------

import { withEntityLinks } from '../src/server/entities/linkingStore.ts';
import { renameEntity } from '../src/server/entities/manage.ts';

test('records: each member has their own; renaming a venue for one never touches another', async () => {
  const s = withEntityLinks(await base());
  const ann = s.forUser!(ANN);
  const bob = s.forUser!(BOB);
  await ann.putEvent(ev('a1', { venue: 'Forum', companions: ['Jen'] }));
  await bob.putEvent(ev('b1', { venue: 'Forum', companions: ['Jen'] }));
  const names = async (st: typeof ann) => (await st.listEntities()).filter((e) => e.kind !== 'artist').map((e) => `${e.kind}:${e.name}`).sort();
  assert.deepEqual(await names(ann), ['person:Jen', 'venue:Forum']);
  assert.deepEqual(await names(bob), ['person:Jen', 'venue:Forum']);
  assert.deepEqual(await s.listEntities(), []); // the shared tables hold nothing of theirs
  const venue = (await ann.listEntities()).find((e) => e.kind === 'venue')!;
  await renameEntity(ann, venue.id, 'The Kia Forum');
  assert.equal((await ann.getEvent('a1'))!.venue, 'The Kia Forum');
  assert.equal((await bob.getEvent('b1'))!.venue, 'Forum');
  assert.deepEqual(await names(bob), ['person:Jen', 'venue:Forum']);
  assert.equal((await ann.listEntityHistory(10)).length, 1);
  assert.equal((await bob.listEntityHistory(10)).length, 0);
});

const CIPHER = (tag: string) => `v1:${Buffer.from(`iv-${tag}`).toString('base64')}:${Buffer.from(`ct-${tag}`).toString('base64')}`;
const TOKEN = (c: string) => c.repeat(64);

test('people: names are only ever stored encrypted; merge repoints events; plain names are converted then erased', async () => {
  const { call, close } = await apiFixture();
  const post = (email: string, route: string, body: unknown, method = 'POST') => call(email, route, { method, body: JSON.stringify(body) });
  try {
    const a = 'ann@example.com';
    // Before the vault, a person is a plain name linked from the event.
    // (Linking runs in the store; here the event is saved through the fixture's store directly.)
    assert.equal((await post(a, '/api/people/20000000-0000-4000-8000-000000000001', { nameEncrypted: CIPHER('jen'), tokens: [] }, 'PUT')).status, 409); // vault not on yet
    assert.equal((await post(a, '/api/vault', { material: MATERIAL }, 'PUT')).status, 200);
    const J = '20000000-0000-4000-8000-000000000001';
    const K = '20000000-0000-4000-8000-000000000002';
    // Plaintext names, odd tokens and details are refused.
    assert.equal((await post(a, `/api/people/${J}`, { nameEncrypted: 'Jen', tokens: [] }, 'PUT')).status, 400);
    assert.equal((await post(a, `/api/people/${J}`, { nameEncrypted: CIPHER('jen'), tokens: ['jen'] }, 'PUT')).status, 400);
    assert.equal((await post(a, `/api/people/${J}`, { nameEncrypted: CIPHER('jen'), tokens: [TOKEN('a')], enc: 'first: Jen' }, 'PUT')).status, 400);
    assert.equal((await post(a, `/api/people/${J}`, { nameEncrypted: CIPHER('jen'), tokens: [TOKEN('a')] }, 'PUT')).status, 200);
    assert.equal((await post(a, `/api/people/${K}`, { nameEncrypted: CIPHER('jenny'), tokens: [TOKEN('b')] }, 'PUT')).status, 200);
    // One token leads to one person.
    assert.equal((await post(a, `/api/people/${K}`, { nameEncrypted: CIPHER('jenny'), tokens: [TOKEN('a')] }, 'PUT')).status, 409);
    const listed = (await call(a, '/api/people')).body;
    assert.deepEqual(listed.people.map((p: any) => [p.id, p.tokens]).sort(), [[J, [TOKEN('a')]], [K, [TOKEN('b')]]]);
    assert.ok(!JSON.stringify(listed).includes('Jen'));
    // Bob cannot see Ann's people.
    assert.deepEqual((await call('bob@example.com', '/api/people')).body.people, []);

    // Events list people by id; plaintext companions are refused now.
    await post(a, '/api/events', { id: 'e1' });
    assert.equal((await post(a, '/api/events/e1', { personIds: [J, K, 'not-a-uuid'] }, 'PATCH')).status, 200);
    assert.equal((await post(a, '/api/events/e1', { companions: ['Jen'] }, 'PATCH')).status, 400);
    assert.equal((await post(a, '/api/events/e1', { personIds: ['20000000-0000-4000-8000-0000000000ff'] }, 'PATCH')).status, 500); // not one of your people
    // Merging K into J repoints the event and moves the token.
    assert.equal((await post(a, `/api/people/${K}/merge`, { into: J })).body.events, 1);
    const after = (await call(a, '/api/people')).body.people;
    assert.deepEqual(after.find((p: any) => p.id === J).tokens.sort(), [TOKEN('a'), TOKEN('b')]);
    assert.equal(after.find((p: any) => p.id === K).mergedIntoId, J);
  } finally {
    close();
  }
});

test('people: turning the vault on converts plain people, moves their events and links, and leaves no readable name', async () => {
  const s = withEntityLinks(await base());
  const ann = s.forUser!(ANN);
  await ann.putEvents([ev('e1', { companions: ['Jen', 'Sam'] }), ev('e2', { companions: ['Jen'] })]);
  await ann.putSetting('vault', MATERIAL);
  const plain = (await ann.listEntities()).filter((e) => e.kind === 'person');
  assert.deepEqual(plain.map((p) => p.name).sort(), ['Jen', 'Sam']);
  // A rename left a manifest holding the name; it must go too.
  const jen = plain.find((p) => p.name === 'Jen')!;
  await renameEntity(ann, jen.id, 'Jennifer');
  const app = express();
  app.use(express.json());
  const { peopleRouter: people } = await import('../src/server/entities/people.ts');
  app.use('/api', people(ann));
  const server = app.listen(0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const send = async (route: string, body: unknown, method = 'POST') => (await fetch(url + route, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;
  try {
    const J = '30000000-0000-4000-8000-000000000001';
    const S = '30000000-0000-4000-8000-000000000002';
    await send(`/people/${J}`, { nameEncrypted: CIPHER('jennifer'), tokens: [TOKEN('1')] }, 'PUT');
    await send(`/people/${S}`, { nameEncrypted: CIPHER('sam'), tokens: [TOKEN('2')] }, 'PUT');
    assert.match((await send('/people/finish', {})).error, /still have their names/);
    await send(`/people/${jen.id}/convert`, { to: J });
    await send(`/people/${plain.find((p) => p.name === 'Sam')!.id}/convert`, { to: S });
    assert.deepEqual((await send('/people/finish', {})).erased, 0);
    const events = await ann.listEvents();
    assert.deepEqual(events.map((e) => [e.id, e.companions, e.refs?.companionIds, e.personIds]).sort(), [
      ['e1', [], [], [J, S]],
      ['e2', [], [], [J]],
    ]);
    const stored = JSON.stringify([await ann.listEntities(), await ann.listEntityAliases(), await ann.listEntityHistory(100), events]);
    for (const name of ['Jen', 'Jennifer', 'Sam']) assert.ok(!stored.includes(name), `${name} is still readable`);
  } finally {
    server.close();
  }
});

test('genres: a member keeps only the genres they set; the owner\'s shared ones stay the owner\'s', async () => {
  const s = await base();
  const row = (key: string, source: 'you' | 'music-story') => ({ key, name: key, source, genres: [{ parent: 'electronic', style: 'house', weight: 1 }], checkedAt: '2026-01-01T00:00:00Z' });
  await s.forUser(OWNER).putArtistGenres([row('zedd', 'music-story'), row('zedd', 'you')]);
  await s.forUser(ANN).putArtistGenres([row('moon garden', 'you')]);
  assert.deepEqual((await s.forUser(ANN).listArtistGenres()).map((g) => g.key), ['moon garden']);
  assert.deepEqual((await s.forUser(BOB).listArtistGenres()).map((g) => g.key), []);
  assert.deepEqual((await s.forUser(OWNER).listArtistGenres()).map((g) => `${g.key}:${g.source}`).sort(), ['zedd:music-story', 'zedd:you']);
  await assert.rejects(s.forUser(ANN).putArtistGenres([row('x', 'music-story')]), /only keep genres they set/);
  await s.forUser(ANN).deleteArtistGenres('moon garden', 'you');
  assert.deepEqual(await s.forUser(ANN).listArtistGenres(), []);
});
