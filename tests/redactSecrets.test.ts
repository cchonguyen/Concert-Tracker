import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, SECRET_ENV } from '../src/server/lineup/http.ts';

test('redactSecrets: redacts all configured secrets across environment', () => {
  const originalEnv = { ...process.env };

  try {
    for (const name of SECRET_ENV) {
      process.env[name] = `secret-value-for-${name}-long`;
    }

    // Check every key in SECRET_ENV is scrubbed
    for (const name of SECRET_ENV) {
      const secret = process.env[name]!;
      const leaked = `An error occurred with key: ${secret}`;
      const redacted = redactSecrets(leaked);
      assert.ok(!redacted.includes(secret), `Expected ${name} to be redacted`);
      assert.ok(redacted.includes('REDACTED'), `Expected REDACTED placeholder for ${name}`);
    }

    // Verify key security-sensitive env names are present on SECRET_ENV list
    const criticalKeys = [
      'SUPABASE_JWT_SECRET',
      'RESEND_API_KEY',
      'GOOGLE_CLIENT_SECRET',
      'EMAIL_UNSUBSCRIBE_SECRET',
      'SHEETS_TOKEN_ENC_KEY',
      'IMPORT_TOKEN',
      'SUPABASE_SERVICE_ROLE_KEY',
      'GEMINI_API_KEY',
    ];

    for (const k of criticalKeys) {
      assert.ok(SECRET_ENV.includes(k), `SECRET_ENV must include ${k}`);
    }
  } finally {
    process.env = originalEnv;
  }
});
