import { AdapterContext, AdapterResult, SourceAdapter } from '../types';
import { parseJson } from '../http';
import { addDays, htmlToText, isoDay } from '../text';
import { emptyResult, makeDocument } from './common';
import { slugFromClashfinderUrl } from './clashfinder';

// Official promoter lineup pages (Insomniac, Goldenvoice, ...). There is no
// API, so the page text is stored and handed to Gemini extraction, where every
// name must be quoted verbatim from this text.
//
// Promoters overwrite their lineup page for the next edition, so a past event
// is read from the Wayback Machine snapshot closest to the event dates.

export function isPastEvent(endOrStart: string | undefined, year: number, now: Date): boolean {
  const last = endOrStart ?? `${year}-12-31`;
  return addDays(last, 2) < isoDay(now);
}

interface WaybackAvailability {
  archived_snapshots?: { closest?: { available?: boolean; url?: string; timestamp?: string } };
}

export function rawSnapshotUrl(snapshotUrl: string): string {
  return snapshotUrl.replace(/\/web\/(\d{14})\//, '/web/$1id_/');
}

// A snapshot only counts if it was taken around the edition: from 180 days
// before it started to 45 days after it ended.
export function snapshotInWindow(timestamp: string, start: string, end: string): boolean {
  const day = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`;
  return day >= addDays(start, -180) && day <= addDays(end, 45);
}

export const promoterAdapter: SourceAdapter = {
  id: 'promoter',
  enabled: () => true,

  async collect(ctx: AdapterContext): Promise<AdapterResult> {
    const result = emptyResult();
    const userUrl = slugFromClashfinderUrl(ctx.input.lineupUrl) ? undefined : ctx.input.lineupUrl;
    const pageUrl = userUrl || ctx.series?.lineupUrl;
    if (!pageUrl) {
      result.notes.push('Promoter page: no lineup URL known for this series yet.');
      return result;
    }

    const start = ctx.input.startDate ?? `${ctx.input.year}-01-01`;
    const end = ctx.input.endDate ?? ctx.input.startDate ?? `${ctx.input.year}-12-31`;

    if (isPastEvent(ctx.input.endDate ?? ctx.input.startDate, ctx.input.year, ctx.now)) {
      const timestamp = end.replace(/-/g, '');
      const availUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(pageUrl)}&timestamp=${timestamp}`;
      const avail = parseJson<WaybackAvailability>(await ctx.fetcher.get(availUrl));
      const closest = avail.archived_snapshots?.closest;
      if (closest?.available && closest.url && closest.timestamp && snapshotInWindow(closest.timestamp, start, end)) {
        const res = await ctx.fetcher.get(rawSnapshotUrl(closest.url), { timeoutMs: 30000 });
        if (res.status === 200) {
          const doc = makeDocument(closest.url, 'wayback', htmlToText(res.body), 'text');
          result.documents.push(doc);
          result.extractionQueue.push(doc.id);
          result.notes.push(`Wayback: snapshot from ${closest.timestamp.slice(0, 8)} of ${pageUrl}.`);
          return result;
        }
      }
      if (!userUrl) {
        result.notes.push(`Wayback: no snapshot of ${pageUrl} near the event dates; skipped the live page because it likely shows a later edition.`);
        return result;
      }
      result.notes.push('Wayback: no snapshot near the event dates; reading the URL you gave as-is.');
    }

    const res = await ctx.fetcher.get(pageUrl, { timeoutMs: 30000 });
    if (res.status !== 200) {
      result.notes.push(`Promoter page returned HTTP ${res.status}.`);
      return result;
    }
    const doc = makeDocument(res.url, 'promoter', htmlToText(res.body), 'text');
    result.documents.push(doc);
    result.extractionQueue.push(doc.id);
    result.notes.push(`Promoter page fetched: ${res.url}.`);
    return result;
  },
};
