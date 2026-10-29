import { test } from 'node:test';
import assert from 'node:assert/strict';
import { multiUserFromEnv, workerSettings } from '../src/server/auth/config.ts';

const ACCESS = { ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com', ACCESS_AUD: 'aud' };
const SUPABASE = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_JWT_SECRET: 'secret' };

// The incident: MULTI_USER was set as a Worker binding but the process
// environment did not have it, so the app started single-owner.
test('MULTI_USER given only as a binding turns multi-user on', () => {
  const settings = workerSettings({ MULTI_USER: 'on', ...ACCESS, ...SUPABASE }, {});
  assert.ok(multiUserFromEnv(settings));
});

test('the process environment wins over a binding for the same name', () => {
  const settings = workerSettings({ MULTI_USER: 'on' }, { MULTI_USER: 'off' });
  assert.equal(settings.MULTI_USER, 'off');
  assert.equal(multiUserFromEnv(settings), null);
});

test('non-string bindings (queues, databases) are left out', () => {
  const settings = workerSettings({ LOOKUP_QUEUE: { send() {} }, MULTI_USER: 'on' }, {});
  assert.equal(typeof settings.LOOKUP_QUEUE, 'undefined');
  assert.equal(settings.MULTI_USER, 'on');
});

test('half-configured multi-user is refused, not run single-owner', () => {
  assert.throws(() => multiUserFromEnv(workerSettings({ MULTI_USER: 'on' }, {})), /MULTI_USER=on needs/);
});
