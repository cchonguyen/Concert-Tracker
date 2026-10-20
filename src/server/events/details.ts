import { randomUUID } from 'node:crypto';
import type { Fetcher, SourceType } from '../lineup/types';
import { parseJson } from '../lineup/http';
import { InputError } from '../lineup/pipeline';
import { addDays, decodeEntities, normalizeName } from '../lineup/text';
import { eventWords } from '../lineup/search';
import { findDates } from './parse';
import { matchingEvents } from '../lineup/adapters/ticketmaster';
import { clashfinderAuthQuery, matchEdition, parseEventList } from '../lineup/adapters/clashfinder';
import { DetailCandidate, EventDetails, EVENT_FIELDS, LoggedEvent } from './types';

// Stage 1 research: find and verify an event's date and place from structured
// sources and web search results. No Gemini here, so it never waits on quota
// (REQUIREMENTS.md, principle 8).
// Results are candidates with sources; applying one is decided in code below
// and never overwrites what you typed.

export interface DetailQuery {
  name: string;
  year: number;
  month?: number;
  startDate?: string;
  endDate?: string;
  venue?: string;
  city?: string;
}

export interface DetailFinder {
  id: SourceType;
  enabled(): boolean;
  find(q: DetailQuery, fetcher: Fetcher): Promise<DetailCandidate[]>;
}

const MAX_CANDIDATES = 5;

export function searchWindow(q: DetailQuery): { from: string; to: string } {
  if (q.startDate) return { from: addDays(q.startDate, -1), to: addDays(q.endDate ?? q.startDate, 1) };
  if (q.month) {
    const mm = String(q.month).padStart(2, '0');
    const last = new Date(Date.UTC(q.year, q.month, 0)).getUTCDate();
    return { from: `${q.year}-${mm}-01`, to: `${q.year}-${mm}-${last}` };
  }
  return { from: `${q.year}-01-01`, to: `${q.year}-12-31` };
}

const inWindow = (date: string | undefined, w: { from: string; to: string }) => Boolean(date && date >= w.from && date <= w.to);

function candidate(
  sourceType: SourceType,
  sourceUrl: string,
  facts: Omit<DetailCandidate, 'id' | 'sources'>,
): DetailCandidate {
  const clean = Object.fromEntries(Object.entries(facts).filter(([, v]) => typeof v === 'string' && v.trim())) as Omit<
    DetailCandidate,
    'id' | 'sources'
  >;
  const fields = EVENT_FIELDS.filter((f) => clean[f]);
  return { id: randomUUID(), ...clean, sources: [{ sourceType, sourceUrl, fields }] };
}

// Ticketmaster Discovery: listings for upcoming and recent events.
export const ticketmasterFinder: DetailFinder = {
  id: 'ticketmaster',
  enabled: () => Boolean(process.env.TICKETMASTER_API_KEY),
  async find(q, fetcher) {
    const w = searchWindow(q);
    const params = new URLSearchParams({
      apikey: process.env.TICKETMASTER_API_KEY!,
      keyword: q.name,
      startDateTime: `${w.from}T00:00:00Z`,
      endDateTime: `${w.to}T23:59:59Z`,
      classificationName: 'music',
      size: '50',
    });
    const data = parseJson<any>(await fetcher.get(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`));
    // A festival is listed once per day or ticket type: group by name and venue.
    const groups = new Map<string, any[]>();
    for (const e of matchingEvents(data?._embedded?.events ?? [], q.name)) {
      const v = e._embedded?.venues?.[0];
      const key = `${normalizeName(e.name)}|${normalizeName(v?.name ?? '')}`;
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    return [...groups.values()].map((events) => {
      const dates = events.map((e) => e.dates?.start?.localDate).filter(Boolean).sort();
      const v = events[0]._embedded?.venues?.[0];
      return candidate('ticketmaster', events[0].url ?? `https://www.ticketmaster.com/event/${events[0].id}`, {
        name: events[0].name,
        startDate: dates[0],
        endDate: dates.length > 1 && dates[dates.length - 1] !== dates[0] ? dates[dates.length - 1] : undefined,
        venue: v?.name,
        city: v?.city?.name,
        country: v?.country?.name,
      });
    });
  },
};

// setlist.fm: past shows of an artist, for events named after the artist.
export const setlistfmFinder: DetailFinder = {
  id: 'setlistfm',
  enabled: () => Boolean(process.env.SETLISTFM_API_KEY),
  async find(q, fetcher) {
    const params = new URLSearchParams({ artistName: q.name, p: '1' });
    if (q.startDate && !q.endDate) {
      const [y, m, d] = q.startDate.split('-');
      params.set('date', `${d}-${m}-${y}`);
    } else {
      params.set('year', String(q.year));
    }
    const res = await fetcher.get(`https://api.setlist.fm/rest/1.0/search/setlists?${params}`, {
      headers: { 'x-api-key': process.env.SETLISTFM_API_KEY!, Accept: 'application/json' },
    });
    if (res.status === 404) return []; // setlist.fm answers 404 when nothing matches
    const w = searchWindow(q);
    const wanted = normalizeName(q.name);
    return (parseJson<any>(res)?.setlist ?? [])
      .filter((s: any) => normalizeName(s.artist?.name ?? '') === wanted)
      .map((s: any) => {
        const [d, m, y] = String(s.eventDate ?? '').split('-');
        return candidate('setlistfm', s.url ?? 'https://www.setlist.fm', {
          name: s.artist?.name,
          startDate: y ? `${y}-${m}-${d}` : undefined,
          venue: s.venue?.name,
          city: s.venue?.city?.name,
          country: s.venue?.city?.country?.name,
        });
      })
      .filter((c: DetailCandidate) => inWindow(c.startDate, w));
  },
};

// Clashfinder: festival editions and their start dates.
export const clashfinderFinder: DetailFinder = {
  id: 'clashfinder',
  enabled: () => clashfinderAuthQuery() !== null,
  async find(q, fetcher) {
    const res = await fetcher.get(`https://clashfinder.com/data/events/all.json?${clashfinderAuthQuery()}`);
    if (res.status !== 200) return [];
    const match = matchEdition(parseEventList(parseJson(res)), q.name, q.year);
    if (!match) return [];
    const c = candidate('clashfinder', `https://clashfinder.com/s/${match.slug}/`, { name: match.name, startDate: match.startDate });
    return !q.month && !q.startDate ? [c] : inWindow(c.startDate, searchWindow(q)) ? [c] : [];
  },
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function webQuery(q: DetailQuery): string {
  const when = q.startDate
    ? `${MONTH_NAMES[Number(q.startDate.slice(5, 7)) - 1]} ${Number(q.startDate.slice(8))} ${q.year}`
    : q.month
      ? `${MONTH_NAMES[q.month - 1]} ${q.year}`
      : String(q.year);
  return [`"${q.name}"`, when, q.venue, q.city].filter(Boolean).join(' ');
}

const stripTags = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Brave web search: the dates search results give for the event. A result
// counts only if its own title and description name every word of the event,
// and a date counts only if it is written there in full and falls in the
// window; the words it was read from are kept as the quote. Pages agreeing
// on a date merge into one candidate with several sources.
export const braveFinder: DetailFinder = {
  id: 'discovered',
  enabled: () => Boolean(process.env.BRAVE_SEARCH_API_KEY),
  async find(q, fetcher) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(webQuery(q))}&count=10`;
    const res = await fetcher.get(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY! },
    });
    if (res.status === 429) throw new Error('Brave Search limit reached; look again later.');
    const results: Array<{ url?: string; title?: string; description?: string }> = parseJson<any>(res)?.web?.results ?? [];
    const words = eventWords(q.name);
    const w = searchWindow(q);
    const out: DetailCandidate[] = [];
    for (const r of results) {
      if (!r.url) continue;
      const text = stripTags(`${r.title ?? ''}. ${r.description ?? ''}`);
      const norm = ` ${normalizeName(text)} `;
      if (!words.length || !words.every((word) => norm.includes(` ${word} `))) continue;
      const seen = new Set<string>();
      for (const d of findDates(text)) {
        if (!inWindow(d.startDate, w) || seen.has(d.startDate)) continue;
        seen.add(d.startDate);
        const c = candidate('discovered', r.url, { startDate: d.startDate, endDate: d.endDate });
        c.sources[0].quote = d.quote;
        out.push(c);
      }
    }
    return out;
  },
};

export function defaultFinders(): DetailFinder[] {
  return [ticketmasterFinder, setlistfmFinder, clashfinderFinder, braveFinder];
}

// Candidates on the same start date describe the same occurrence: combine
// them, keeping each source and the fields it gave.
export function mergeCandidates(all: DetailCandidate[]): DetailCandidate[] {
  const out: DetailCandidate[] = [];
  for (const c of all) {
    const same = c.startDate ? out.find((o) => o.startDate === c.startDate) : undefined;
    if (!same) {
      out.push({ ...c, sources: [...c.sources] });
      continue;
    }
    for (const f of ['name', ...EVENT_FIELDS] as const) if (!same[f] && c[f]) same[f] = c[f];
    same.sources.push(...c.sources);
  }
  return out;
}

const covers = (c: DetailCandidate, date: string) => c.startDate === date || Boolean(c.startDate && c.endDate && c.startDate <= date && date <= c.endDate);

// Applies a candidate's fields to an event. Only empty fields are filled
// unless you picked the candidate yourself. The name is always yours.
export function applyCandidate(event: LoggedEvent, c: DetailCandidate, picked: boolean): LoggedEvent {
  const next: LoggedEvent = { ...event, sources: { ...event.sources } };
  for (const field of EVENT_FIELDS) {
    const value = c[field];
    if (!value || (!picked && next[field])) continue;
    const src = c.sources.find((s) => s.fields.includes(field));
    next[field] = value;
    next.sources[field] = { sourceType: src?.sourceType ?? 'user', sourceUrl: src?.sourceUrl };
  }
  // A full date was confirmed, so the year and month hints follow it.
  if (next.startDate) {
    next.year = Number(next.startDate.slice(0, 4));
    next.month = undefined;
  }
  return next;
}

// Runs every configured finder and decides what to do with the results.
export async function researchEvent(
  event: LoggedEvent,
  finders: DetailFinder[],
  fetcher: Fetcher,
  now: Date,
): Promise<LoggedEvent> {
  const checkedAt = now.toISOString();
  const year = event.year ?? (event.startDate ? Number(event.startDate.slice(0, 4)) : undefined);
  const done = (details: Omit<EventDetails, 'checkedAt'>, ev: LoggedEvent = event): LoggedEvent => ({
    ...ev,
    details: { ...details, checkedAt },
    updatedAt: checkedAt,
  });
  if (!year) return done({ status: 'needs_date', candidates: [], notes: ['Add when it was (a year is enough) to look it up.'] });
  const enabled = finders.filter((f) => f.enabled());
  if (!enabled.length) return done({ status: 'off', candidates: [], notes: ['No event source is configured.'] });

  const q: DetailQuery = {
    name: event.name,
    year,
    month: event.month,
    startDate: event.startDate,
    endDate: event.endDate,
    venue: event.venue,
    city: event.city,
  };
  const notes: string[] = [];
  const found: DetailCandidate[] = [];
  const settled = await Promise.allSettled(enabled.map((f) => f.find(q, fetcher)));
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      found.push(...r.value);
      notes.push(`${enabled[i].id}: ${r.value.length} match(es).`);
    } else {
      notes.push(`${enabled[i].id} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  });

  const merged = mergeCandidates(found).sort(
    (a, b) => b.sources.length - a.sources.length || (a.startDate ?? '9999').localeCompare(b.startDate ?? '9999'),
  );
  if (!merged.length) return done({ status: 'none', candidates: [], notes });

  // Your date is verified when a source covers it; that source (the best
  // supported, if several) fills empty fields on its own.
  if (event.startDate) {
    const hits = merged.filter((c) => covers(c, event.startDate!));
    if (hits.length === 1 || (hits.length > 1 && hits[0].sources.length > hits[1].sources.length)) {
      return done({ status: 'matched', candidates: [hits[0]], notes }, applyCandidate(event, hits[0], false));
    }
  }
  return done({ status: 'choose', candidates: merged.slice(0, MAX_CANDIDATES), notes });
}

export function pickCandidate(event: LoggedEvent, candidateId: string | undefined, now: Date): LoggedEvent {
  const c = candidateId ? event.details.candidates.find((x) => x.id === candidateId) : undefined;
  if (candidateId && !c) throw new InputError('That suggestion is no longer available.');
  const base = c ? applyCandidate(event, c, true) : event;
  return {
    ...base,
    details: { ...event.details, status: 'resolved', candidates: c ? [c] : [] },
    updatedAt: now.toISOString(),
  };
}

