import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LoggedEvent } from '../src/server/events/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { createShareLink, revokeShareLinks } from '../src/server/share/links.ts';
import { frontDoor } from '../src/server/share/door.ts';
import { escapeHtml, renderSharePage, SHARE_HEADERS } from '../src/server/share/page.ts';
import { accessConfigFromEnv, clearAccessKeys, verifyAccessToken } from '../src/server/share/access.ts';
import { buildShareView } from '../src/server/share/view.ts';
import { top } from '../src/services/stats.ts';
import type { ShareSettings } from '../src/server/share/types.ts';

const ev = (id: string, patch: Partial<LoggedEvent>): LoggedEvent => ({
  id,
  input: id,
  name: id,
  sources: {},
  details: { status: 'resolved', candidates: [], notes: [] },
  seen: [],
  daysAttended: [],
  companions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...patch,
});
const act = (name: string) => ({ key: name.toLowerCase(), name, from: 'you' as const });
const settings: ShareSettings = { displayName: 'Owner', timeZone: 'UTC', showDates: true, showVenues: true, showFormat: false };
const NOW = new Date('2026-10-28T12:00:00Z');
const ORIGIN = 'https://concert.example.com';

async function setup() {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'share-route-')));
  await store.putEvents([
    ev('a', { name: '<script>alert(1)</script>', startDate: '2025-03-01', city: 'Los Angeles', seen: [act('"><img src=x onerror=alert(1)>')], companions: ['SECRET_FRIEND'], notes: 'SECRET_NOTE' }),
    ev('tonight', { name: 'TONIGHT_SHOW', startDate: '2026-10-28' }),
  ]);
  const { code } = await createShareLink(store, settings, NOW);
  const door = (url: string, init?: RequestInit, access: Parameters<typeof frontDoor>[1]['access'] = null) =>
    frontDoor(new Request(`${ORIGIN}${url}`, init), { store: async () => store, access, now: () => NOW });
  return { store, code, door };
}

test('a share link opens the page with its headers, escaped, and nothing private', async () => {
  const { code, door } = await setup();
  const res = (await door(`/s/${code}`))!;
  assert.equal(res.status, 200);
  for (const [k, v] of Object.entries(SHARE_HEADERS)) assert.equal(res.headers.get(k), v, k);
  const body = await res.text();
  assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!body.includes('<script'), 'script tag rendered');
  assert.ok(!body.includes('<img'), 'img tag rendered');
  assert.ok(body.includes('Owner'));
  for (const m of ['SECRET_FRIEND', 'SECRET_NOTE', 'TONIGHT_SHOW']) assert.ok(!body.includes(m), `${m} shown`);
});

test('path tricks, wrong codes and other methods all get the same "not active" page', async () => {
  const { code, door } = await setup();
  const notActive = await (await door('/s/AAAAAAAAAAAAAAAAAAAAAA'))!.text();
  const paths = ['/s', '/s/', `/s/${code}/`, `/s/${code}/extra`, `/S/${code}`, `/s/${code.slice(1)}`, `/s/%41${code.slice(1)}`, '/S'];
  // Dot segments ('/s/x/../../api/events') are normalized away before the Worker sees the path, so
  // they are not share paths at all: the Access token check below is what refuses them.
  for (const p of paths) {
    const res = (await door(p))!;
    assert.ok(res, `${p} fell through`);
    assert.equal(res.status, 404, p);
    assert.equal(await res.text(), notActive, p);
    assert.equal(res.headers.get('Content-Security-Policy'), SHARE_HEADERS['Content-Security-Policy'], p);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = (await door(`/s/${code}`, { method }))!;
    assert.equal(res.status, 404, method);
    assert.equal(await res.text(), notActive, method);
  }
});

test('HEAD answers with the headers and no body; a turned-off link stops at once', async () => {
  const { store, code, door } = await setup();
  const head = (await door(`/s/${code}`, { method: 'HEAD' }))!;
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Cache-Control'), 'no-store');
  assert.equal(await head.text(), '');
  await revokeShareLinks(store, NOW);
  assert.equal((await door(`/s/${code}`))!.status, 404);
});

test('the public route makes no writes', async () => {
  const { store, code, door } = await setup();
  const before = JSON.stringify([await store.listShareLinks(), await store.listEvents()]);
  await door(`/s/${code}`);
  await door('/s/nothing');
  assert.equal(JSON.stringify([await store.listShareLinks(), await store.listEvents()]), before);
});

test('a broken store shows a plain "not available" page, not the error', async () => {
  const res = (await frontDoor(new Request(`${ORIGIN}/s/AAAAAAAAAAAAAAAAAAAAAA`), {
    store: async () => {
      throw new Error('SUPABASE_SECRET_DETAIL');
    },
    access: null,
  }))!;
  assert.equal(res.status, 503);
  assert.ok(!(await res.text()).includes('SUPABASE_SECRET_DETAIL'));
});

test('other paths carry on without the Access check until it is configured', async () => {
  const { door } = await setup();
  assert.equal(await door('/api/events'), null);
  assert.equal(await door('/'), null);
});

// A signing key and tokens like Cloudflare Access issues them.
async function accessFixture() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
  const config = accessConfigFromEnv({ ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud-1' })!;
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = async (payload: Record<string, unknown>, kid = 'k1') => {
    const data = `${enc({ alg: 'RS256', kid })}.${enc(payload)}`;
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(data));
    return `${data}.${Buffer.from(sig).toString('base64url')}`;
  };
  const exp = Math.floor(NOW.getTime() / 1000) + 600;
  const good = { aud: ['aud-1'], iss: 'https://team.cloudflareaccess.com', exp, email: 'owner@example.com' };
  const getJson = async (url: string) => {
    assert.equal(url, 'https://team.cloudflareaccess.com/cdn-cgi/access/certs');
    return { keys: [jwk] };
  };
  clearAccessKeys();
  return { config, sign, good, getJson };
}

test('Access tokens: only a signed, current token for this app and team passes', async () => {
  const { config, sign, good, getJson } = await accessFixture();
  const check = (t: string | null) => verifyAccessToken(t, config, NOW.getTime(), getJson);
  assert.equal(await check(await sign(good)), true);
  assert.equal(await check(null), false);
  assert.equal(await check('not.a.token'), false);
  assert.equal(await check(await sign({ ...good, aud: ['other'] })), false);
  assert.equal(await check(await sign({ ...good, iss: 'https://evil.cloudflareaccess.com' })), false);
  assert.equal(await check(await sign({ ...good, exp: Math.floor(NOW.getTime() / 1000) - 1 })), false);
  assert.equal(await check(await sign(good, 'unknown-kid')), false);
  const [h, p, s] = (await sign(good)).split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...good, email: 'x@evil.com' })).toString('base64url')}.${s}`;
  assert.equal(await check(forged), false);
  assert.equal(await check(`${h}.${p}.`), false);
});

test('Access token keys: imported CryptoKey is cached by kid and cleared by clearAccessKeys', async () => {
  const { config, sign, good, getJson } = await accessFixture();
  let importCalls = 0;
  const originalImport = crypto.subtle.importKey.bind(crypto.subtle);
  crypto.subtle.importKey = (async (...args: Parameters<typeof originalImport>) => {
    importCalls++;
    return originalImport(...args);
  }) as typeof crypto.subtle.importKey;
  try {
    const token = await sign(good);
    assert.equal(await verifyAccessToken(token, config, NOW.getTime(), getJson), true);
    assert.equal(importCalls, 1);
    // Second verification with the same kid reuses the cached CryptoKey without re-importing
    assert.equal(await verifyAccessToken(token, config, NOW.getTime(), getJson), true);
    assert.equal(importCalls, 1);
    // After clearing the cache, verification imports the key again
    clearAccessKeys();
    assert.equal(await verifyAccessToken(token, config, NOW.getTime(), getJson), true);
    assert.equal(importCalls, 2);
  } finally {
    crypto.subtle.importKey = originalImport;
  }
});

test('with Access configured, everything but the share page needs a valid token', async () => {
  const { store, code } = await setup();
  const { config, sign, good, getJson } = await accessFixture();
  const verify: typeof verifyAccessToken = (t, c) => verifyAccessToken(t, c, NOW.getTime(), getJson);
  const door = (url: string, headers: Record<string, string> = {}) =>
    frontDoor(new Request(`${ORIGIN}${url}`, { headers }), { store: async () => store, access: config, now: () => NOW, verify });
  assert.equal((await door('/api/events'))!.status, 403);
  assert.equal((await door('/app'))!.status, 403);
  // A dot-segment trick is normalized to /api/events before the Worker sees it, and still needs a token.
  assert.equal((await door('/s/%2e%2e/api/events'))!.status, 403);
  assert.equal(await door('/api/events', { 'cf-access-jwt-assertion': await sign(good) }), null);
  assert.equal((await door(`/s/${code}`))!.status, 200);
});

test('share page stats match the app\'s Stats for the same events', () => {
  const list = [
    ev('a', { startDate: '2024-01-01', seen: [act('X'), act('Y')] }),
    ev('b', { startDate: '2025-01-01', seen: [act('X')] }),
  ];
  const v = buildShareView(list, settings, NOW);
  assert.deepEqual(v.mostSeen, top(list, 'artist', 10).map((r) => ({ name: r.label, count: r.count })));
  assert.ok(renderSharePage(v).includes('2 events'));
});

test('escapeHtml covers the five characters', () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
});
