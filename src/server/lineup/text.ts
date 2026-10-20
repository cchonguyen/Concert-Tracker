import { createHash } from 'node:crypto';

// Lowercase, strip diacritics and punctuation, collapse whitespace.
// Used for merge keys and the verbatim check; never for display.
export function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function slugify(value: string): string {
  return normalizeName(value).replace(/\s+/g, '-');
}

export function seriesSlugFor(eventName: string): string {
  // The year lives in the edition key, not the series slug.
  return slugify(eventName.replace(/\b(19|20)\d{2}\b/g, ' ')) || 'event';
}

// One edition per date when the date is known: an artist plays many shows a
// year, each with its own openers. Without a date, the year.
export function editionKeyFor(eventName: string, year: number, startDate?: string): string {
  return `${seriesSlugFor(eventName)}/${startDate ?? year}`;
}

// The core anti-hallucination check: the quoted span must occur in the source
// text, and the name must occur in the quoted span.
export function isVerbatim(name: string, quotedSpan: string, normalizedSource: string): boolean {
  const n = normalizeName(name);
  const q = normalizeName(quotedSpan);
  if (!n || !q) return false;
  return containsPhrase(normalizedSource, q) && containsPhrase(q, n);
}

function containsPhrase(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '*';
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

// Visible text plus string values from embedded JSON (many festival sites
// render the lineup client-side from __NEXT_DATA__ or similar).
export function htmlToText(html: string): string {
  const jsonStrings: string[] = [];
  const scriptRe = /<script[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptRe)) {
    try {
      collectStrings(JSON.parse(match[1]), jsonStrings);
    } catch {
      // Not JSON after all.
    }
  }
  const visible = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<(br|\/p|\/li|\/h\d|\/div|\/tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  );
  const lines = [visible, ...jsonStrings]
    .join('\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
  return lines.join('\n');
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 12 || out.length > 20000) return;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s.length >= 2 && s.length <= 200 && !/^https?:\/\//.test(s)) out.push(s);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, out, depth + 1);
  }
}

// Keep the part of a long page most likely to hold the lineup, within budget.
export function lineupWindow(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const idx = text.search(/line[- ]?up|artists|performers|set times/i);
  const start = idx > 0 ? Math.max(0, idx - Math.floor(maxChars * 0.05)) : 0;
  return text.slice(start, start + maxChars);
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}

export function daysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start;
  while (cur <= end && out.length < 14) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}
