// Brave Search monthly allowance: at most 200 queries a calendar month (UTC), counted in the app setting
// 'brave_monthly'. Brave results are never cached (responseCache.ts CACHEABLE_HOSTS holds Ticketmaster only).
//
// braveCapFetcher wraps the shared fetcher in createDeps (src/server/lineup/service.ts). Every request to
// api.search.brave.com takes one query from the allowance first. When the allowance is spent the wrapper answers
// 429 itself without calling the network: braveSearch (lineup/search.ts) and braveResults (events/details.ts)
// already turn a 429 into a quota park (QuotaExhaustedError) or a thrown error, so nothing falls back to another
// provider.
import type { LineupStore } from '../lineup/store/types';
import type { Fetcher, FetchResponse } from '../lineup/types';

export const BRAVE_MONTHLY_CAP = 200;
export const BRAVE_SETTING = 'brave_monthly';
const BRAVE_HOST = 'api.search.brave.com';

export interface BraveCount {
  month: string; // YYYY-MM (UTC)
  used: number;
}

export const monthOf = (now: Date) => now.toISOString().slice(0, 7);

export async function braveUsed(store: Pick<LineupStore, 'getSetting'>, now: Date): Promise<number> {
  const c = await store.getSetting<BraveCount>(BRAVE_SETTING);
  return c && c.month === monthOf(now) ? c.used : 0;
}

// Takes `n` Brave queries from this month's allowance. False (and nothing taken) when it would pass the cap.
export async function takeBrave(store: Pick<LineupStore, 'getSetting' | 'putSetting'>, now: Date, n = 1): Promise<boolean> {
  const used = await braveUsed(store, now);
  if (used + n > BRAVE_MONTHLY_CAP) return false;
  await store.putSetting<BraveCount>(BRAVE_SETTING, { month: monthOf(now), used: used + n });
  return true;
}

// Seconds from `now` until 00:00 UTC on the 1st of the next month (when the allowance resets).
function secondsUntilNextMonth(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function isBraveUrl(url: string): boolean {
  try {
    return new URL(url).hostname === BRAVE_HOST;
  } catch {
    return false;
  }
}

// Every Brave request takes one query before it leaves. Over the cap: 429 with the reset time, inner not called.
export function braveCapFetcher(
  inner: Fetcher,
  store: Pick<LineupStore, 'getSetting' | 'putSetting'>,
  now: () => Date = () => new Date(),
): Fetcher {
  return {
    async get(url, init) {
      if (!isBraveUrl(url)) return inner.get(url, init);
      const at = now();
      if (!(await takeBrave(store, at))) {
        const response: FetchResponse = {
          url,
          status: 429,
          headers: { 'x-ratelimit-reset': String(secondsUntilNextMonth(at)) },
          body: '',
        };
        return response;
      }
      return inner.get(url, init);
    },
  };
}
