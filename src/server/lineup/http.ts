import { Fetcher, FetchResponse } from './types';

// Minimum spacing between requests per host. MusicBrainz bans clients that
// exceed 1 req/s; the others are kept polite.
const HOST_INTERVAL_MS: Record<string, number> = {
  'musicbrainz.org': 1100,
  'api.setlist.fm': 600,
  'app.ticketmaster.com': 300,
  'clashfinder.com': 1000,
  'archive.org': 1000,
  'web.archive.org': 1000,
};
const DEFAULT_INTERVAL_MS = 500;

export function userAgent(): string {
  const contact = process.env.CONTACT_EMAIL || 'set-CONTACT_EMAIL@example.com';
  return `LiveArchiveConcertTracker/2.0 ( ${contact} )`;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message?: string,
  ) {
    super(message || `HTTP ${status} for ${url}`);
  }
}

// Lineup URLs come from user input and search results, so refuse anything
// that points back into the server's own network.
export function assertPublicHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Refusing non-web URL: ${raw}`);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateHost =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    /^(0|10|127)\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^(::1?|f[cd][0-9a-f]{2}:.*|fe80:.*)$/.test(host) ||
    /^\d+$/.test(host);
  if (privateHost) throw new Error(`Refusing private or local address: ${url.hostname}`);
  return url;
}

export function createRateLimitedFetcher(): Fetcher {
  const nextSlot = new Map<string, number>();

  async function waitTurn(host: string): Promise<void> {
    const interval = HOST_INTERVAL_MS[host] ?? DEFAULT_INTERVAL_MS;
    const now = Date.now();
    const slot = Math.max(now, nextSlot.get(host) ?? 0);
    nextSlot.set(host, slot + interval);
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }

  return {
    async get(url, init = {}): Promise<FetchResponse> {
      const host = assertPublicHttpUrl(url).hostname.replace(/^www\./, '');
      await waitTurn(host);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 15000);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          redirect: 'follow',
          headers: { 'User-Agent': userAgent(), ...init.headers },
        }).catch((err) => {
          const cause = (err as { cause?: { code?: string } })?.cause?.code;
          throw new Error(`Could not reach ${host}${cause ? ` (${cause})` : ''}: ${err instanceof Error ? err.message : String(err)}`);
        });
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => (headers[k] = v));
        return { url: res.url || url, status: res.status, headers, body: await res.text() };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function parseJson<T>(res: FetchResponse): T {
  if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, res.url);
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new HttpError(res.status, res.url, `Invalid JSON from ${res.url}`);
  }
}
