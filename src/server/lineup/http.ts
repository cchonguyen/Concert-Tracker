import { Fetcher, FetchResponse } from './types';
import { currentBudget } from './budget';

// Minimum spacing between requests per host. MusicBrainz bans clients that
// exceed 1 req/s; the others are kept polite.
const HOST_INTERVAL_MS: Record<string, number> = {
  'api.search.brave.com': 1100,
  'musicbrainz.org': 1500,
  'api.setlist.fm': 600,
  'app.ticketmaster.com': 300,
  'clashfinder.com': 1000,
  'archive.org': 1000,
  'web.archive.org': 1000,
  'geocoding-api.open-meteo.com': 200,
  'archive-api.open-meteo.com': 200,
};
const DEFAULT_INTERVAL_MS = 500;

export function userAgent(): string {
  const contact = process.env.CONTACT_EMAIL || 'set-CONTACT_EMAIL@example.com';
  return `LiveArchiveConcertTracker/2.0 ( ${contact} )`;
}

// Query parameters that carry credentials. Job logs are shown in the UI and
// stored in the database, so URLs are redacted before they reach a message.
const SECRET_PARAMS = /^(api_?key|key|token|access_token|authPublicKey|auth_?key|secret|signature)$/i;

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const name of [...url.searchParams.keys()]) {
      if (SECRET_PARAMS.test(name)) url.searchParams.set(name, 'REDACTED');
    }
    return url.toString();
  } catch {
    return raw.replace(/([?&](?:api_?key|key|token|authPublicKey)=)[^&\s]+/gi, '$1REDACTED');
  }
}

export const SECRET_ENV = [
  'GEMINI_API_KEY',
  'TICKETMASTER_API_KEY',
  'SETLISTFM_API_KEY',
  'BRAVE_SEARCH_API_KEY',
  'CLASHFINDER_PUBLIC_KEY',
  'CLASHFINDER_PRIVATE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'SUPABASE_JWT_SECRET',
  'IMPORT_TOKEN',
  'GOOGLE_CLIENT_SECRET',
  'SHEETS_TOKEN_ENC_KEY',
  'GOOGLE_PICKER_API_KEY',
  'RESEND_API_KEY',
  'EMAIL_UNSUBSCRIBE_SECRET',
];

// Last line of defence for text shown to people: removes configured secret
// values and credential query parameters wherever they appear.
export function redactSecrets(text: string): string {
  let out = text.replace(/https?:\/\/[^\s"'<>]+/g, (u) => redactUrl(u));
  for (const name of SECRET_ENV) {
    const value = process.env[name];
    if (value && value.length >= 8) out = out.split(value).join('REDACTED');
  }
  return out;
}

export class HttpError extends Error {
  public readonly url: string;

  constructor(
    public readonly status: number,
    url: string,
    message?: string,
  ) {
    const safeUrl = redactUrl(url);
    super(message || `HTTP ${status} for ${safeUrl}`);
    this.url = safeUrl;
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
    /^(::1?|::ffff:.*|f[cd][0-9a-f]{2}:.*|fe80:.*)$/.test(host) ||
    /^\d+$/.test(host);
  if (privateHost) throw new Error(`Refusing private or local address: ${url.hostname}`);
  return url;
}

const DEFAULT_MAX_BYTES = 3145728;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Follows redirects by hand, so each hop is checked as a public address and
// charged to the budget. A fourth redirect is refused.
async function fetchFollowingRedirects(
  start: string,
  host: string,
  init: RequestInit,
): Promise<{ res: Response; url: string }> {
  let target = start;
  for (let hops = 0; ; hops++) {
    currentBudget()?.take();
    const res = await fetch(target, { ...init, redirect: 'manual' }).catch((err) => {
      const cause = (err as { cause?: { code?: string } })?.cause?.code;
      throw new Error(`Could not reach ${host}${cause ? ` (${cause})` : ''}: ${err instanceof Error ? err.message : String(err)}`);
    });
    const location = res.headers.get('location');
    if (!REDIRECT_STATUSES.has(res.status) || !location) return { res, url: target };
    if (hops >= MAX_REDIRECTS) throw new Error(`Too many redirects for ${host}`);
    await res.body?.cancel().catch(() => undefined);
    target = assertPublicHttpUrl(new URL(location, target).toString()).toString();
  }
}

// Reads at most maxBytes. The rest of the stream is cancelled, not read.
async function readCapped(res: Response, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  if (!res.body) return { body: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder().decode(bytes), truncated };
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
      const maxRetries = init.maxRetries ?? (host === 'musicbrainz.org' ? 2 : 0);
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        await waitTurn(host);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 15000);
        try {
          const { res, url: finalUrl } = await fetchFollowingRedirects(url, host, {
            signal: controller.signal,
            headers: { 'User-Agent': userAgent(), ...init.headers },
          });
          const maxBytes = init.maxBytes ?? DEFAULT_MAX_BYTES;
          const declared = res.headers.get('content-length');
          if (declared !== null && Number(declared) > maxBytes) {
            await res.body?.cancel().catch(() => undefined);
            throw new Error(`Response from ${host} is larger than ${maxBytes} bytes`);
          }
          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => (headers[k] = v));
          const { body, truncated } = await readCapped(res, maxBytes);
          const response: FetchResponse = {
            url: finalUrl,
            status: res.status,
            headers,
            body,
            ...(truncated ? { truncated } : {}),
          };

          if ((res.status === 503 || res.status === 429) && attempt < maxRetries) {
            const retryHeader = headers['retry-after'];
            const retrySeconds = retryHeader ? Number(retryHeader) : NaN;
            const delayMs = !Number.isNaN(retrySeconds) && retrySeconds > 0
              ? Math.min(retrySeconds * 1000, 10000)
              : 2000 * Math.pow(2, attempt);
            nextSlot.set(host, Math.max(nextSlot.get(host) ?? 0, Date.now() + delayMs));
            await new Promise((r) => setTimeout(r, delayMs));
            continue;
          }

          return response;
        } finally {
          clearTimeout(timeout);
        }
      }
      throw new Error(`Exceeded max retries for ${host}`);
    },
  };
}

export function parseJson<T>(res: FetchResponse): T {
  if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, res.url);
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new HttpError(res.status, res.url, `Invalid JSON from ${redactUrl(res.url)}`);
  }
}
