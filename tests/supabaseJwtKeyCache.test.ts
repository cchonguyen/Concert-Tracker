import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintSupabaseToken } from '../src/server/auth/supabaseJwt.ts';

const user = { userId: '11111111-1111-4111-8111-111111111111', email: 'o@example.com' };
const NOW = Date.parse('2026-11-13T12:00:00Z');

test('mintSupabaseToken: concurrent and repeated mints with one secret agree', async () => {
  const secret = 'a-test-secret-of-some-length-for-hs256';
  const [a, b] = await Promise.all([mintSupabaseToken(user, secret, NOW), mintSupabaseToken(user, secret, NOW)]);
  const c = await mintSupabaseToken(user, secret, NOW);
  assert.equal(a, b);
  assert.equal(a, c);
  assert.notEqual(await mintSupabaseToken(user, 'another-secret-of-some-length-for-hs256', NOW), a);
});
