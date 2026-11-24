import { randomUUID } from 'node:crypto';
import type { EditionWeekend, Fetcher } from '../lineup/types';
import { QuotaExhaustedError } from '../lineup/quota';
import type { GuardedReader } from '../reader/guardedReader';
import { domainOf, htmlToText, isVerbatim, normalizeName } from '../lineup/text';
import { eventWords } from '../lineup/search';
import { findDates } from './parse';
import { applyCandidate, braveFinder, braveResults, DetailQuery, DetailReader, mergeCandidates, searchWindow } from './details';
import { DetailCandidate, EventField, LoggedEvent } from './types';

// "Deep search with AI": stage 1 research that you asked to spend Gemini
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
          pages = [...new Set([...urls, ...(await braveResults(q, fetcher, 'stage1_gemini')).map((r) => r.url)])];
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
      if (!read) notes.push('gemini: none of the pages found named this event, so nothing was sent to the AI.');
      return out;
    },
  };
}

// Rung 4: the reader without a button press, after the save, in its own queue message per page.
// - Runs only when the event has a full date and venue or city is still empty (rung4Wanted).
// - At most RUNG4_MAX_PAGES pages (rung4Urls), taken from the pages rung 3 already found; no new search here.
// - One message reads one page: it must be under RUNG4_MAX_CHARS characters, else it is skipped (never cut up).
// - A candidate fills only empty fields, and only when its date is the full date you gave (covers).
// - A guard block or quota error parks the work: a note, nothing else. No retry, no other model, no heuristics.
export const RUNG4_MAX_PAGES = 2;
export const RUNG4_MAX_CHARS = 30000;

const dayCovered = (c: DetailCandidate, date: string) =>
  c.startDate === date || Boolean(c.startDate && c.endDate && c.startDate <= date && date <= c.endDate);

export function rung4Wanted(event: LoggedEvent): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(event.startDate ?? '') && (!event.venue || !event.city);
}

// The pages (at most RUNG4_MAX_PAGES) whose date already matched the full date you gave.
export function rung4Urls(event: LoggedEvent): string[] {
  if (!rung4Wanted(event)) return [];
  const urls = event.details.candidates
    .filter((c) => dayCovered(c, event.startDate!))
    .flatMap((c) => c.sources.filter((s) => s.sourceType === 'discovered' && s.sourceUrl).map((s) => s.sourceUrl!))
    .filter((u) => !isAxs(u));
  return [...new Set(urls)].slice(0, RUNG4_MAX_PAGES);
}

export type Rung4Outcome = 'skipped' | 'applied' | 'nothing' | 'parked';

// One rung 4 message: reads one page for one event. Never throws for quota or guard stops.
export async function runReaderPage(
  store: { getEvent(id: string): Promise<LoggedEvent | null>; putEvent(event: LoggedEvent): Promise<void> },
  reader: GuardedReader,
  eventId: string,
  url: string,
  fetcher: Fetcher,
  now: Date,
): Promise<Rung4Outcome> {
  const event = await store.getEvent(eventId);
  if (!event || !rung4Wanted(event) || isAxs(url)) return 'skipped';
  const notes: string[] = [];
  let outcome: Rung4Outcome = 'nothing';
  const year = event.year ?? Number(event.startDate!.slice(0, 4));
  const q: DetailQuery = { name: event.name, year, startDate: event.startDate, endDate: event.endDate };
  let candidate: DetailCandidate | null = null;
  let text: string | null = null;
  try {
    const res = await fetcher.get(url, { headers: { Accept: 'text/html' }, timeoutMs: 15000 });
    if (res.status === 200) text = htmlToText(res.body);
  } catch {
    // An unreachable page gives nothing.
  }
  if (text === null) notes.push(`gemini (auto): could not fetch ${url}.`);
  else if (text.length >= RUNG4_MAX_CHARS) notes.push(`gemini (auto): skipped ${url}, the page is 30,000 characters or more.`);
  else if (!namesEvent(text, q)) notes.push(`gemini (auto): ${url} does not name this event, so nothing was sent to the AI.`);
  else {
    try {
      const res = await reader.extractEventDetails(
        { text, eventName: event.name, year },
        { feature: 'details_extract', jobKey: `details:${eventId}:${now.toISOString().slice(0, 10)}`, eventId },
      );
      if (!res.ok) {
        outcome = 'parked';
        notes.push(`gemini (auto): stopped, ${res.reason === 'invalid_json' ? 'the reader gave an unusable answer' : (res.reason ?? 'blocked')}.`);
      } else {
        const c = checkedCandidate(q, url, text, res.value ?? {});
        if (c && dayCovered(c, event.startDate!)) candidate = c;
        notes.push(`gemini (auto): read ${url}${candidate ? `: ${candidate.sources[0].fields.join(', ')}` : ', no place for your date on the page'}.`);
      }
    } catch (err) {
      if (!(err instanceof QuotaExhaustedError)) throw err;
      outcome = 'parked';
      notes.push(`gemini (auto): stopped, ${err.reason}`);
    }
  }
  let next: LoggedEvent = event;
  if (candidate) {
    next = applyCandidate(event, candidate, false, ['venue', 'city', 'country']);
    next.details = { ...event.details, candidates: mergeCandidates([...event.details.candidates, candidate]) };
    outcome = next.venue !== event.venue || next.city !== event.city || next.country !== event.country ? 'applied' : 'nothing';
  }
  next = { ...next, details: { ...next.details, notes: [...(next.details.notes ?? []), ...notes] }, updatedAt: now.toISOString() };
  await store.putEvent(next);
  return outcome;
}

const WEEKEND_INDEX_RE = /\b(?:weekend|wknd)\s*([1-9])\b|\bw([1-9])\b/i;

function verifiedWeekends(
  quotes: unknown,
  onPage: (q?: string) => boolean,
  w: { from: string; to: string },
): Array<{ weekend: number; startDate: string; endDate?: string; quote: string }> {
  if (!Array.isArray(quotes) || !quotes.length) return [];
  const rawEntries: Array<{ explicit?: number; startDate: string; endDate?: string; quote: string }> = [];
  const seenDates = new Set<string>();
  for (const item of quotes) {
    if (!onPage(item)) continue;
    const trimmed = (item as string).trim();
    const date = findDates(trimmed).find((d) => d.startDate >= w.from && d.startDate <= w.to);
    if (!date || seenDates.has(date.startDate)) continue;
    seenDates.add(date.startDate);
    const wm = trimmed.match(WEEKEND_INDEX_RE);
    const explicit = wm ? Number(wm[1] ?? wm[2]) : undefined;
    rawEntries.push({ explicit, startDate: date.startDate, endDate: date.endDate, quote: trimmed });
  }
  if (rawEntries.length < 2) return [];
  rawEntries.sort((a, b) => a.startDate.localeCompare(b.startDate));

  const usedWeekends = new Set<number>();
  const assigned: Array<{ weekend: number; startDate: string; endDate?: string; quote: string }> = [];
  const implicit: typeof rawEntries = [];
  for (const entry of rawEntries) {
    if (entry.explicit !== undefined) {
      if (usedWeekends.has(entry.explicit)) continue;
      usedWeekends.add(entry.explicit);
      assigned.push({ weekend: entry.explicit, startDate: entry.startDate, endDate: entry.endDate, quote: entry.quote });
    } else {
      implicit.push(entry);
    }
  }
  let nextSeq = 1;
  for (const entry of implicit) {
    while (usedWeekends.has(nextSeq)) nextSeq++;
    usedWeekends.add(nextSeq);
    assigned.push({ weekend: nextSeq, startDate: entry.startDate, endDate: entry.endDate, quote: entry.quote });
    nextSeq++;
  }
  assigned.sort((a, b) => a.weekend - b.weekend);
  return assigned;
}

// Keeps only what the page itself says. Exported for tests.
export function checkedCandidate(
  q: DetailQuery,
  url: string,
  pageText: string,
  got: { dateQuote?: string; weekendQuotes?: string[]; venue?: string; city?: string; country?: string; placeQuote?: string },
): DetailCandidate | null {
  const page = normalizeName(pageText);
  const onPage = (quote?: string) => typeof quote === 'string' && Boolean(quote.trim()) && isVerbatim(quote, quote, page);
  const w = searchWindow(q);

  const weekendHits = verifiedWeekends(got.weekendQuotes, onPage, w);
  let startDate: string;
  let endDate: string | undefined;
  let weekends: EditionWeekend[] | undefined;
  const quotes: string[] = [];

  if (weekendHits.length >= 2) {
    startDate = weekendHits.reduce((min, x) => (x.startDate < min ? x.startDate : min), weekendHits[0].startDate);
    const maxEnd = weekendHits.reduce((max, x) => {
      const end = x.endDate ?? x.startDate;
      return end > max ? end : max;
    }, startDate);
    endDate = maxEnd !== startDate ? maxEnd : undefined;
    weekends = weekendHits.map((x) => ({
      weekend: x.weekend,
      startDate: x.startDate,
      ...(x.endDate && x.endDate !== x.startDate ? { endDate: x.endDate } : {}),
    }));
    quotes.push(...weekendHits.map((x) => x.quote));
  } else {
    if (!onPage(got.dateQuote)) return null;
    const date = findDates(got.dateQuote!).find((d) => d.startDate >= w.from && d.startDate <= w.to);
    if (!date) return null; // a page without the event's date can't be placed among the others
    startDate = date.startDate;
    endDate = date.endDate;
    quotes.push(date.quote);
  }

  const c: DetailCandidate = {
    id: randomUUID(),
    startDate,
    endDate,
    ...(weekends ? { weekends } : {}),
    sources: [],
  };
  const fields: EventField[] = endDate ? ['startDate', 'endDate'] : ['startDate'];
  if (onPage(got.placeQuote)) {
    for (const f of ['venue', 'city', 'country'] as const) {
      const v = typeof got[f] === 'string' ? got[f]!.trim() : '';
      if (v && isVerbatim(v, got.placeQuote!, page)) {
        c[f] = v;
        fields.push(f);
      }
    }
    if (fields.length > (endDate ? 2 : 1)) quotes.push(got.placeQuote!.trim());
  }
  c.sources.push({ sourceType: 'discovered', sourceUrl: url, fields, quote: quotes.join(' … '), readBy: 'gemini' });
  return c;
}
