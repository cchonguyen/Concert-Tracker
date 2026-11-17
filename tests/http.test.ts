import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, createRateLimitedFetcher, redactSecrets, redactUrl } from '../src/server/lineup/http.ts';

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

test('createRateLimitedFetcher: retries on 503 up to maxRetries', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) {
      return new Response('Rate limited', { status: 503, headers: { 'retry-after': '0.01' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const fetcher = createRateLimitedFetcher();
    const res = await fetcher.get('https://musicbrainz.org/ws/2/artist/test');
    assert.equal(calls, 2);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createRateLimitedFetcher: refuses axs.com and its subdomains before any request', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('ok', { status: 200 });
  }) as typeof fetch;

  try {
    const fetcher = createRateLimitedFetcher();
    await assert.rejects(() => fetcher.get('https://axs.com/event/1'), /AXS pages are never fetched/);
    await assert.rejects(() => fetcher.get('https://www.axs.com/event/1'), /AXS pages are never fetched/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createRateLimitedFetcher: refuses a redirect into axs.com', async () => {
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response(null, { status: 302, headers: { location: 'https://www.axs.com/event/9' } });
  }) as typeof fetch;

  try {
    const fetcher = createRateLimitedFetcher();
    await assert.rejects(() => fetcher.get('https://example.org/start'), /AXS pages are never fetched/);
    assert.deepEqual(seen, ['https://example.org/start']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createRateLimitedFetcher: a normal host is still fetched', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('hello', { status: 200 })) as typeof fetch;

  try {
    const res = await createRateLimitedFetcher().get('https://example.org/page');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'hello');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createRateLimitedFetcher: stops retrying and returns 503 after maxRetries', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('Rate limited', { status: 503, headers: { 'retry-after': '0.01' } });
  }) as typeof fetch;

  try {
    const fetcher = createRateLimitedFetcher();
    const res = await fetcher.get('https://musicbrainz.org/ws/2/artist/test', { maxRetries: 2 });
    assert.equal(calls, 3);
    assert.equal(res.status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
