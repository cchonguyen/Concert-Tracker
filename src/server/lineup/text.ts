import { createHash } from 'node:crypto';

import { normalizeName } from './normalizeName';

export { normalizeName };

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
  mdash: '—',
  ndash: '–',
  middot: '·',
  bull: '•',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  times: '×',
  copy: '©',
  reg: '®',
  trade: '™',
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
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<header[\s\S]*?<\/header>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<dialog[\s\S]*?<\/dialog>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
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

interface PerformerLine {
  start: number;
  end: number;
}

interface LineupCluster {
  start: number;
  end: number;
  count: number;
}

// Keep the part of a long page most likely to hold the lineup, within budget.
export function lineupWindow(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;

  // Find all performer-like lines: lines between 2 and 40 characters.
  const performerLines: PerformerLine[] = [];
  let lineStart = 0;
  while (lineStart < text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);
    const trimmed = line.trim();
    if (trimmed.length >= 2 && trimmed.length <= 40 && !/^https?:\/\//i.test(trimmed)) {
      performerLines.push({ start: lineStart, end: lineEnd });
    }
    lineStart = lineEnd + 1;
  }

  // Group performer lines into clusters. Lines within MAX_GAP characters of each other
  // belong to the same cluster (e.g. multi-stage lineups, stage headers, artist bios).
  const MAX_GAP = 2500;
  const clusters: LineupCluster[] = [];
  if (performerLines.length > 0) {
    let cur: LineupCluster = {
      start: performerLines[0].start,
      end: performerLines[0].end,
      count: 1,
    };
    for (let i = 1; i < performerLines.length; i++) {
      const p = performerLines[i];
      if (p.start - cur.end <= MAX_GAP) {
        cur.end = p.end;
        cur.count++;
      } else {
        clusters.push(cur);
        cur = { start: p.start, end: p.end, count: 1 };
      }
    }
    clusters.push(cur);
  }

  // Find the densest cluster (highest number of performer lines).
  let bestCluster: LineupCluster | null = null;
  for (const c of clusters) {
    if (!bestCluster || c.count > bestCluster.count) {
      bestCluster = c;
    }
  }

  // Keyword match position
  const keywordIdx = text.search(/line[- ]?up|artists|performers|set times/i);

  // If a keyword match exists earlier in the page outside the best cluster (e.g. in a nav header),
  // check how many lines that cluster has.
  const headerCluster = keywordIdx >= 0
    ? clusters.find((c) => keywordIdx >= c.start && keywordIdx <= c.end)
    : null;
  const isHeaderMatch = Boolean(headerCluster && headerCluster !== bestCluster);
  const headerCount = isHeaderMatch && headerCluster ? headerCluster.count : 0;

  // Use the roster cluster if it has at least 4 performer lines and is denser than any earlier header match.
  if (bestCluster && bestCluster.count >= 4 && bestCluster.count > headerCount) {
    const clusterLen = bestCluster.end - bestCluster.start;
    let start: number;
    if (clusterLen <= maxChars) {
      // Center the window on the roster block
      const center = Math.floor((bestCluster.start + bestCluster.end) / 2);
      start = Math.floor(center - maxChars / 2);
    } else {
      // Roster is larger than budget: start at the beginning of the roster block
      // with a 5% margin for stage/header context
      const margin = Math.floor(maxChars * 0.05);
      start = bestCluster.start - margin;
    }
    start = Math.max(0, Math.min(start, text.length - maxChars));
    return text.slice(start, start + maxChars);
  }

  // Fallback to keyword match or start of document
  const start = keywordIdx > 0 ? Math.max(0, keywordIdx - Math.floor(maxChars * 0.05)) : 0;
  const clampedStart = Math.max(0, Math.min(start, text.length - maxChars));
  return text.slice(clampedStart, clampedStart + maxChars);
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
