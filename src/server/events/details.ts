import { randomUUID } from 'node:crypto';
import type { Fetcher, SourceType } from '../lineup/types';
import { createRateLimitedFetcher, parseJson } from '../lineup/http';
import { InputError } from '../lineup/pipeline';
import { addDays, decodeEntities, domainOf, normalizeName } from '../lineup/text';
import { eventWords } from '../lineup/search';
import { findDates, parseEventInput } from './parse';
import { matchingEvents } from '../lineup/adapters/ticketmaster';
import { clashfinderAuthQuery, matchEdition, parseEventList } from '../lineup/adapters/clashfinder';
import { cityLabel, placeFromPage } from './place';
import { cityWithRegion, splitEventCity } from './regions';
import type { Edition } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';
import { seriesSlugFor } from '../lineup/text';
import { matchEdition as matchCatalog, upsertOccurrence } from '../canon/match';
import type { GuardedReader } from '../reader/guardedReader';
import { geminiReader } from './detailsGemini';
import { DetailCandidate, DetailsStatus, EventDetails, EventField, EVENT_FIELDS, LoggedEvent } from './types';

// Stage 1 research: find and verify an event's date and place from structured
// sources and web search results. No Gemini here unless you ask for it with
// "Look again with Gemini" (a DetailReader, events/detailsGemini.ts), so it
// never waits on quota (REQUIREMENTS.md, principle 8).
// Results are candidates with sources; applying one is decided in code below
// and never overwrites what you typed.

export interface DetailQuery {
  name: string;
  // Missing when you don't know when it was; only finders that can search
  // without a year (withoutYear) run then, and their dates are suggestions.
  year?: number;
  month?: number;
  startDate?: string;
  endDate?: string;
  venue?: string;
  city?: string;
}

export interface DetailFinder {
  id: SourceType;
  enabled(): boolean;
  withoutYear?: boolean;
  find(q: DetailQuery, fetcher: Fetcher): Promise<DetailCandidate[]>;
}

const MAX_CANDIDATES = 5;

export function searchWindow(q: DetailQuery): { from: string; to: string } {
  if (!q.year && !q.startDate) return { from: '1950-01-01', to: '2100-12-31' };
  if (q.startDate) return { from: addDays(q.startDate, -1), to: addDays(q.endDate ?? q.startDate, 1) };
  if (q.month && q.year) {
    const mm = String(q.month).padStart(2, '0');
    const last = new Date(Date.UTC(q.year, q.month, 0)).getUTCDate();
    return { from: `${q.year}-${mm}-01`, to: `${q.year}-${mm}-${last}` };
  }
  return { from: `${q.year}-01-01`, to: `${q.year}-12-31` };
}

// Without a year, a web result must also name the place you gave, so an
// artist's other shows don't crowd out the one you went to.
function placeWords(q: DetailQuery): string[] {
  if (q.year) return [];
  return eventWords(q.venue ?? q.city?.split(',')[0] ?? '');
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
      const url = events[0].url ?? `https://www.ticketmaster.com/event/${events[0].id}`;
      const names = [...new Set<string>(events.flatMap((e) => (e._embedded?.attractions ?? []).map((a: any) => String(a.name ?? '').trim())))];
      const c = candidate('ticketmaster', url, {
        name: events[0].name,
        startDate: dates[0],
        endDate: dates.length > 1 && dates[dates.length - 1] !== dates[0] ? dates[dates.length - 1] : undefined,
        venue: v?.name,
        city: cityLabel(v?.city?.name, v?.state?.stateCode, v?.country?.countryCode),
        country: v?.country?.name,
      });
      const performers = names.filter(Boolean).map((name) => ({ name, sourceType: 'ticketmaster' as const, sourceUrl: url }));
      return performers.length ? { ...c, performers } : c;
    });
  },
};

// setlist.fm: past shows of an artist, for events named after the artist.
export const setlistfmFinder: DetailFinder = {
  id: 'setlistfm',
  enabled: () => Boolean(process.env.SETLISTFM_API_KEY),
  withoutYear: true,
  async find(q, fetcher) {
    const params = new URLSearchParams({ artistName: q.name, p: '1' });
    if (q.startDate && !q.endDate) {
      const [y, m, d] = q.startDate.split('-');
      params.set('date', `${d}-${m}-${y}`);
    } else if (q.year) {
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
        const url = s.url ?? 'https://www.setlist.fm';
        const c = candidate('setlistfm', url, {
          name: s.artist?.name,
          startDate: y ? `${y}-${m}-${d}` : undefined,
          venue: s.venue?.name,
          city: cityLabel(s.venue?.city?.name, s.venue?.city?.stateCode, s.venue?.city?.country?.code),
          country: s.venue?.city?.country?.name,
        });
        return { ...c, performers: [{ name: String(s.artist.name), sourceType: 'setlistfm' as const, sourceUrl: url }] };
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
    const match = matchEdition(parseEventList(parseJson(res)), q.name, q.year!, q.startDate);
    if (!match) return [];
    const c = candidate('clashfinder', `https://clashfinder.com/s/${match.slug}/`, { name: match.name, startDate: match.startDate });
    return !q.month && !q.startDate ? [c] : inWindow(c.startDate, searchWindow(q)) ? [c] : [];
  },
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function webQuery(q: DetailQuery): string {
  const when = q.startDate
    ? `${MONTH_NAMES[Number(q.startDate.slice(5, 7)) - 1]} ${Number(q.startDate.slice(8))} ${q.year}`
    : q.month && q.year
      ? `${MONTH_NAMES[q.month - 1]} ${q.year}`
      : q.year
        ? String(q.year)
        : undefined;
  return [`"${q.name}"`, when, q.venue, q.city].filter(Boolean).join(' ');
}

const stripTags = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Brave web search: the dates search results give for the event. A result
// counts only if its own title and description name every word of the event,
// and a date counts only if it is written there in full and falls in the
// window; the words it was read from are kept as the quote. Pages agreeing
// on a date merge into one candidate with several sources.
// The Brave results whose own title and description name every word of the
// event (and, without a year, the place you gave).
export async function braveResults(q: DetailQuery, fetcher: Fetcher): Promise<Array<{ url: string; text: string }>> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(webQuery(q))}&count=10`;
  const res = await fetcher.get(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY! },
  });
  if (res.status === 429) throw new Error('Brave Search limit reached; look again later.');
  const results: Array<{ url?: string; title?: string; description?: string }> = parseJson<any>(res)?.web?.results ?? [];
  const words = [...eventWords(q.name), ...placeWords(q)];
  const out: Array<{ url: string; text: string }> = [];
  for (const r of results) {
    if (!r.url) continue;
    const text = stripTags(`${r.title ?? ''}. ${r.description ?? ''}`);
    const norm = ` ${normalizeName(text)} `;
    if (words.length && words.every((word) => norm.includes(` ${word} `))) out.push({ url: r.url, text });
  }
  return out;
}

export const braveFinder: DetailFinder = {
  id: 'discovered',
  enabled: () => Boolean(process.env.BRAVE_SEARCH_API_KEY),
  withoutYear: true,
  async find(q, fetcher) {
    const w = searchWindow(q);
    const out: DetailCandidate[] = [];
    for (const r of await braveResults(q, fetcher)) {
      const text = r.text;
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
    if (c.performers?.length) same.performers = [...(same.performers ?? []), ...c.performers];
  }
  return out;
}

const MAX_PLACE_PAGES = 3;

// Search results give a date but rarely a place. For candidates without a
// venue or city, read the event markup on the pages that gave their date
// (placeFromPage), a few pages at most. A page that answers adds its own
// source with the venue and city as the quote.
export async function addPlaces(candidates: DetailCandidate[], eventName: string, fetcher: Fetcher): Promise<void> {
  let budget = MAX_PLACE_PAGES;
  for (const c of candidates) {
    if ((c.venue && c.city) || !c.startDate) continue;
    const urls = [...new Set(c.sources.filter((s) => s.sourceType === 'discovered' && s.sourceUrl).map((s) => s.sourceUrl!))];
    for (const url of urls) {
      if (budget <= 0) return;
      if (/(^|\.)axs\.com$/.test(domainOf(url))) continue; // AXS is never scraped
      budget--;
      try {
        const res = await fetcher.get(url, { headers: { Accept: 'text/html' }, timeoutMs: 8000 });
        if (res.status !== 200) continue;
        const place = placeFromPage(res.body, eventName, c.startDate, c.endDate);
        if (!place) continue;
        const fields = (['venue', 'city', 'country'] as const).filter((f) => place[f] && !c[f]);
        if (!fields.length) continue;
        for (const f of fields) c[f] = place[f];
        c.sources.push({ sourceType: 'discovered', sourceUrl: url, fields: [...fields], quote: place.quote });
        break;
      } catch {
        // An unreachable page just gives no place.
      }
    }
  }
}

const covers = (c: DetailCandidate, date: string) => c.startDate === date || Boolean(c.startDate && c.endDate && c.startDate <= date && date <= c.endDate);

// Applies a candidate's fields to an event. Only empty fields are filled
// unless you picked the candidate yourself. The name is always yours.
export function applyCandidate(event: LoggedEvent, c: DetailCandidate, picked: boolean, only?: EventField[]): LoggedEvent {
  const next: LoggedEvent = { ...event, sources: { ...event.sources } };
  for (const field of only ?? EVENT_FIELDS) {
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
  // Sources write "Las Vegas, NV"; a city taken from one brings its state.
  return next.city !== event.city ? splitEventCity(next, picked) : next;
}

// Reads whole pages for an event's date and place when you ask for it (Gemini,
// events/detailsGemini.ts). urls: the pages the finders' results came from.
export interface DetailReader {
  read(q: DetailQuery, urls: string[], fetcher: Fetcher, notes: string[]): Promise<DetailCandidate[]>;
}

// The shared catalog (slice 11.16). Optional: callers without it behave exactly as before.
// persist: rung 2 may write dated occurrences to shared editions. It is off unless the caller turns it on
// (owner or system path), because a member's notice for shared editions is not approved yet.
export interface ResearchCatalog {
  store: LineupStore;
  persist?: boolean;
  // persistOwn: the person's own typed name, full date, venue and city may create a `provisional` shared edition
  // (Slice 11.23). On for everyone (member notice version 2); see persistOwnEntry.
  persistOwn?: boolean;
  actor?: string;
}

// Who may write shared editions from research: the owner, or single-user mode (no userId). A member never does
// (the member notice for shared editions is not approved). Rung 1 is read-only and runs for everyone.
export function researchCatalogFor(role: 'owner' | 'member' | undefined, userId: string | undefined, store: LineupStore): ResearchCatalog {
  return { store, persist: !userId || role === 'owner', persistOwn: true, actor: 'system:research' };
}

const catalogDay = (e: Edition, date: string) => e.startDate === date || Boolean(e.startDate && e.endDate && e.startDate <= date && date <= e.endDate);

// Rung 1: a verified catalog edition for this event. External IDs first (at most one lookup, from a source link
// this event already holds), then date + venue + subject (matchEdition). Worst case 3 store calls.
async function catalogHit(event: LoggedEvent, catalog: ResearchCatalog): Promise<Edition | null> {
  const externalIds = Object.values(event.sources)
    .filter((s): s is NonNullable<typeof s> => Boolean(s?.sourceUrl) && (s!.sourceType === 'ticketmaster' || s!.sourceType === 'clashfinder'))
    .slice(0, 1)
    .map((s) => ({ source: s.sourceType, externalId: s.sourceUrl! }));
  if (!externalIds.length && !event.startDate) return null;
  const m = await matchCatalog(catalog.store, {
    name: event.name,
    startDate: event.startDate,
    venue: event.venue,
    city: event.city,
    subjectKey: seriesSlugFor(event.name),
    externalIds,
  });
  if (m.kind !== 'same') return null; // ambiguous or suggested matches are never auto-used
  const e = m.edition;
  if (e.status !== 'verified' && e.status !== 'confirmed') return null;
  if (event.year && e.year !== event.year) return null;
  return e;
}

function editionCandidate(e: Edition): DetailCandidate {
  const facts = { name: e.name, startDate: e.startDate, endDate: e.endDate, venue: e.venue, city: e.city, country: e.country };
  const clean = Object.fromEntries(Object.entries(facts).filter(([, v]) => typeof v === 'string' && v.trim())) as Omit<DetailCandidate, 'id' | 'sources'>;
  // The catalog edition is the source; SourceType has no 'edition', so the stored FieldSource is rewritten by the caller.
  return { id: randomUUID(), ...clean, sources: [{ sourceType: 'promoter', sourceUrl: '', fields: EVENT_FIELDS.filter((f) => clean[f]) }] };
}

// Rung 2 persistence (docs/architecture/08-sources.md, Slice 11.1): only Ticketmaster and Clashfinder results,
// only name, date, venue, city and the source link as external id, as `provisional`. Never setlist.fm, never
// the member's typed values (the data comes from the candidate), never personal fields. At most ONE occurrence
// per message: the first Ticketmaster/Clashfinder candidate covering the event's own date (used only to choose,
// never stored from the event). Worst case 11 store calls: 3 match + venue + key check + 3 write + external id + 2 suggestion.
const PERSISTABLE: SourceType[] = ['ticketmaster', 'clashfinder'];

// Takes the finders' raw candidates (one source each), never merged ones, so a setlist.fm or web value can
// not ride along in a merged candidate.
async function persistOccurrence(event: LoggedEvent, raw: DetailCandidate[], catalog: ResearchCatalog, notes: string[]): Promise<void> {
  if (!catalog.persist || !event.startDate) return;
  const c = raw.find((m) => m.startDate && m.name && covers(m, event.startDate!) && m.sources.length === 1 && PERSISTABLE.includes(m.sources[0].sourceType));
  if (!c) return;
  const src = c.sources[0];
  try {
    const r = await upsertOccurrence(catalog.store, {
      name: c.name!,
      startDate: c.startDate,
      endDate: c.endDate,
      venue: c.venue,
      city: c.city,
      country: c.country,
      subjectKey: seriesSlugFor(c.name!),
      externalIds: src.sourceUrl ? [{ source: src.sourceType, externalId: src.sourceUrl }] : [],
      trust: 'provisional',
      actor: catalog.actor ?? 'system:research',
      reason: `Dated occurrence from ${src.sourceType} during event research`,
    });
    notes.push(`catalog: ${r.action} a shared occurrence from ${src.sourceType}.`);
  } catch (err) {
    notes.push(`catalog write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Slice 11.23: a member's (or the owner's) own entry may create a `provisional` shared edition. Only the typed
// name, a full YYYY-MM-DD start date, venue and city (venue/city only if the person typed them); no external ids,
// no country, no end date, never personal fields. Actor 'member:entry' carries no user id. A provisional source
// only fills empty fields of a matched edition, so it never changes another edition. Runs only inside the
// research queue message, never in save. Worst case 8 store calls: 3 match + venue + key check + 3 write
// (no external ids, no suggestion beyond the 2 queued ones counted in persistOccurrence's 11).
async function persistOwnEntry(event: LoggedEvent, catalog: ResearchCatalog, notes: string[]): Promise<void> {
  if (!catalog.persistOwn || !event.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(event.startDate) || !event.name.trim()) return;
  const typed = (f: 'venue' | 'city') => (event.sources[f]?.sourceType === 'user' ? event[f] : undefined);
  try {
    const r = await upsertOccurrence(catalog.store, {
      name: event.name,
      startDate: event.startDate,
      ...(event.endDate && event.sources.endDate?.sourceType === 'user' ? { endDate: event.endDate } : {}),
      venue: typed('venue'),
      city: typed('city'),
      subjectKey: seriesSlugFor(event.name),
      externalIds: [],
      trust: 'provisional',
      actor: 'member:entry',
      reason: 'Member entry',
    });
    notes.push(`catalog: ${r.action} a provisional shared edition from your entry.`);
  } catch (err) {
    notes.push(`catalog write of your entry failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Runs every configured finder and decides what to do with the results.
export async function researchEvent(
  event: LoggedEvent,
  finders: DetailFinder[],
  fetcher: Fetcher,
  now: Date,
  reader?: DetailReader,
  catalog?: ResearchCatalog,
): Promise<LoggedEvent> {
  const checkedAt = now.toISOString();
  const year = event.year ?? (event.startDate ? Number(event.startDate.slice(0, 4)) : undefined);
  const done = (details: Omit<EventDetails, 'checkedAt'>, ev: LoggedEvent = event): LoggedEvent => ({
    ...ev,
    details: { ...details, checkedAt },
    updatedAt: checkedAt,
  });
  const found: DetailCandidate[] = [];
  const notes: string[] = [];
  let catalogMatched = false;
  if (catalog) {
    try {
      const hit = await catalogHit(event, catalog);
      if (hit) {
        const c = editionCandidate(hit);
        const fromEdition = (ev: LoggedEvent): LoggedEvent => {
          const sources = { ...ev.sources };
          for (const f of EVENT_FIELDS) if (ev[f] !== event[f] && ev[f]) sources[f] = { sourceType: 'edition', editionId: hit.id };
          return { ...ev, sources };
        };
        if (event.startDate && catalogDay(hit, event.startDate)) {
          catalogMatched = true;
          const filled = fromEdition(applyCandidate(event, c, false));
          notes.push('catalog: a verified shared edition matches.');
          if (filled.startDate && filled.venue && filled.city) {
            return done({ status: 'matched', candidates: [c], notes }, filled);
          }
          event = filled; // gaps remain: ask the outside sources for the rest
        } else {
          notes.push('catalog: a verified shared edition was found, but not on the date you gave; not used.');
        }
      }
    } catch (err) {
      notes.push(`catalog lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (catalog && !catalogMatched) await persistOwnEntry(event, catalog, notes);
  const enabled = finders.filter((f) => f.enabled() && (year || f.withoutYear));
  if (!enabled.length && !reader) {
    return year
      ? done({ status: 'off', candidates: [], notes: ['No event source is configured.'] })
      : done({ status: 'needs_date', candidates: [], notes: ['Add when it was (a year is enough) to look it up.'] });
  }

  const q: DetailQuery = {
    name: event.name,
    year,
    month: event.month,
    startDate: event.startDate,
    endDate: event.endDate,
    venue: event.venue,
    city: cityWithRegion(event.city, event.region),
  };
  const search = async (query: DetailQuery) => {
    const settled = await Promise.allSettled(enabled.map((f) => f.find(query, fetcher)));
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        found.push(...r.value);
        notes.push(`${enabled[i].id}: ${r.value.length} match(es) for "${query.name}".`);
      } else {
        notes.push(`${enabled[i].id} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      }
    });
  };
  await search(q);
  // You may have renamed the event after saving it ("Coachella" to
  // "Coachella Weekend 1"); when the new name finds nothing, the name you
  // first typed is tried once.
  const typedName = parseEventInput(event.input ?? '').name;
  if (!found.length && typedName && normalizeName(typedName) !== normalizeName(event.name)) await search({ ...q, name: typedName });
  if (reader) {
    const urls = found.flatMap((c) => c.sources.filter((s) => s.sourceType === 'discovered').map((s) => s.sourceUrl));
    found.push(...(await reader.read(q, [...new Set(urls)], fetcher, notes)));
  }

  if (catalog) await persistOccurrence(event, found, catalog, notes);
  const merged = mergeCandidates(found).sort(
    (a, b) => b.sources.length - a.sources.length || (a.startDate ?? '9999').localeCompare(b.startDate ?? '9999'),
  );
  if (!merged.length) {
    return year
      ? done({ status: 'none', candidates: [], notes })
      : done({ status: 'needs_date', candidates: [], notes: [...notes, 'No dates found; add when it was (a year is enough).'] });
  }

  // Your date is verified when a source covers it; that source (the best
  // supported, if several) fills empty fields on its own.
  if (event.startDate) {
    const hits = merged.filter((c) => covers(c, event.startDate!));
    if (hits.length === 1 || (hits.length > 1 && hits[0].sources.length > hits[1].sources.length)) {
      await addPlaces([hits[0]], event.name, fetcher);
      return done({ status: 'matched', candidates: [hits[0]], notes }, applyCandidate(event, hits[0], false));
    }
  }
  const shown = merged.slice(0, MAX_CANDIDATES);
  await addPlaces(shown, event.name, fetcher);
  return done({ status: 'choose', candidates: shown, notes });
}

// Slice 11.15: the queued research message for a freshly saved event (ladder rungs 1 to 3: structured APIs
// and web search results read in code; never the reader model, which is rung 4).
// It runs only while the event is still waiting ('pending'): "Look again" or Fill gaps may have finished it
// first, and a second run must not overwrite that. Results follow researchEvent's rules (candidates; typed
// fields are never overwritten). Returns the saved event, or null when there was nothing to do.
//
// Worst-case subrequests of one message: 2 store calls (getEvent, putEvent) + finders 4 (Ticketmaster,
// setlist.fm, Clashfinder, Brave) + 4 again when the first name finds nothing and the typed name differs
// + 3 place pages (addPlaces) = 13 without a catalog.
// Slice 11.16 with a catalog: + rung 1 (up to 3 store calls: one external-id lookup, listEditions, venue alias)
// + rung 2 persistence of at most one occurrence (up to 11 store calls, see persistOccurrence) = 27 worst case
// // Slice 11.23 adds persistOwnEntry, at most 8 more store calls (35 worst case).
// (the plan's figure is 26; 1 over, dropping the external-id lookup would meet it). Both are zero when no catalog is passed. The consumer's budget (50) holds.
export async function runQueuedResearch(
  store: { getEvent(id: string): Promise<LoggedEvent | null>; putEvent(event: LoggedEvent): Promise<void> },
  eventId: string,
  finders: DetailFinder[],
  fetcher: Fetcher,
  now: Date,
  catalog?: ResearchCatalog,
): Promise<LoggedEvent | null> {
  const event = await store.getEvent(eventId);
  if (!event || event.details.status !== 'pending') return null;
  const updated = await researchEvent(event, finders, fetcher, now, undefined, catalog);
  await store.putEvent(updated);
  return updated;
}

export function pickCandidate(event: LoggedEvent, candidateId: string | undefined, now: Date, fields?: EventField[]): LoggedEvent {
  const c = candidateId ? event.details.candidates.find((x) => x.id === candidateId) : undefined;
  if (candidateId && !c) throw new InputError('That suggestion is no longer available.');
  // One field you chose to take from a confirmed suggestion ("Use this"):
  // the suggestion stays as it was.
  if (c && fields?.length) {
    if (fields.some((f) => !EVENT_FIELDS.includes(f))) throw new InputError('Unknown field.');
    return { ...applyCandidate(event, c, true, fields), updatedAt: now.toISOString() };
  }
  const base = c ? applyCandidate(event, c, true) : event;
  return {
    ...base,
    details: { ...event.details, status: 'resolved', candidates: c ? [c] : [] },
    updatedAt: now.toISOString(),
  };
}

export interface EditionFactsDetailsInput {
  id: string;
  name: string;
  startDate?: string | null;
  endDate?: string | null;
  venue?: string | null;
  city?: string | null;
  country?: string | null;
  year?: number | null;
}

export interface ResearchEditionOptions {
  fetcher?: Fetcher;
  now?: Date | (() => Date);
  reader?: GuardedReader | DetailReader | null;
  detailReader?: DetailReader;
  useGemini?: boolean;
}

export interface EditionDetailsResult {
  status: DetailsStatus;
  candidates: DetailCandidate[];
  notes: string[];
  checkedAt: string;
}

// Check details for canonical edition facts (draft or stored). Runs finders and optional guarded Gemini reader
// without touching logged_events or personal store.
export async function researchEditionFacts(
  input: EditionFactsDetailsInput,
  finders: DetailFinder[] = defaultFinders(),
  options?: ResearchEditionOptions,
): Promise<EditionDetailsResult> {
  const now = typeof options?.now === 'function' ? options.now() : options?.now ?? new Date();
  const checkedAt = now.toISOString();
  const fetcher = options?.fetcher ?? createRateLimitedFetcher();
  const name = (input.name ?? '').trim();
  const parsedStartDateYear = input.startDate ? Number(input.startDate.slice(0, 4)) : undefined;
  const year = (input.year && Number.isInteger(input.year))
    ? input.year
    : (parsedStartDateYear && Number.isInteger(parsedStartDateYear) ? parsedStartDateYear : undefined);

  let reader = options?.detailReader;
  if (options?.useGemini === true && !reader) {
    if (!options?.reader) throw new InputError('Gemini is not set up on this server.');
    if ('read' in options.reader && typeof options.reader.read === 'function') {
      reader = options.reader as DetailReader;
    } else {
      reader = geminiReader(options.reader as GuardedReader, input.id, () => now);
    }
  } else if (!reader && options?.reader && 'read' in options.reader && typeof options.reader.read === 'function') {
    reader = options.reader as DetailReader;
  }

  const enabled = finders.filter((f) => f.enabled() && (year || f.withoutYear));
  if (!enabled.length && !reader) {
    return year
      ? { status: 'off', candidates: [], notes: ['No event source is configured.'], checkedAt }
      : { status: 'needs_date', candidates: [], notes: ['Add when it was (a year is enough) to look it up.'], checkedAt };
  }

  if (!name) {
    return { status: 'none', candidates: [], notes: ['Event name is required to look it up.'], checkedAt };
  }

  const q: DetailQuery = {
    name,
    year,
    startDate: input.startDate ?? undefined,
    endDate: input.endDate ?? undefined,
    venue: input.venue ?? undefined,
    city: input.city ?? undefined,
  };

  const found: DetailCandidate[] = [];
  const notes: string[] = [];
  const search = async (query: DetailQuery) => {
    const settled = await Promise.allSettled(enabled.map((f) => f.find(query, fetcher)));
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        found.push(...r.value);
        notes.push(`${enabled[i].id}: ${r.value.length} match(es) for "${query.name}".`);
      } else {
        notes.push(`${enabled[i].id} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      }
    });
  };
  await search(q);

  if (reader) {
    const urls = found.flatMap((c) => c.sources.filter((s) => s.sourceType === 'discovered' && s.sourceUrl).map((s) => s.sourceUrl!));
    found.push(...(await reader.read(q, [...new Set(urls)], fetcher, notes)));
  }

  const merged = mergeCandidates(found).sort(
    (a, b) => b.sources.length - a.sources.length || (a.startDate ?? '9999').localeCompare(b.startDate ?? '9999'),
  );

  if (!merged.length) {
    return year
      ? { status: 'none', candidates: [], notes, checkedAt }
      : { status: 'needs_date', candidates: [], notes: [...notes, 'No dates found; add when it was (a year is enough).'], checkedAt };
  }

  if (input.startDate) {
    const hits = merged.filter((c) => covers(c, input.startDate!));
    if (hits.length === 1 || (hits.length > 1 && hits[0].sources.length > hits[1].sources.length)) {
      await addPlaces([hits[0]], name, fetcher);
      return { status: 'matched', candidates: [hits[0]], notes, checkedAt };
    }
  }

  const shown = merged.slice(0, MAX_CANDIDATES);
  await addPlaces(shown, name, fetcher);
  return { status: 'choose', candidates: shown, notes, checkedAt };
}

