import { randomUUID } from 'node:crypto';
import type { Fetcher, SourceType } from '../lineup/types';
import { createRateLimitedFetcher, HttpError, parseJson } from '../lineup/http';
import { InputError } from '../lineup/pipeline';
import { addDays, decodeEntities, domainOf, normalizeName } from '../lineup/text';
import { braveWebSearch, eventWords } from '../lineup/search';
import { MONTH_NAMES } from '../lineup/months';
import { findDates, parseEventInput } from './parse';
import { matchingEvents, ticketmasterEvents, type TmEvent } from '../lineup/adapters/ticketmaster';
import { setlistfmSearch } from '../lineup/adapters/setlistfm';
import { CLASHFINDER_LIST_MEMO_MS, clashfinderAuthQuery, clashfinderEventList, matchEdition, type ClashfinderEventList } from '../lineup/adapters/clashfinder';
// Kept for callers and tests that reset the shared Clashfinder list between runs.
export { resetClashfinderListMemo } from '../lineup/adapters/clashfinder';
import { cityLabel, cityPoint, eventsFromPage, metroRadiusMiles, placeFromPage, withinRadius } from './place';
import { cityWithRegion, splitEventCity } from './regions';
import type { Edition, EditionWeekend } from '../lineup/types';
import type { IngestTraceRow, LineupStore } from '../lineup/store/types';
import { seriesSlugFor } from '../lineup/text';
import { editionCoversDate, matchEdition as matchCatalog, upsertOccurrence } from '../canon/match';
import { resolvedEditionDates } from './inherit';
import type { GuardedReader } from '../reader/guardedReader';
import { currentBudget } from '../lineup/budget';
import { startTrace, type Trace } from '../telemetry/trace';
import { geminiReader } from './detailsGemini';
import { DetailCandidate, DetailsStatus, EventDetails, EventField, EVENT_FIELDS, LoggedEvent } from './types';

// Stage 1 research: find and verify an event's date and place from structured
// sources and web search results. No Gemini here unless you ask for it with
// "Deep search with AI" (a DetailReader, events/detailsGemini.ts), so it
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
  // Canonical edition research may already hold Weekend 1's startDate while
  // looking up additional weekends in the same year.
  fullYearWindow?: boolean;
}

export interface DetailFinder {
  id: SourceType;
  enabled(): boolean;
  withoutYear?: boolean;
  find(q: DetailQuery, fetcher: Fetcher, now?: Date): Promise<DetailCandidate[]>;
}

const MAX_CANDIDATES = 5;
const DAY_MS = 86_400_000;
const WEEKEND_MENTION_RE = /\b(?:weekends?|wknds?|w[1-9])\b/i;
const WEEKEND_TOKEN_EXTRACT_RE = /\b(?:weekend|wknd)\s*([1-9])\b|\bw([1-9])\b/i;
const WEEKEND_TOKEN_STRIP_RE = /\b(?:weekends?|wknds?)\s*[1-9]?\b|\bw[1-9]\b/gi;
const WEEKEND_SUFFIX_STRIP_RE = /[\s\-–—·:,]*(?:\b(?:weekends?|wknds?)\s*[1-9]\b|\bw[1-9]\b)\s*$/i;

function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function searchWindow(q: DetailQuery): { from: string; to: string } {
  if (!q.year && !q.startDate) return { from: '1950-01-01', to: '2100-12-31' };
  if (q.startDate && !(q.fullYearWindow && q.year)) return { from: addDays(q.startDate, -1), to: addDays(q.endDate ?? q.startDate, 1) };
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
  async find(q, fetcher, now) {
    if (now) {
      const startYear = q.startDate ? Number(q.startDate.slice(0, 4)) : q.year;
      const endYear = q.endDate ? Number(q.endDate.slice(0, 4)) : startYear;
      if (startYear && Number.isFinite(startYear) && Math.max(startYear, endYear ?? startYear) < now.getUTCFullYear()) {
        return [];
      }
    }
    const w = searchWindow(q);
    const listed = await ticketmasterEvents(fetcher, { keyword: q.name, from: w.from, to: w.to });
    // A festival is listed once per day or ticket type: group by name and venue.
    const groups = new Map<string, TmEvent[]>();
    for (const e of matchingEvents(listed, q.name)) {
      const v = e._embedded?.venues?.[0];
      const key = `${normalizeName(e.name)}|${normalizeName(v?.name ?? '')}`;
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    return [...groups.values()].map((events) => {
      const uniqueDates = [...new Set(events.map((e) => e.dates?.start?.localDate).filter((d): d is string => Boolean(d)))].sort();
      const runs: Array<{ start: string; end: string }> = [];
      for (const d of uniqueDates) {
        const last = runs[runs.length - 1];
        if (!last || dayDiff(last.end, d) >= 4) {
          runs.push({ start: d, end: d });
        } else {
          last.end = d;
        }
      }
      const hasReasonableRuns =
        runs.length >= 2 &&
        runs.length <= 9 &&
        runs.every((r, i) => i === 0 || dayDiff(runs[i - 1].end, r.start) <= 21);
      const weekends: EditionWeekend[] | undefined = hasReasonableRuns
        ? runs.map((r, i) => ({
            weekend: i + 1,
            startDate: r.start,
            ...(r.end !== r.start ? { endDate: r.end } : {}),
          }))
        : undefined;
      const startDate = runs[0]?.start;
      const lastEnd = runs[runs.length - 1]?.end;
      const endDate = startDate && lastEnd && lastEnd !== startDate ? lastEnd : undefined;
      const v = events[0]._embedded?.venues?.[0];
      const url = events[0].url ?? `https://www.ticketmaster.com/event/${events[0].id}`;
      const names = [...new Set<string>(events.flatMap((e) => (e._embedded?.attractions ?? []).map((a) => String(a.name ?? '').trim())))];
      const c = candidate('ticketmaster', url, {
        name: events[0].name,
        startDate,
        endDate,
        venue: v?.name,
        city: cityLabel(v?.city?.name, v?.state?.stateCode, v?.country?.countryCode),
        country: v?.country?.name,
      });
      const performers = names.filter(Boolean).map((name) => ({ name, sourceType: 'ticketmaster' as const, sourceUrl: url }));
      return {
        ...c,
        ...(weekends ? { weekends } : {}),
        ...(performers.length ? { performers } : {}),
      };
    });
  },
};

// setlist.fm: past shows of an artist, for events named after the artist.
export const setlistfmFinder: DetailFinder = {
  id: 'setlistfm',
  enabled: () => Boolean(process.env.SETLISTFM_API_KEY),
  withoutYear: true,
  async find(q, fetcher) {
    const w = searchWindow(q);
    const wanted = normalizeName(q.name);
    // With a city typed, a show is kept when its venue is the one you typed, or its
    // city is the bare city you typed, or it is within the metro radius (a suburb).
    // Without a city, every show by the act in the window is kept, as before.
    const bareCity = q.city?.split(',')[0].trim();
    // A failed city lookup only turns off the radius rule; the venue and city rules still run.
    const target = bareCity ? await cityPoint(bareCity, undefined, fetcher).catch(() => null) : null;
    const radius = metroRadiusMiles();
    const typedVenue = q.venue ? normalizeName(q.venue) : '';
    const keep = (s: any): boolean => {
      if (!bareCity) return true;
      if (typedVenue && normalizeName(s.venue?.name ?? '') === typedVenue) return true;
      if (normalizeName(s.venue?.city?.name ?? '') === normalizeName(bareCity)) return true;
      const lat = Number(s.venue?.city?.coords?.lat);
      const lon = Number(s.venue?.city?.coords?.long);
      return Boolean(target && Number.isFinite(lat) && Number.isFinite(lon) && withinRadius(target, { lat, lon }, radius));
    };
    const toCandidate = (s: any): DetailCandidate => {
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
    };
    const page = async (p: number): Promise<any[]> => {
      const params: Record<string, string> = { artistName: q.name, p: String(p) };
      if (q.startDate && !q.endDate) {
        const [y, m, d] = q.startDate.split('-');
        params.date = `${d}-${m}-${y}`;
      } else if (q.year) {
        params.year = String(q.year);
      }
      return (await setlistfmSearch(fetcher, params)).setlist ?? [];
    };
    const collect = (rows: any[]) =>
      rows
        .filter((s: any) => normalizeName(s.artist?.name ?? '') === wanted)
        .filter(keep)
        .map(toCandidate)
        .filter((c: DetailCandidate) => inWindow(c.startDate, w));
    const first = await page(1);
    const kept = collect(first);
    // setlist.fm returns 20 per page. A full page that kept nothing may hide the city's show on page 2.
    if (bareCity && kept.length === 0 && first.length === 20) return collect(await page(2));
    return kept;
  },
};

// Clashfinder: festival editions and their start dates. The list comes from the shared download
// (clashfinderEventList), reused for a day. A list Clashfinder refuses or fails to send gives no candidate; a list
// cut at the size cap is reported.
export const clashfinderFinder: DetailFinder = {
  id: 'clashfinder',
  enabled: () => clashfinderAuthQuery() !== null,
  async find(q, fetcher) {
    let entries: ClashfinderEventList;
    try {
      entries = await clashfinderEventList(fetcher, { maxAgeMs: CLASHFINDER_LIST_MEMO_MS });
    } catch (err) {
      if (err instanceof HttpError && err.status !== 200) return [];
      throw err;
    }
    const match = matchEdition(entries, q.name, q.year!, q.startDate);
    if (!match) return [];
    const c = candidate('clashfinder', `https://clashfinder.com/s/${match.slug}/`, { name: match.name, startDate: match.startDate });
    return !q.month && !q.startDate ? [c] : inWindow(c.startDate, searchWindow(q)) ? [c] : [];
  },
};


export function webQuery(q: DetailQuery): string {
  const when = q.startDate
    ? `${MONTH_NAMES[Number(q.startDate.slice(5, 7)) - 1]} ${Number(q.startDate.slice(8))} ${q.year}`
    : q.month && q.year
      ? `${MONTH_NAMES[q.month - 1]} ${q.year}`
      : q.year
        ? String(q.year)
        : undefined;
  // The bare city ("Los Angeles", not "Los Angeles, CA"), the same rule the setlist.fm finder uses.
  const bareCity = q.city?.split(',')[0].trim();
  return [`"${q.name}"`, when, q.venue, bareCity].filter(Boolean).join(' ');
}

const stripTags = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Brave web search: the dates search results give for the event. A result
// counts only if its own title and description name every word of the event,
// and a date counts only if it is written there in full and falls in the
// window; the words it was read from are kept as the quote. Pages agreeing
// on a date merge into one candidate with several sources.
// The Brave results whose own title and description name every word of the
// event (and, without a year, the place you gave).
export async function braveResults(q: DetailQuery, fetcher: Fetcher, source = 'stage1_details'): Promise<Array<{ url: string; text: string }>> {
  const reply = await braveWebSearch(fetcher, webQuery(q), process.env.BRAVE_SEARCH_API_KEY!, source);
  if (reply.limited) throw new Error('Brave Search limit reached; look again later.');
  const results = reply.results;
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

function braveWeekendsFromHits(
  text: string,
  hits: Array<{ startDate: string; endDate?: string; quote: string }>,
): EditionWeekend[] | undefined {
  if (hits.length < 2 || hits.length > 9) return undefined;
  const sorted = [...hits].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].endDate ?? sorted[i - 1].startDate;
    if (prevEnd >= sorted[i].startDate) return undefined;
    const gap = dayDiff(prevEnd, sorted[i].startDate);
    if (gap < 4 || gap > 21) return undefined;
    gaps.push(gap);
  }
  const mentionsWeekend = WEEKEND_MENTION_RE.test(text);
  const twoOrThreeWeekendRuns =
    sorted.length >= 2 &&
    sorted.length <= 3 &&
    sorted.every((d) => dayDiff(d.startDate, d.endDate ?? d.startDate) <= 3) &&
    gaps.every((g) => g >= 4 && g <= 14);
  if (!mentionsWeekend && !twoOrThreeWeekendRuns) return undefined;
  return sorted.map((d, i) => ({
    weekend: i + 1,
    startDate: d.startDate,
    ...(d.endDate && d.endDate !== d.startDate ? { endDate: d.endDate } : {}),
  }));
}

export const braveFinder: DetailFinder = {
  id: 'discovered',
  enabled: () => Boolean(process.env.BRAVE_SEARCH_API_KEY),
  withoutYear: true,
  async find(q, fetcher) {
    const w = searchWindow(q);
    const out: DetailCandidate[] = [];
    let pageReads = 0;
    for (const r of await braveResults(q, fetcher)) {
      const text = r.text;
      const seen = new Set<string>();
      const hits: Array<{ startDate: string; endDate?: string; quote: string }> = [];
      for (const d of findDates(text)) {
        if (!inWindow(d.startDate, w) || seen.has(d.startDate)) continue;
        seen.add(d.startDate);
        hits.push(d);
      }
      // The snippet names the event but gives no full date, so read the page's own event data (JSON-LD).
      // At most one page a search (the page budget is shared with addPlaces: MAX_PLACE_PAGES), never AXS.
      if (!hits.length && pageReads < PAGE_READS_PER_SEARCH && w && !/(^|\.)axs\.com$/.test(domainOf(r.url))) {
        pageReads++;
        try {
          const res = await fetcher.get(r.url, { headers: { Accept: 'text/html' }, timeoutMs: 8000 });
          if (res.status === 200) {
            for (const e of eventsFromPage(res.body, q.name, w.from, w.to)) {
              const c = candidate('discovered', r.url, { startDate: e.startDate });
              c.venue = e.venue;
              c.city = e.city;
              c.sources[0].quote = e.quote;
              c.sources[0].fields = ['startDate', ...(e.venue ? ['venue'] : []), ...(e.city ? ['city'] : [])] as EventField[];
              out.push(c);
            }
          }
        } catch {
          // An unreachable page gives no date.
        }
      }
      const weekends = braveWeekendsFromHits(text, hits);
      const firstWeekendStart = weekends?.[0]?.startDate;
      for (const d of hits) {
        const c = candidate('discovered', r.url, { startDate: d.startDate, endDate: d.endDate });
        c.sources[0].quote = d.quote;
        if (weekends && d.startDate === firstWeekendStart) c.weekends = weekends;
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
      out.push({ ...c, sources: [...c.sources], ...(c.weekends?.length ? { weekends: [...c.weekends] } : {}) });
      continue;
    }
    for (const f of ['name', ...EVENT_FIELDS] as const) if (!same[f] && c[f]) same[f] = c[f];
    if (c.weekends?.length) same.weekends = [...c.weekends];
    same.sources.push(...c.sources);
    if (c.performers?.length) same.performers = [...(same.performers ?? []), ...c.performers];
  }
  return out;
}

function baseEventWords(name?: string): string[] {
  if (!name) return [];
  const cleaned = name.replace(/\b(19|20)\d{2}\b/g, ' ').replace(WEEKEND_TOKEN_STRIP_RE, ' ');
  return normalizeName(cleaned).split(' ').filter(Boolean);
}

function compatibleEventNames(a?: string, b?: string, editionName?: string): boolean {
  if (a && b) {
    const wa = baseEventWords(a);
    const wb = baseEventWords(b);
    if (!wa.length || !wb.length) return false;
    if (wa.join(' ') === wb.join(' ')) return true;
    const setA = new Set(wa);
    const setB = new Set(wb);
    return wa.every((w) => setB.has(w)) || wb.every((w) => setA.has(w));
  }
  const single = a ?? b;
  if (!single || !editionName) return true;
  const ws = baseEventWords(single);
  const we = baseEventWords(editionName);
  if (!ws.length || !we.length) return true;
  const setS = new Set(ws);
  const setE = new Set(we);
  return ws.every((w) => setE.has(w)) || we.every((w) => setS.has(w));
}

function hasWeekendSignal(c: DetailCandidate): boolean {
  return WEEKEND_MENTION_RE.test(c.name ?? '') || c.sources.some((s) => WEEKEND_MENTION_RE.test(s.quote ?? ''));
}

function explicitWeekendIndex(c: DetailCandidate): number | undefined {
  const fromName = c.name?.match(WEEKEND_TOKEN_EXTRACT_RE);
  if (fromName) return Number(fromName[1] ?? fromName[2]);
  for (const s of c.sources) {
    const m = s.quote?.match(WEEKEND_TOKEN_EXTRACT_RE);
    if (m) return Number(m[1] ?? m[2]);
  }
  return undefined;
}

function shareSource(a: DetailCandidate, b: DetailCandidate): boolean {
  return a.sources.some((sa) =>
    b.sources.some(
      (sb) =>
        (Boolean(sa.sourceUrl) && sa.sourceUrl === sb.sourceUrl) ||
        (sa.sourceType !== 'discovered' && sa.sourceType === sb.sourceType),
    ),
  );
}

function mergeCandidateSources(sources: DetailCandidate['sources']): DetailCandidate['sources'] {
  const out: DetailCandidate['sources'] = [];
  for (const s of sources) {
    const existing = s.sourceUrl
      ? out.find((o) => o.sourceType === s.sourceType && o.sourceUrl === s.sourceUrl && o.readBy === s.readBy)
      : undefined;
    if (!existing) {
      out.push({ ...s, fields: [...s.fields] });
      continue;
    }
    for (const f of s.fields) if (!existing.fields.includes(f)) existing.fields.push(f);
    if (s.quote) {
      if (!existing.quote) existing.quote = s.quote;
      else if (!existing.quote.includes(s.quote)) existing.quote = `${existing.quote} … ${s.quote}`;
    }
  }
  return out;
}

function cleanGroupName(members: DetailCandidate[]): string | undefined {
  const primary = [...members].sort((a, b) => b.sources.length - a.sources.length)[0];
  const raw = primary?.name ?? members.find((m) => m.name)?.name;
  if (!raw) return undefined;
  const distinctNames = new Set(members.map((m) => m.name).filter(Boolean));
  if (distinctNames.size > 1) {
    const stripped = raw.replace(WEEKEND_SUFFIX_STRIP_RE, '').trim();
    if (stripped) return stripped;
  }
  return raw;
}

function mergeWeekendGroup(members: DetailCandidate[], weekends: EditionWeekend[]): DetailCandidate {
  const primary = [...members].sort((a, b) => b.sources.length - a.sources.length)[0];
  const sortedWeekends = [...weekends].sort((a, b) => a.weekend - b.weekend);
  const startDate = sortedWeekends.reduce((m, w) => (w.startDate < m ? w.startDate : m), sortedWeekends[0].startDate);
  const maxEnd = sortedWeekends.reduce((m, w) => {
    const end = w.endDate ?? w.startDate;
    return end > m ? end : m;
  }, startDate);
  const endDate = maxEnd !== startDate ? maxEnd : undefined;
  const name = cleanGroupName(members);
  const ordered = [primary, ...members.filter((m) => m !== primary)];
  const pick = (f: 'venue' | 'city' | 'region' | 'country') => ordered.find((m) => m[f])?.[f];
  const venue = pick('venue');
  const city = pick('city');
  const region = pick('region');
  const country = pick('country');
  const seenPerf = new Set<string>();
  const performers: NonNullable<DetailCandidate['performers']> = [];
  for (const m of ordered) {
    for (const p of m.performers ?? []) {
      const k = `${normalizeName(p.name)}|${p.sourceType}|${p.sourceUrl}`;
      if (seenPerf.has(k)) continue;
      seenPerf.add(k);
      performers.push(p);
    }
  }
  return {
    ...primary,
    ...(name ? { name } : {}),
    startDate,
    ...(endDate ? { endDate } : {}),
    weekends: sortedWeekends,
    ...(venue ? { venue } : {}),
    ...(city ? { city } : {}),
    ...(region ? { region } : {}),
    ...(country ? { country } : {}),
    ...(performers.length ? { performers } : {}),
    sources: mergeCandidateSources(ordered.flatMap((m) => m.sources)),
  };
}

// Groups separate weekend candidates belonging to the same multi-weekend edition
// into one candidate carrying `weekends` and the full date span.
export function groupWeekendCandidates(candidates: DetailCandidate[], eventName?: string): DetailCandidate[] {
  const used = new Set<number>();
  const out: DetailCandidate[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c.weekends || c.weekends.length < 2) continue;
    used.add(i);
    const members = [c];
    for (let j = 0; j < candidates.length; j++) {
      if (used.has(j)) continue;
      const other = candidates[j];
      if (other.weekends?.length || !other.startDate) continue;
      if (!c.weekends.some((w) => w.startDate === other.startDate)) continue;
      if (!compatibleEventNames(c.name, other.name, eventName)) continue;
      if (!shareSource(c, other) && !hasWeekendSignal(c) && !hasWeekendSignal(other)) continue;
      used.add(j);
      members.push(other);
    }
    out.push(mergeWeekendGroup(members, c.weekends));
  }

  const eligibleIndices = candidates
    .map((c, idx) => ({ c, idx }))
    .filter(({ c, idx }) => !used.has(idx) && Boolean(c.startDate) && dayDiff(c.startDate!, c.endDate ?? c.startDate!) <= 3)
    .sort((a, b) => a.c.startDate!.localeCompare(b.c.startDate!) || (a.c.endDate ?? a.c.startDate!).localeCompare(b.c.endDate ?? b.c.startDate!))
    .map(({ idx }) => idx);

  for (const headIdx of eligibleIndices) {
    if (used.has(headIdx)) continue;
    const head = candidates[headIdx];
    const chain = [headIdx];
    let prevEnd = head.endDate ?? head.startDate!;
    for (const idx of eligibleIndices) {
      if (idx === headIdx || used.has(idx)) continue;
      if (chain.length >= 9) break;
      const curr = candidates[idx];
      if (!compatibleEventNames(head.name, curr.name, eventName)) continue;
      if (prevEnd >= curr.startDate!) continue;
      const gap = dayDiff(prevEnd, curr.startDate!);
      if (gap < 4 || gap > 21) continue;
      if (!shareSource(head, curr) && !hasWeekendSignal(head) && !hasWeekendSignal(curr)) continue;
      chain.push(idx);
      prevEnd = curr.endDate ?? curr.startDate!;
    }
    if (chain.length < 2) continue;
    const members = chain.map((idx) => candidates[idx]);
    const validGroup = members.some((m) => hasWeekendSignal(m)) || members.every((m, k) => k === 0 || shareSource(members[0], m));
    if (!validGroup) continue;
    for (const idx of chain) used.add(idx);

    const explicitNums = members.map((m) => explicitWeekendIndex(m));
    const definedExplicit = explicitNums.filter((n): n is number => n !== undefined);
    const hasCollision = new Set(definedExplicit).size !== definedExplicit.length;
    const usedNums = new Set<number>(hasCollision ? [] : definedExplicit);
    let nextSeq = 1;
    const weekends: EditionWeekend[] = members.map((m, k) => {
      let wNum: number;
      if (!hasCollision && explicitNums[k] !== undefined) {
        wNum = explicitNums[k]!;
      } else {
        while (usedNums.has(nextSeq)) nextSeq++;
        wNum = nextSeq++;
        usedNums.add(wNum);
      }
      return {
        weekend: wNum,
        startDate: m.startDate!,
        ...(m.endDate && m.endDate !== m.startDate ? { endDate: m.endDate } : {}),
      };
    });
    out.push(mergeWeekendGroup(members, weekends));
  }

  for (let i = 0; i < candidates.length; i++) {
    if (!used.has(i)) out.push(candidates[i]);
  }
  return out;
}

const MAX_PLACE_PAGES = 2; // 1 page for the Brave finder plus 2 for addPlaces keeps the shared total at 3
const PAGE_READS_PER_SEARCH = 1;

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

// The shared catalog. Optional: callers without it behave exactly as before.
// persist: rung 2 may write dated occurrences to shared editions. It is off unless the caller turns it on
// (owner or system path), because a member's notice for shared editions is not approved yet.
export interface ResearchCatalog {
  store: LineupStore;
  persist?: boolean;
  // persistOwn: the person's own typed name, full date, venue and city may create a `provisional` shared edition.
  // On for everyone (member notice version 2); see persistOwnEntry.
  persistOwn?: boolean;
  actor?: string;
  skipCanon?: boolean;
}

// Who may write shared editions from research: the owner, or single-user mode (no userId). A member never does
// (the member notice for shared editions is not approved). Rung 1 is read-only and runs for everyone.
export function researchCatalogFor(role: 'owner' | 'member' | undefined, userId: string | undefined, store: LineupStore): ResearchCatalog {
  return { store, persist: !userId || role === 'owner', persistOwn: true, actor: 'system:research' };
}

const catalogDay = (e: Edition, date: string) => editionCoversDate(e, date).matched;

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
  if (event.startDate) {
    const cov = editionCoversDate(e, event.startDate);
    if (cov.matched && event.weekend && cov.weekend !== undefined && cov.weekend !== event.weekend) return null;
  }
  return e;
}

function editionCandidate(e: Edition, weekend?: number): DetailCandidate {
  const dates = resolvedEditionDates(e, weekend);
  const facts = {
    name: e.name,
    startDate: dates.startDate,
    endDate: dates.endDate,
    venue: e.venue,
    city: e.city,
    region: e.region,
    country: e.country,
  };
  const clean = Object.fromEntries(Object.entries(facts).filter(([, v]) => typeof v === 'string' && v.trim())) as Omit<DetailCandidate, 'id' | 'sources'>;
  // The catalog edition is the source; SourceType has no 'edition', so the stored FieldSource is rewritten by the caller.
  return {
    id: randomUUID(),
    editionId: e.id,
    ...(e.seriesName ? { seriesName: e.seriesName } : {}),
    ...(e.weekends?.length ? { weekends: e.weekends } : {}),
    ...clean,
    sources: [{ sourceType: 'promoter', sourceUrl: '', fields: EVENT_FIELDS.filter((f) => clean[f]) }],
  };
}

// Rung 2 persistence (docs/architecture/08-sources.md): only Ticketmaster and Clashfinder results,
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
      region: c.region,
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

// A member's (or the owner's) own entry may create a `provisional` shared edition. Only the typed
// name, a full YYYY-MM-DD start date, venue, city and state (each only if the person typed it; notice version 3); no external ids,
// no country, no end date, never personal fields. Actor 'member:entry' carries no user id. A provisional source
// only fills empty fields of a matched edition, so it never changes another edition. Runs only inside the
// research queue message, never in save. Worst case 8 store calls: 3 match + venue + key check + 3 write
// (no external ids, no suggestion beyond the 2 queued ones counted in persistOccurrence's 11).
async function persistOwnEntry(event: LoggedEvent, catalog: ResearchCatalog, notes: string[]): Promise<void> {
  if (!catalog.persistOwn || !event.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(event.startDate) || !event.name.trim()) return;
  const typed = (f: 'venue' | 'city' | 'region') => (event.sources[f]?.sourceType === 'user' ? event[f] : undefined);
  try {
    const r = await upsertOccurrence(catalog.store, {
      name: event.name,
      startDate: event.startDate,
      ...(event.endDate && event.sources.endDate?.sourceType === 'user' ? { endDate: event.endDate } : {}),
      venue: typed('venue'),
      city: typed('city'),
      region: typed('region'),
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
// One trace step per finder: outcome, candidate count and milliseconds. Counts only, never page text.
async function timedFind(f: DetailFinder, query: DetailQuery, fetcher: Fetcher, trace?: Trace, now?: Date): Promise<DetailCandidate[]> {
  const started = Date.now();
  try {
    const out = await f.find(query, fetcher, now);
    trace?.step('finder', { finder: f.id, outcome: out.length ? 'ok' : 'empty', candidates: out.length, ms: Date.now() - started });
    return out;
  } catch (err) {
    trace?.step('finder', { finder: f.id, outcome: 'failed', ms: Date.now() - started });
    throw err;
  }
}

// The free finders leave a gap when, without a full date, none of their candidates gives a date, or, with a
// full date, a field you left empty (venue or city) is answered by none of them. Only then is web search worth its call.
export function leavesGap(event: LoggedEvent, found: DetailCandidate[]): boolean {
  if (!event.startDate) return !found.some((c) => c.startDate);
  return (!event.venue && !found.some((c) => c.venue)) || (!event.city && !found.some((c) => c.city));
}

export async function researchEvent(
  event: LoggedEvent,
  finders: DetailFinder[],
  fetcher: Fetcher,
  now: Date,
  reader?: DetailReader,
  catalog?: ResearchCatalog,
  opts?: { skipCanon?: boolean; trace?: Trace },
): Promise<LoggedEvent> {
  const checkedAt = now.toISOString();
  const skipCanon = Boolean(opts?.skipCanon || catalog?.skipCanon || event.details?.skipCanon);
  const year = event.year ?? (event.startDate ? Number(event.startDate.slice(0, 4)) : undefined);
  const done = (details: Omit<EventDetails, 'checkedAt'>, ev: LoggedEvent = event): LoggedEvent => ({
    ...ev,
    details: { ...details, ...(skipCanon ? { skipCanon: true } : {}), checkedAt },
    updatedAt: checkedAt,
  });
  const found: DetailCandidate[] = [];
  const notes: string[] = [];
  let catalogMatched = false;
  if (catalog && !skipCanon) {
    try {
      const hit = await catalogHit(event, catalog);
      if (hit) {
        const cov = event.startDate ? editionCoversDate(hit, event.startDate) : { matched: false };
        const c = editionCandidate(hit, event.weekend ?? cov.weekend);
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
  // A finder that is off is named in the notes; one skipped only for lack of a year is not.
  const configured = finders.filter((f) => f.enabled());
  notes.push(...finders.filter((f) => !configured.includes(f)).map((f) => `${f.id}: not configured.`));
  for (const f of finders.filter((x) => !configured.includes(x))) opts?.trace?.step('finder', { finder: f.id, outcome: 'off' });
  const enabled = configured.filter((f) => year || f.withoutYear);
  if (!enabled.length && !reader) {
    return year
      ? done({ status: 'off', candidates: [], notes: [...notes, 'No event source is configured.'] })
      : done({ status: 'needs_date', candidates: [], notes: [...notes, 'Add when it was (a year is enough) to look it up.'] });
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
  const runFinders = async (list: DetailFinder[], query: DetailQuery) => {
    const settled = await Promise.allSettled(list.map((f) => timedFind(f, query, fetcher, opts?.trace, now)));
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        found.push(...r.value);
        notes.push(`${list[i].id}: ${r.value.length} match(es) for "${query.name}".`);
      } else {
        notes.push(`${list[i].id} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      }
    });
  };
  // The free finders run first. Web search (Brave, id 'discovered') runs only when they leave a gap.
  const search = async (query: DetailQuery) => {
    await runFinders(enabled.filter((f) => f.id !== 'discovered'), query);
    const web = enabled.filter((f) => f.id === 'discovered');
    if (web.length && leavesGap(event, found)) await runFinders(web, query);
    else if (web.length) notes.push('discovered: not searched; the free sources answered the gaps.');
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

// The queued research message for a freshly saved event (ladder rungs 1 to 3: structured APIs
// and web search results read in code; never the reader model, which is rung 4).
// It runs only while the event is still waiting ('pending'): "Look again" or Fill gaps may have finished it
// first, and a second run must not overwrite that. Results follow researchEvent's rules (candidates; typed
// fields are never overwritten). Returns the saved event, or null when there was nothing to do.
//
// Worst-case subrequests of one message: 2 store calls (getEvent, putEvent) + finders 4 (Ticketmaster,
// setlist.fm, Clashfinder, Brave) + 4 again when the first name finds nothing and the typed name differs
// + 3 place pages (addPlaces) = 13 without a catalog.
// With a catalog: + rung 1 (up to 3 store calls: one external-id lookup, listEditions, venue alias)
// + rung 2 persistence of at most one occurrence (up to 11 store calls, see persistOccurrence) = 27 worst case
// persistOwnEntry adds at most 8 more store calls (35 worst case).
// (the plan's figure is 26; 1 over, dropping the external-id lookup would meet it). Both are zero when no catalog is passed. The consumer's budget (50) holds.
export async function runQueuedResearch(
  store: {
    getEvent(id: string): Promise<LoggedEvent | null>;
    putEvent(event: LoggedEvent): Promise<void>;
    addIngestTrace?(row: IngestTraceRow): Promise<void>;
  },
  eventId: string,
  finders: DetailFinder[],
  fetcher: Fetcher,
  now: Date,
  catalog?: ResearchCatalog,
): Promise<LoggedEvent | null> {
  const startUsed = currentBudget()?.used ?? null;
  const event = await store.getEvent(eventId);
  if (!event || event.details.status !== 'pending') return null;
  const trace = startTrace('research', { eventId });
  try {
    const updated = await researchEvent(event, finders, fetcher, now, undefined, catalog, { trace });
    await store.putEvent(updated);
    return updated;
  } finally {
    const b = currentBudget();
    if (b && startUsed !== null) trace.subrequests(Math.max(0, b.used - startUsed));
    await trace.finish(typeof store.addIngestTrace === 'function' ? { addIngestTrace: store.addIngestTrace.bind(store) } : null);
  }
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
    if (!options?.reader) throw new InputError('Deep search is not set up on this server.');
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
    ...(year ? { fullYearWindow: true } : {}),
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
  const grouped = groupWeekendCandidates(merged, name).sort(
    (a, b) => b.sources.length - a.sources.length || (a.startDate ?? '9999').localeCompare(b.startDate ?? '9999'),
  );

  if (!grouped.length) {
    return year
      ? { status: 'none', candidates: [], notes, checkedAt }
      : { status: 'needs_date', candidates: [], notes: [...notes, 'No dates found; add when it was (a year is enough).'], checkedAt };
  }

  if (input.startDate) {
    const hits = grouped.filter((c) => covers(c, input.startDate!));
    if (hits.length === 1 || (hits.length > 1 && hits[0].sources.length > hits[1].sources.length)) {
      await addPlaces([hits[0]], name, fetcher);
      return { status: 'matched', candidates: [hits[0]], notes, checkedAt };
    }
  }

  const shown = grouped.slice(0, MAX_CANDIDATES);
  await addPlaces(shown, name, fetcher);
  return { status: 'choose', candidates: shown, notes, checkedAt };
}

