import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyJwtMint } from '../scripts/verify-jwt-mint.ts';

const SECRET = 'a-test-secret-of-some-length-for-hs256';
const USER = '11111111-1111-4111-8111-111111111111';
const env = { url: 'https://x.supabase.co', anonKey: 'anon', jwtSecret: SECRET, userId: USER, email: 'o@example.com' };
const NOW = Date.parse('2026-10-29T12:00:00Z');

// A stand-in for PostgREST: checks the signature and expiry the way Supabase does.
const postgrest = (rows: unknown[]) => async (_url: string, init: { headers: Record<string, string> }) => {
  const token = init.headers.authorization.replace('Bearer ', '');
  const [h, p, sig] = token.split('.');
  const expect = createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  const ok = sig === expect && claims.exp * 1000 > NOW && claims.role === 'authenticated' && claims.aud === 'authenticated';
  return { status: ok ? 200 : 401, text: async () => (ok ? JSON.stringify(rows) : '{"message":"JWT invalid"}') };
};

test('verify-jwt-mint: a good setup passes every check', async () => {
  const checks = await verifyJwtMint(env, postgrest([{ user_id: USER }]), NOW);
  assert.deepEqual(checks.map((c) => c.status), ['pass', 'pass', 'pass', 'pass']);
});

test('verify-jwt-mint: no rows to compare is inconclusive, not a pass', async () => {
  const checks = await verifyJwtMint(env, postgrest([]), NOW);
  assert.equal(checks.find((c) => c.name.startsWith('auth.uid'))!.status, 'inconclusive');
});

test('verify-jwt-mint: another user\'s row visible fails; a wrong secret fails', async () => {
  const leaky = await verifyJwtMint(env, postgrest([{ user_id: USER }, { user_id: 'someone-else' }]), NOW);
  assert.equal(leaky.find((c) => c.name.startsWith('auth.uid'))!.status, 'fail');
  const wrong = await verifyJwtMint({ ...env, jwtSecret: 'not-the-projects-secret-at-all-ok' }, postgrest([]), NOW);
  assert.equal(wrong[0].status, 'fail');
  assert.match(wrong[0].detail, /JWT Secret/);
});
