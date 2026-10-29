import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { accessConfigFromEnv, clearAccessKeys, readAccessClaims } from '../src/server/share/access.ts';
import { mintSupabaseToken, SUPABASE_TOKEN_SECONDS } from '../src/server/auth/supabaseJwt.ts';
import { clearMemberCache, NotInvitedError, resolveMember, type MemberDirectory } from '../src/server/auth/members.ts';
import { multiUserFromEnv } from '../src/server/auth/config.ts';

const NOW = Date.parse('2026-10-29T12:00:00Z');

async function accessFixture() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
  const config = accessConfigFromEnv({ ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud-1' })!;
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = async (payload: Record<string, unknown>) => {
    const data = `${enc({ alg: 'RS256', kid: 'k1' })}.${enc(payload)}`;
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(data));
    return `${data}.${Buffer.from(sig).toString('base64url')}`;
  };
  const good = { aud: ['aud-1'], iss: 'https://team.cloudflareaccess.com', exp: Math.floor(NOW / 1000) + 600, email: 'Friend@Example.com', sub: 'access-sub-1' };
  clearAccessKeys();
  return { config, sign, good, getJson: async () => ({ keys: [jwk] }) };
}

test('Access claims: a valid token gives the lower-cased email and sub; anything else gives null', async () => {
  const { config, sign, good, getJson } = await accessFixture();
  const read = (t: string | null) => readAccessClaims(t, config, NOW, getJson);
  assert.deepEqual(await read(await sign(good)), { email: 'friend@example.com', sub: 'access-sub-1' });
  assert.equal(await read(null), null);
  assert.equal(await read(await sign({ ...good, aud: ['other'] })), null);
  const [h, , s] = (await sign(good)).split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...good, email: 'owner@example.com' })).toString('base64url')}.${s}`;
  assert.equal(await read(forged), null);
});

test('Supabase token: HS256 with the secret, the member as sub, authenticated role, 60 seconds', async () => {
  const token = await mintSupabaseToken({ userId: 'u-1', email: 'friend@example.com' }, 'secret', NOW);
  const [h, p, s] = token.split('.');
  assert.equal(createHmac('sha256', 'secret').update(`${h}.${p}`).digest('base64url'), s);
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'HS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(claims.sub, 'u-1');
  assert.equal(claims.role, 'authenticated');
  assert.equal(claims.aud, 'authenticated');
  assert.equal(claims.exp - claims.iat, SUPABASE_TOKEN_SECONDS);
  assert.equal(claims.iat, NOW / 1000);
  await assert.rejects(mintSupabaseToken({ userId: 'u-1', email: 'x' }, '', NOW));
  await assert.rejects(mintSupabaseToken({ userId: '', email: 'x' }, 'secret', NOW));
});

function directory(rows: Record<string, { userId: string | null; role: 'owner' | 'member' }>) {
  const calls: string[] = [];
  const dir: MemberDirectory = {
    async findMember(email) {
      calls.push(`find ${email}`);
      const r = rows[email];
      return r ? { email, ...r } : null;
    },
    async createAuthUser(email) {
      calls.push(`create ${email}`);
      return `new-${email}`;
    },
    async linkMember(email, userId) {
      calls.push(`link ${email} ${userId}`);
      rows[email].userId = userId;
    },
  };
  return { dir, calls };
}

test('members: an invited email gets its user id; the first sign-in makes and links one; others are refused', async () => {
  clearMemberCache();
  const { dir, calls } = directory({ 'owner@example.com': { userId: 'u-owner', role: 'owner' }, 'friend@example.com': { userId: null, role: 'member' } });
  assert.deepEqual(await resolveMember('Owner@Example.com', dir, NOW), { email: 'owner@example.com', userId: 'u-owner', role: 'owner' });
  assert.deepEqual(await resolveMember('friend@example.com', dir, NOW), { email: 'friend@example.com', userId: 'new-friend@example.com', role: 'member' });
  assert.deepEqual(calls.slice(1), ['find friend@example.com', 'create friend@example.com', 'link friend@example.com new-friend@example.com']);
  await assert.rejects(resolveMember('stranger@example.com', dir, NOW), NotInvitedError);
  await assert.rejects(resolveMember('', dir, NOW), NotInvitedError);
});

test('members: a found member is cached for five minutes, then looked up again', async () => {
  clearMemberCache();
  const { dir, calls } = directory({ 'owner@example.com': { userId: 'u-owner', role: 'owner' } });
  await resolveMember('owner@example.com', dir, NOW);
  await resolveMember('owner@example.com', dir, NOW + 60_000);
  assert.equal(calls.length, 1);
  await resolveMember('owner@example.com', dir, NOW + 6 * 60_000);
  assert.equal(calls.length, 2);
});

test('multi-user config: off unless MULTI_USER=on; on but half set is an error, not single-owner', () => {
  const full = { MULTI_USER: 'on', ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com', ACCESS_AUD: 'a', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_JWT_SECRET: 's' };
  assert.equal(multiUserFromEnv({}), null);
  assert.equal(multiUserFromEnv({ ...full, MULTI_USER: 'off' }), null);
  assert.equal(multiUserFromEnv(full)?.jwtSecret, 's');
  assert.throws(() => multiUserFromEnv({ ...full, SUPABASE_JWT_SECRET: '' }), /SUPABASE_JWT_SECRET/);
  assert.throws(() => multiUserFromEnv({ ...full, ACCESS_AUD: undefined }), /ACCESS_TEAM_DOMAIN/);
});
