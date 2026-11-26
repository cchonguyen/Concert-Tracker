import { LineupStore } from './store/types';
import { SeriesRecord } from './types';
import { normalizeName, seriesSlugFor } from './text';

// The name a new shared series gets from a ticket title: no year, weekend,
// set note, "2nd show added", age limit or special-guest tail, and
// "X presents Y" as "X: Y". Text it does not recognise stays.
export function cleanSeriesName(raw: string): string {
  let s = ` ${raw} `;
  s = s.replace(/\s[-–|:]\s*\d?(st|nd|rd|th)?\s*show added!?/gi, ' ');
  s = s.replace(/\(\s*(dj|live)\s+set\s*\)/gi, ' ');
  s = s.replace(/\(?\s*(all\s+)?ages\s+\d{2}\s*\+?[^)]*\)?/gi, ' ');
  s = s.replace(/\(?\s*\b\d{2}\s*\+\s*(with valid id|w\/ valid i\.?d\.?)?\s*\)?/gi, ' ');
  s = s.replace(/\s(w\/|with)\s+special\s+guests?\b.*$/i, ' ');
  s = s.replace(/\b(weekend|wknd|wk)\s*\d\b/gi, ' ');
  s = s.replace(/\bW[1-9]\b/g, ' ');
  s = s.replace(/(^|\s)'?(19|20)\d{2}(?=\s|$)/g, ' ');
  s = s.replace(/\s+(presents|pres\.?)\s+/i, ': ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[\s\-–|:,]+|[\s\-–|:,]+$/g, '').trim();
  return s || raw.trim();
}

const keyOf = (name: string) => normalizeName(cleanSeriesName(name));

// The shared series an event name belongs to: by its slug, then by the
// series' name or one of its other names once both are cleaned. A brand alone
// never matches (one brand holds several series), and two matches give none.
export async function findSeries(store: LineupStore, eventName: string): Promise<SeriesRecord | null> {
  const cleaned = cleanSeriesName(eventName);
  for (const slug of new Set([seriesSlugFor(cleaned), seriesSlugFor(eventName)])) {
    const bySlug = await store.getSeries(slug);
    if (bySlug) return bySlug;
  }
  const key = normalizeName(cleaned);
  if (!key) return null;
  const all = await store.listSeries({ limit: 500 });
  const hits = all.filter((s) => [s.name, ...(s.aliases ?? [])].some((n) => keyOf(n) === key));
  return hits.length === 1 ? hits[0] : null;
}
