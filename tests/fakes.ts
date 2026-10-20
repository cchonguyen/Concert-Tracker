import { Fetcher, FetchResponse } from '../src/server/lineup/types.ts';

// Fetcher that answers from a URL-prefix table and records every request.
export function fakeFetcher(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: string[] = [];
  const fetcher: Fetcher = {
    async get(url: string): Promise<FetchResponse> {
      calls.push(url);
      const hit = Object.keys(routes)
        .sort((a, b) => b.length - a.length)
        .find((prefix) => url.startsWith(prefix));
      if (!hit) return { url, status: 404, headers: {}, body: '' };
      const { status = 200, body } = routes[hit];
      return { url, status, headers: {}, body: typeof body === 'string' ? body : JSON.stringify(body) };
    },
  };
  return { fetcher, calls };
}
