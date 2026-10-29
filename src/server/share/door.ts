import type { LineupStore } from '../lineup/store/types';
import { type AccessConfig, verifyAccessToken } from './access';
import { findShareLink } from './links';
import { NOT_ACTIVE_HTML, renderSharePage, SHARE_HEADERS, UNAVAILABLE_HTML } from './page';
import type { ShareSettings } from './types';
import { buildShareView } from './view';
import { isPublicPath, oldAppLink, robotsTxt, SITE_ORIGIN, sitemapXml } from '../site/publicPaths';

// The page for these settings, read with the share columns only. Used by
// /s/<code> and by the owner's preview.
export async function sharePageHtml(store: LineupStore, settings: ShareSettings, now: Date): Promise<string> {
  const events = await store.listShareEvents();
  const editionIds = [...new Set(events.flatMap((e) => (e.editionId ? [e.editionId] : [])))];
  const lineups = editionIds.length ? await store.editionLineupFacts(editionIds) : {};
  return renderSharePage(buildShareView(events, settings, now, lineups));
}

// Cloudflare Access keeps its sign-in token in this cookie as well as in the
// header it adds to requests it lets through. On a public page the header is
// missing, so the cookie is how the Worker knows who is signed in.
export async function isSignedIn(request: Request, access: AccessConfig | null, verify: typeof verifyAccessToken = verifyAccessToken): Promise<boolean> {
  if (!access) return false;
  const cookies = request.headers.get('cookie') ?? '';
  const token = cookies
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('CF_Authorization='))
    ?.slice('CF_Authorization='.length);
  return verify(token ? decodeURIComponent(token) : null, access);
}

// The first thing the Worker runs on every request it sees. Share page
// paths are answered here and never reach Express or the static files; old
// app addresses are sent on to /app; every other request that is not a public
// page (publicPaths.ts) needs a valid Cloudflare Access token when that check
// is configured. Returns the response to send, or null to carry on.

// Exactly /s/ and a 22-character code. Anything else under /s (any case, a
// trailing slash, more path, percent-encoding) is the "not active" page.
const SHARE_PATH = /^\/s\/([A-Za-z0-9_-]{22})$/;
const UNDER_SHARE = /^\/s(\/|$)/i;

export interface DoorDeps {
  store: () => Promise<LineupStore>;
  access: AccessConfig | null;
  now?: () => Date;
  verify?: typeof verifyAccessToken;
}

const html = (body: string, status: number, method: string) =>
  new Response(method === 'HEAD' ? null : body, { status, headers: SHARE_HEADERS });

export async function frontDoor(request: Request, deps: DoorDeps): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const moved = oldAppLink(url);
  if (moved) return new Response(null, { status: 302, headers: { Location: moved, 'Cache-Control': 'no-store' } });
  // A signed-in visitor goes straight to the app from the marketing page, unless
  // they asked for the public page with ?public=1.
  if (path === '/' && url.searchParams.get('public') !== '1' && (await isSignedIn(request, deps.access, deps.verify))) {
    return new Response(null, { status: 302, headers: { Location: '/app', 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  }
  if (path === '/robots.txt') return new Response(robotsTxt(SITE_ORIGIN), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
  if (path === '/sitemap.xml') return new Response(sitemapXml(SITE_ORIGIN), { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
  if (UNDER_SHARE.test(path)) {
    const method = request.method === 'HEAD' ? 'HEAD' : 'GET';
    const code = request.method === 'GET' || request.method === 'HEAD' ? SHARE_PATH.exec(path)?.[1] : undefined;
    if (!code) return html(NOT_ACTIVE_HTML, 404, method);
    try {
      const store = await deps.store();
      const link = await findShareLink(store, code);
      if (!link) return html(NOT_ACTIVE_HTML, 404, method);
      // A member's link shows that member's events only (multi-user mode).
      const owner = link.userId && store.forUser ? store.forUser({ userId: link.userId, role: 'member' }) : store;
      const page = await sharePageHtml(owner, link.settings, deps.now?.() ?? new Date());
      // Only the link's id is logged, never its code.
      console.log(`Share page served for link ${link.id}`);
      return html(page, 200, method);
    } catch (err) {
      console.error('Share page failed:', err instanceof Error ? err.message : String(err));
      return html(UNAVAILABLE_HTML, 503, method);
    }
  }
  if (deps.access && !isPublicPath(path)) {
    const ok = await (deps.verify ?? verifyAccessToken)(request.headers.get('cf-access-jwt-assertion'), deps.access);
    if (!ok) return new Response('Sign in required.', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  return null;
}
