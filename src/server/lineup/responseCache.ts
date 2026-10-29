import { createHash } from 'node:crypto';
import type { Fetcher, FetchResponse } from './types';
import type { LineupStore } from './store/types';

// A 24-hour cache of raw upstream responses, so two people asking about the
// same event on the same day cost one request. Off unless SOURCE_CACHE=on.
//
// Only hosts whose terms allow it are listed. Ticketmaster's Discovery terms
// let an app keep Event Content "for reasonable periods in order to provide
// the service"; 24 hours is that. Brave Search's terms forbid storing or
// caching Search Results beyond transient storage, so Brave is never cached
// and must never be added here. Pages the app reads for a lineup are not
// cached here: they are already kept as source documents with their quotes.
//
// What is stored is the raw response only. Stage 1 assembly still runs per
// member, and no typed personal field is in a cache key: the key is the
// request URL with the API key removed.
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const CACHEABLE_HOSTS = new Set(['app.ticketmaster.com']);
const SECRET_PARAMS = ['apikey', 'api_key', 'key', 'token'];

export interface CachedResponse {
  key: string;
  sourceType: string;
  status: number;
  body: string;
  fetchedAt: string;
  expiresAt: string;
}

export function cacheKey(rawUrl: string): { host: string; key: string } {
  const url = new URL(rawUrl);
  for (const p of SECRET_PARAMS) url.searchParams.delete(p);
  url.searchParams.sort();
  url.hash = '';
  const host = url.hostname.toLowerCase();
  return { host, key: createHash('sha256').update(`${host}${url.pathname}?${url.searchParams.toString()}`).digest('hex') };
}

export function cachingFetcher(inner: Fetcher, store: LineupStore, now: () => Date = () => new Date()): Fetcher {
  return {
    async get(url, init) {
      let target: { host: string; key: string } | null = null;
      try {
        const k = cacheKey(url);
        if (CACHEABLE_HOSTS.has(k.host)) target = k;
      } catch {
        // Not a URL the cache understands; let the fetcher refuse or fetch it.
      }
      if (!target || !store.getCachedResponse) return inner.get(url, init);
      const hit = await store.getCachedResponse(target.key, now());
      if (hit) return { url, status: hit.status, headers: { 'x-cache': 'hit' }, body: hit.body } satisfies FetchResponse;
      const res = await inner.get(url, init);
      // Only a good answer is kept; an error or a rate limit is not.
      if (res.status === 200 && store.putCachedResponse) {
        const at = now();
        await store.putCachedResponse({
          key: target.key,
          sourceType: 'ticketmaster',
          status: res.status,
          body: res.body,
          fetchedAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + CACHE_TTL_MS).toISOString(),
        });
      }
      return res;
    },
  };
}
