import { randomUUID } from 'node:crypto';
import type { Fetcher } from '../lineup/types';
import { QuotaExhaustedError } from '../lineup/quota';
import type { GuardedReader } from '../reader/guardedReader';
import { domainOf, htmlToText, isVerbatim, normalizeName } from '../lineup/text';
import { eventWords } from '../lineup/search';
import { findDates } from './parse';
import { braveFinder, braveResults, DetailQuery, DetailReader, searchWindow } from './details';
import { DetailCandidate, EventField } from './types';

// "Look again with Gemini": stage 1 research that you asked to spend Gemini
// calls on. Gemini reads whole pages the search found, where a result's two
// lines rarely give the place. It is still only a reader:
// - every value must be written on the page, inside a quote that is on the page;
// - the date is read in code from the quote (findDates), never taken from Gemini;
// - a page counts only when it names the event (and its year, when known).
// Results are candidates like any other: they never overwrite what you typed.
// Out of quota, it stops and says so; what other sources found still shows.

export const MAX_GEMINI_PAGES = 3;

const isAxs = (url: string) => /(^|\.)axs\.com$/.test(domainOf(url));

function namesEvent(text: string, q: DetailQuery): boolean {
  const page = ` ${normalizeName(text)} `;
  const words = eventWords(q.name);
  return words.length > 0 && words.every((w) => page.includes(` ${w} `)) && (!q.year || page.includes(String(q.year)));
}

// Calls go through the guarded reader (feature details_extract, one job per
// event per day, one call per page read, at most MAX_GEMINI_PAGES a press).
// Guard blocks and quota errors stop the press the same way: no fallback.
export function geminiReader(reader: GuardedReader, eventId: string, now: () => Date): DetailReader {
  const jobKey = () => `details:${eventId}:${now().toISOString().slice(0, 10)}`;
  return {
    async read(q, urls, fetcher: Fetcher, notes) {
      let pages = urls;
      if (braveFinder.enabled()) {
        try {
          pages = [...new Set([...urls, ...(await braveResults(q, fetcher)).map((r) => r.url)])];
        } catch (err) {
          notes.push(`gemini: web search failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      pages = pages.filter((u) => !isAxs(u)); // AXS is never scraped
      if (!pages.length) {
        notes.push('gemini: no web page to read (web search finds the pages; is BRAVE_SEARCH_API_KEY set?).');
        return [];
      }
      const out: DetailCandidate[] = [];
      let read = 0;
      for (const url of pages) {
        if (read >= MAX_GEMINI_PAGES) break;
        let text: string;
        try {
          const res = await fetcher.get(url, { headers: { Accept: 'text/html' }, timeoutMs: 15000 });
          if (res.status !== 200) continue;
          text = htmlToText(res.body);
        } catch {
          continue; // an unreachable page just gives nothing
        }
        if (!namesEvent(text, q)) continue;
        read += 1;
        let got;
        try {
          const res = await reader.extractEventDetails(
            { text, eventName: q.name, year: q.year },
            { feature: 'details_extract', jobKey: jobKey(), eventId },
          );
          if (!res.ok) {
            notes.push(`gemini: skipped ${url}, ${res.reason === 'input_too_large' ? 'the page is too large to read' : 'the reader gave an unusable answer'}.`);
            continue;
          }
          got = res.value;
        } catch (err) {
          if (!(err instanceof QuotaExhaustedError)) throw err;
          notes.push(`gemini: stopped, ${err.reason}`);
          break;
        }
        const c = checkedCandidate(q, url, text, got);
        notes.push(`gemini: read ${url}${c ? `: ${c.sources[0].fields.join(', ')}` : ', nothing found on the page'}.`);
        if (c) out.push(c);
      }
      if (!read) notes.push('gemini: none of the pages found named this event; no Gemini call made.');
      return out;
    },
  };
}

// Keeps only what the page itself says. Exported for tests.
export function checkedCandidate(
  q: DetailQuery,
  url: string,
  pageText: string,
  got: { dateQuote?: string; venue?: string; city?: string; country?: string; placeQuote?: string },
): DetailCandidate | null {
  const page = normalizeName(pageText);
  const onPage = (quote?: string) => typeof quote === 'string' && Boolean(quote.trim()) && isVerbatim(quote, quote, page);
  if (!onPage(got.dateQuote)) return null;
  const w = searchWindow(q);
  const date = findDates(got.dateQuote!).find((d) => d.startDate >= w.from && d.startDate <= w.to);
  if (!date) return null; // a page without the event's date can't be placed among the others
  const c: DetailCandidate = { id: randomUUID(), startDate: date.startDate, endDate: date.endDate, sources: [] };
  const fields: EventField[] = date.endDate ? ['startDate', 'endDate'] : ['startDate'];
  const quotes = [date.quote];
  if (onPage(got.placeQuote)) {
    for (const f of ['venue', 'city', 'country'] as const) {
      const v = typeof got[f] === 'string' ? got[f]!.trim() : '';
      if (v && isVerbatim(v, got.placeQuote!, page)) {
        c[f] = v;
        fields.push(f);
      }
    }
    if (fields.length > (date.endDate ? 2 : 1)) quotes.push(got.placeQuote!.trim());
  }
  c.sources.push({ sourceType: 'discovered', sourceUrl: url, fields, quote: quotes.join(' … '), readBy: 'gemini' });
  return c;
}
