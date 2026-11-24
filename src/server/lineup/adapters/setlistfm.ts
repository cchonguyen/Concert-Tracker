import { AdapterContext, AdapterResult, SourceAdapter } from '../types';
import { parseJson } from '../http';
import { daysBetween, normalizeName } from '../text';
import { emptyResult, makeDocument } from './common';

// setlist.fm (non-commercial key). Demoted to one job: upgrading a billed act
// to "performed" when a post-show setlist exists. Runs after the other
// adapters so it can use the dates and venue they found.

const VERSION = 'setlistfm@1';
const MAX_PAGES_PER_DAY = 5;

export interface Setlist {
  url?: string;
  eventDate?: string; // dd-MM-yyyy
  artist?: { mbid?: string; name?: string };
  venue?: { name?: string; city?: { name?: string } };
  tour?: { name?: string };
  info?: string;
}

export interface SetlistSearch {
  setlist?: Setlist[];
  total?: number;
  itemsPerPage?: number;
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'at', 'in', 'of', 'on', 'for', 'to', 'with']);

export function toSetlistDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

export function belongsToEvent(s: Setlist, eventName: string, venue?: string): boolean {
  const words = normalizeName(eventName.replace(/\b(19|20)\d{2}\b/g, ' ')).split(' ').filter(Boolean);
  if (words.length === 0) return false;

  const v = normalizeName(s.venue?.name ?? '');
  const targetVenue = venue ? normalizeName(venue) : '';
  const venueMatches = Boolean(targetVenue && v && (v.includes(targetVenue) || targetVenue.includes(v)));

  const artistName = normalizeName(s.artist?.name ?? '');
  const tourName = normalizeName(s.tour?.name ?? '');
  const infoText = normalizeName(s.info ?? '');

  const metaHay = ` ${artistName} ${tourName} ${infoText} `;
  const tourVenueHay = ` ${tourName} ${v} `;
  const fullHay = ` ${artistName} ${tourName} ${v} ${infoText} `;

  if (venueMatches) {
    const significantWords = words.filter((w) => !STOP_WORDS.has(w));
    const checkWords = significantWords.length > 0 ? significantWords : words;
    const hasWordOverlap = checkWords.some((w) => metaHay.includes(` ${w} `));
    const tourVenueMatch = words.every((w) => tourVenueHay.includes(` ${w} `));
    return hasWordOverlap || tourVenueMatch;
  }

  return words.every((w) => fullHay.includes(` ${w} `));
}

// The setlist.fm client, shared by Check details and Find the lineup: one page of the setlist search. setlist.fm
// answers 404 when nothing matches, which is returned as no setlists. Other failures throw HttpError.
export async function setlistfmSearch(fetcher: AdapterContext['fetcher'], params: Record<string, string>): Promise<SetlistSearch> {
  const res = await fetcher.get(`https://api.setlist.fm/rest/1.0/search/setlists?${new URLSearchParams(params)}`, {
    headers: { 'x-api-key': process.env.SETLISTFM_API_KEY!, Accept: 'application/json' },
  });
  if (res.status === 404) return { setlist: [], total: 0 };
  return parseJson<SetlistSearch>(res) ?? { setlist: [], total: 0 };
}

export const setlistfmAdapter: SourceAdapter = {
  id: 'setlistfm',
  enabled: () => Boolean(process.env.SETLISTFM_API_KEY),

  async collect(ctx: AdapterContext): Promise<AdapterResult> {
    const result = emptyResult();
    const { input } = ctx;
    if (!input.startDate || !input.city) {
      result.notes.push('setlist.fm: skipped, needs a start date and city.');
      return result;
    }
    const matched: Setlist[] = [];

    for (const day of daysBetween(input.startDate, input.endDate ?? input.startDate)) {
      for (let page = 1; page <= MAX_PAGES_PER_DAY; page++) {
        const data = await setlistfmSearch(ctx.fetcher, { date: toSetlistDate(day), cityName: input.city, p: String(page) });
        const items = data.setlist ?? [];
        matched.push(...items.filter((s) => belongsToEvent(s, input.eventName, input.venue)));
        if (items.length === 0 || page * (data.itemsPerPage ?? 20) >= (data.total ?? 0)) break;
      }
    }

    if (matched.length === 0) {
      result.notes.push('setlist.fm: no setlists for these dates and venue.');
      return result;
    }
    const doc = makeDocument(
      `https://www.setlist.fm/search?query=${encodeURIComponent(input.eventName)}`,
      'setlistfm',
      JSON.stringify(matched),
      'json',
    );
    result.documents.push(doc);
    for (const s of matched) {
      if (!s.artist?.name) continue;
      const [d, m, y] = (s.eventDate ?? '').split('-');
      result.performers.push({
        documentId: doc.id,
        sourceType: 'setlistfm',
        sourceUrl: s.url ?? doc.url,
        name: s.artist.name,
        quotedSpan: s.artist.name,
        evidence: 'performed',
        day: y ? `${y}-${m}-${d}` : undefined,
        mbid: s.artist.mbid,
        extractor: 'setlistfm',
        extractorVersion: VERSION,
      });
    }
    result.notes.push(`setlist.fm: ${result.performers.length} sets confirmed as performed.`);
    return result;
  },
};
