import { AdapterContext, AdapterResult, NewPerformerClaim, SourceAdapter } from '../types';
import { parseJson } from '../http';
import { addDays, normalizeName } from '../text';
import { emptyResult, fact, makeDocument } from './common';
import { billingFromTitle } from '../billing';

// Ticketmaster Discovery API v2. Free key, 5,000 calls/day. Anchors the
// canonical event name, dates and venue; attractions are performers, though
// festival listings may name headliners only. Past events generally drop out
// of the Discovery API, so this mainly helps upcoming and recent editions.

// @2: a listing named "X with special guest Y" bills X as headliner and Y as
// support, quoting the listing name.
const VERSION = 'ticketmaster@2';

export interface TmEvent {
  id: string;
  name: string;
  url?: string;
  dates?: { start?: { localDate?: string } };
  _embedded?: {
    venues?: Array<{ name?: string; city?: { name?: string }; state?: { stateCode?: string }; country?: { name?: string; countryCode?: string } }>;
    attractions?: Array<{ id: string; name: string }>;
  };
}

interface TmSearch {
  _embedded?: { events?: TmEvent[] };
}

// The Ticketmaster client, shared by Check details and Find the lineup: one search of music listings in a date
// window (yyyy-mm-dd, whole days in UTC), at most 50 listings. Stage logic (grouping, matching) stays with each caller.
export async function ticketmasterEvents(
  fetcher: AdapterContext['fetcher'],
  q: { keyword: string; from: string; to: string; city?: string },
): Promise<TmEvent[]> {
  const params = new URLSearchParams({
    apikey: process.env.TICKETMASTER_API_KEY!,
    keyword: q.keyword,
    startDateTime: `${q.from}T00:00:00Z`,
    endDateTime: `${q.to}T23:59:59Z`,
    classificationName: 'music',
    size: '50',
  });
  if (q.city) params.set('city', q.city);
  const data = parseJson<TmSearch>(await fetcher.get(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`));
  return data?._embedded?.events ?? [];
}

export function matchingEvents(events: TmEvent[], eventName: string): TmEvent[] {
  const wanted = normalizeName(eventName.replace(/\b(19|20)\d{2}\b/g, ' ')).split(' ').filter(Boolean);
  return events.filter((e) => {
    const name = ` ${normalizeName(e.name)} `;
    return wanted.every((w) => name.includes(` ${w} `));
  });
}

export const ticketmasterAdapter: SourceAdapter = {
  id: 'ticketmaster',
  enabled: () => Boolean(process.env.TICKETMASTER_API_KEY),

  async collect(ctx: AdapterContext): Promise<AdapterResult> {
    const result = emptyResult();
    const { input } = ctx;
    const start = input.startDate ? addDays(input.startDate, -3) : `${input.year}-01-01`;
    const end = input.endDate ? addDays(input.endDate, 3) : input.startDate ? addDays(input.startDate, 7) : `${input.year}-12-31`;
    const listed = await ticketmasterEvents(ctx.fetcher, {
      keyword: input.eventName.replace(/\b(19|20)\d{2}\b/g, '').trim(),
      from: start,
      to: end,
      city: input.city,
    });
    const events = matchingEvents(listed, input.eventName);
    if (events.length === 0) {
      result.notes.push('Ticketmaster: no matching event listing (past events are often removed).');
      return result;
    }

    const publicUrl = events[0].url ?? `https://www.ticketmaster.com/event/${events[0].id}`;
    const doc = makeDocument(publicUrl, 'ticketmaster', JSON.stringify(events), 'json');
    result.documents.push(doc);

    const dates = events.map((e) => e.dates?.start?.localDate).filter((d): d is string => Boolean(d)).sort();
    const venue = events[0]._embedded?.venues?.[0];
    result.facts = {
      name: fact(events[0].name, 'ticketmaster', publicUrl),
      startDate: fact(dates[0], 'ticketmaster', publicUrl),
      endDate: fact(dates[dates.length - 1], 'ticketmaster', publicUrl),
      venue: fact(venue?.name, 'ticketmaster', publicUrl),
      city: fact(venue?.city?.name, 'ticketmaster', publicUrl),
      country: fact(venue?.country?.name, 'ticketmaster', publicUrl),
    };

    const seen = new Set<string>();
    for (const e of events) {
      const attractions = e._embedded?.attractions ?? [];
      const roles = billingFromTitle(e.name, attractions.map((a) => a.name));
      for (const a of attractions) {
        const key = `${a.id}:${e.dates?.start?.localDate ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const billing = roles.get(normalizeName(a.name));
        result.performers.push({
          documentId: doc.id,
          sourceType: 'ticketmaster',
          sourceUrl: e.url ?? publicUrl,
          name: a.name,
          quotedSpan: billing ? e.name : a.name,
          evidence: 'billed',
          billing,
          day: events.length > 1 ? e.dates?.start?.localDate : undefined,
          extractor: 'ticketmaster',
          extractorVersion: VERSION,
        } satisfies NewPerformerClaim);
      }
    }
    result.notes.push(`Ticketmaster: ${events.length} listing(s), ${result.performers.length} attraction(s).`);
    return result;
  },
};
