import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, redactSecrets, redactUrl } from '../src/server/lineup/http.ts';

test('http: credentials never appear in error messages or logs', () => {
  const url = 'https://app.ticketmaster.com/discovery/v2/events.json?apikey=abc123secret&keyword=EDC';
  assert.equal(redactUrl(url), 'https://app.ticketmaster.com/discovery/v2/events.json?apikey=REDACTED&keyword=EDC');
  const err = new HttpError(401, url);
  assert.ok(!err.message.includes('abc123secret'));
  assert.ok(err.message.includes('keyword=EDC'));

  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'gemini-secret-value';
  try {
    assert.equal(
      redactSecrets('failed with key gemini-secret-value at https://clashfinder.com/x.json?authUsername=me&authPublicKey=ff00'),
      'failed with key REDACTED at https://clashfinder.com/x.json?authUsername=me&authPublicKey=REDACTED',
    );
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  }
});
