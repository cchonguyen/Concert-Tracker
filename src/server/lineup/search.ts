import { Fetcher, LookupInput } from './types';
import { GeminiClient } from './gemini';
import { HttpError, parseJson } from './http';
import { QuotaExhaustedError } from './quota';
import { normalizeName } from './text';

// Web search used only when every source came back empty. It returns
// candidate URLs; the pipeline fetches each page, keeps it only if the page
// itself names the event and the year, and sends it to extraction, where every
// name must be quoted verbatim from the page. Search snippets are never used
// as evidence.

export interface LineupSearch {
  readonly id: 'brave' | 'gemini';
  // Grounded Gemini search spends the Gemini budget; other providers do not.
  readonly usesGeminiQuota: boolean;
  findLineupUrls(input: LookupInput): Promise<string[]>;
}

export function eventWords(eventName: string): string[] {
  return normalizeName(eventName.replace(/\b(19|20)\d{2}\b/g, ' ')).split(' ').filter(Boolean);
}

export function searchQuery(input: LookupInput): string {
  const name = input.eventName.replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
  const where = input.city ? ` ${input.city}` : '';
  return `"${name}" ${input.year}${where} lineup`;
}

// A fetched page counts only if it names the event and the year. This keeps
// out pages about another edition or another event that a search matched.
export function pageMentionsEvent(text: string, input: LookupInput): boolean {
  const page = ` ${normalizeName(text)} `;
  return page.includes(String(input.year)) && eventWords(input.eventName).every((w) => page.includes(` ${w} `));
}

interface BraveResponse {
  web?: { results?: Array<{ url?: string }> };
}

// Brave Search API (https://brave.com/search/api/). Free plan; the key goes in
// BRAVE_SEARCH_API_KEY. A 429 parks the job until the reset Brave reports.
export function braveSearch(fetcher: Fetcher, apiKey: string, now: () => Date = () => new Date()): LineupSearch {
  return {
    id: 'brave',
    usesGeminiQuota: false,
    async findLineupUrls(input) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(searchQuery(input))}&count=10`;
      const res = await fetcher.get(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey } });
      if (res.status === 429) {
        // "x-ratelimit-reset" lists seconds until each window resets (per second, per month).
        const resets = (res.headers['x-ratelimit-reset'] ?? '').split(',').map((v) => Number(v.trim())).filter((v) => v > 0);
        const seconds = resets.length ? Math.max(...resets) : 3600;
        throw new QuotaExhaustedError(new Date(now().getTime() + (seconds + 1) * 1000), `Brave Search limit reached; retrying in ${Math.ceil(seconds / 60)} min.`);
      }
      if (res.status === 401 || res.status === 403) throw new HttpError(res.status, url, `Brave Search rejected the key (HTTP ${res.status}). Check BRAVE_SEARCH_API_KEY.`);
      const data = parseJson<BraveResponse>(res);
      const urls = (data.web?.results ?? []).map((r) => r.url).filter((u): u is string => typeof u === 'string');
      return [...new Set(urls)];
    },
  };
}

export function geminiSearch(gemini: GeminiClient): LineupSearch {
  return { id: 'gemini', usesGeminiQuota: true, findLineupUrls: (input) => gemini.discoverLineupUrls(input) };
}
