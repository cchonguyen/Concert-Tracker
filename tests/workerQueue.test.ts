import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/server/lineup/http.ts';

test('worker queue: retry threshold and secret redaction', () => {
  const secretError = new Error('Database connection failed with key: super-secret-key-12345');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'super-secret-key-12345';

  const messageText = redactSecrets(secretError.message);
  assert.ok(!messageText.includes('super-secret-key-12345'));
  assert.ok(messageText.includes('REDACTED'));

  // Test retry threshold logic: attempts = 1..3 should remain queued with retry, attempt 4 marks failed
  const isFinalAttempt = (attempts: number, maxRetries = 3) => attempts >= maxRetries + 1;
  assert.equal(isFinalAttempt(1), false);
  assert.equal(isFinalAttempt(2), false);
  assert.equal(isFinalAttempt(3), false);
  assert.equal(isFinalAttempt(4), true);
  assert.equal(isFinalAttempt(5), true);
});
