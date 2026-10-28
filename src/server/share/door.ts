import type { LineupStore } from '../lineup/store/types';
import { type AccessConfig, verifyAccessToken } from './access';
import { findShareLink } from './links';
import { NOT_ACTIVE_HTML, renderSharePage, SHARE_HEADERS, UNAVAILABLE_HTML } from './page';
import { buildShareView } from './view';

// The first thing the Worker runs on every request it sees. Share page
// paths are answered here and never reach Express or the static files; every
// other request needs a valid Cloudflare Access token when that check is
// configured. Returns the response to send, or null to carry on.

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
  if (UNDER_SHARE.test(path)) {
    const method = request.method === 'HEAD' ? 'HEAD' : 'GET';
    const code = request.method === 'GET' || request.method === 'HEAD' ? SHARE_PATH.exec(path)?.[1] : undefined;
    if (!code) return html(NOT_ACTIVE_HTML, 404, method);
    try {
      const store = await deps.store();
      const link = await findShareLink(store, code);
      if (!link) return html(NOT_ACTIVE_HTML, 404, method);
      const events = await store.listShareEvents();
      const editionIds = [...new Set(events.flatMap((e) => (e.editionId ? [e.editionId] : [])))];
      const lineups = editionIds.length ? await store.editionLineupFacts(editionIds) : {};
      const view = buildShareView(events, link.settings, deps.now?.() ?? new Date(), lineups);
      // Only the link's id is logged, never its code.
      console.log(`Share page served for link ${link.id}`);
      return html(renderSharePage(view), 200, method);
    } catch (err) {
      console.error('Share page failed:', err instanceof Error ? err.message : String(err));
      return html(UNAVAILABLE_HTML, 503, method);
    }
  }
  if (deps.access) {
    const ok = await (deps.verify ?? verifyAccessToken)(request.headers.get('cf-access-jwt-assertion'), deps.access);
    if (!ok) return new Response('Sign in required.', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  return null;
}
