import type { Fetcher, FetchResponse } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';

// Slice 4.3: a host that answered 403 to the Worker in the last 30 days is skipped before a fetch is spent on it.
// The list is learned from responses and kept in app_settings (never typed in by hand). It is read at the start of a
// research run and saved at its end, so a host refused once is not asked again for a month.
export const REFUSED_SETTING = 'refused_hosts';
export const REFUSAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type RefusalMap = Record<string, string>; // host -> ISO time of its last 403

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

// The hosts still inside the window. Older entries are dropped, so the setting does not grow forever.
export function activeRefusals(map: RefusalMap | null | undefined, now: Date): RefusalMap {
  const out: RefusalMap = {};
  for (const [host, at] of Object.entries(map ?? {})) {
    const t = Date.parse(at);
    if (Number.isFinite(t) && now.getTime() - t < REFUSAL_WINDOW_MS) out[host] = at;
  }
  return out;
}

// Wraps a fetcher: a refused host is answered 403 without a request, and a new 403 is recorded in `refusals`.
// Finders treat any non-200 as no page, so they need no change.
export function refusalFetcher(inner: Fetcher, refusals: RefusalMap, now: Date): Fetcher {
  return {
    async get(url, opts): Promise<FetchResponse> {
      const host = hostOf(url);
      if (host && refusals[host]) return { url, status: 403, headers: {}, body: '' };
      const res = await inner.get(url, opts);
      if (host && res.status === 403) refusals[host] = now.toISOString();
      return res;
    },
  };
}

export async function loadRefusals(store: Pick<LineupStore, 'getSetting'>, now: Date): Promise<RefusalMap> {
  return activeRefusals(await store.getSetting<RefusalMap>(REFUSED_SETTING), now);
}

// Saves only when something new was learned, so an idle run writes nothing.
export async function saveRefusals(store: Pick<LineupStore, 'putSetting'>, before: RefusalMap, after: RefusalMap, now: Date): Promise<void> {
  const next = activeRefusals(after, now);
  if (JSON.stringify(next) === JSON.stringify(activeRefusals(before, now))) return;
  await store.putSetting<RefusalMap>(REFUSED_SETTING, next);
}
