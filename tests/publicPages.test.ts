import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { frontDoor } from '../src/server/share/door.ts';
import { PUBLIC_EXACT_PATHS, PUBLIC_PREFIXES, isPublicPath, oldAppLink } from '../src/server/site/publicPaths.ts';
import { accessConfigFromEnv, type AccessConfig } from '../src/server/share/access.ts';

const ORIGIN = 'https://concert.example';
const config: AccessConfig = { teamDomain: 'https://team.cloudflareaccess.com', aud: 'aud-tag' };
// Access is on, and no request carries a token, so only public paths get through.
const door = (url: string) => frontDoor(new Request(`${ORIGIN}${url}`), { store: async () => ({}) as never, access: config });

test('the public allowlist is exactly the paths the document lists', () => {
  const doc = readFileSync(new URL('../ARCHITECTURE.md', import.meta.url), 'utf8');
  const section = doc.slice(doc.indexOf('Public allowlist.'), doc.indexOf("The site's one address"));
  const listed = [...section.matchAll(/`(\/[^`]*)`/g)].map((m) => m[1]);
  const expected = [...PUBLIC_EXACT_PATHS, ...PUBLIC_PREFIXES.map((p) => `${p}*`)];
  assert.deepEqual([...new Set(listed)].sort(), [...new Set(expected)].sort());
});

test('site.config.json origin matches APP_URL in wrangler.jsonc', () => {
  const origin = JSON.parse(readFileSync(new URL('../site.config.json', import.meta.url), 'utf8')).origin;
  const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.equal(wrangler.match(/"APP_URL":\s*"([^"]+)"/)?.[1], origin);
});

test('public pages are open without a token; the app and the API are not', async () => {
  for (const path of ['/', '/index.html', '/privacy', '/terms', '/assets/index-abc123.js', '/favicon.svg']) {
    assert.equal(await door(path), null, path);
  }
  for (const path of ['/app', '/app.html', '/api/events', '/DEMO', '/privacy/x']) {
    assert.equal((await door(path))!.status, 403, path);
  }
});

test('path tricks cannot reach the app or the API through a public prefix', async () => {
  for (const path of ['/assets/../api/events', '/assets/%2e%2e/api/events', '/index.html/../api/events', '/%2e%2e/api/events', '/s/%2e%2e/app']) {
    assert.equal((await door(path))!.status, 403, path);
  }
});

test('an old app address goes to /app with the same query', async () => {
  const res = (await door('/?view=table&sheets=ok'))!;
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/app?view=table&sheets=ok');
  assert.equal(oldAppLink(new URL(`${ORIGIN}/?gmail=Connected.`)), '/app?gmail=Connected.');
  assert.equal(oldAppLink(new URL(`${ORIGIN}/`)), null);
  assert.equal(oldAppLink(new URL(`${ORIGIN}/app?view=map`)), null);
});

test('isPublicPath is exact for pages and by prefix only for the listed folders', () => {
  assert.equal(isPublicPath('/privacy'), true);
  assert.equal(isPublicPath('/privacy/extra'), false);
  assert.equal(isPublicPath('/assetsx/a.js'), false);
});

test('access config reads the two settings and nothing else', () => {
  assert.equal(accessConfigFromEnv({}), null);
  assert.deepEqual(accessConfigFromEnv({ ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'a' }), {
    teamDomain: 'https://team.cloudflareaccess.com',
    aud: 'a',
  });
});
