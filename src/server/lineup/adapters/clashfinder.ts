import { AdapterContext, AdapterResult, NewPerformerClaim, SourceAdapter } from '../types';
import { HttpError, parseJson } from '../http';
import { normalizeName, sha256 } from '../text';
import { emptyResult, fact, makeDocument } from './common';

// Clashfinder (https://clashfinder.com/pages/api/). Crowd-sourced, but the
// most complete per-edition source for festivals, with stages and set times,
// and past years stay archived.
//
// Since October 2025 every API call needs authUsername + authPublicKey, where
// the public key is a SHA-256 hash of the username, the account's private key
// and optional parameters. The exact concatenation is documented on the API
// page; it is configurable here (CLASHFINDER_HASH_FORMAT) because it could not
// be verified when this adapter was written. CLASHFINDER_PUBLIC_KEY skips the
// hashing if you copy a ready-made key from your Clashfinder account.

const BASE = 'https://clashfinder.com';
const VERSION = 'clashfinder@1';

export function clashfinderAuthQuery(): string | null {
  const username = process.env.CLASHFINDER_USERNAME;
  if (!username) return null;
  let publicKey = process.env.CLASHFINDER_PUBLIC_KEY;
  if (!publicKey) {
    const privateKey = process.env.CLASHFINDER_PRIVATE_KEY;
    if (!privateKey) return null;
    const format = process.env.CLASHFINDER_HASH_FORMAT || '{username}{privateKey}';
    publicKey = sha256(format.replace('{username}', username).replace('{privateKey}', privateKey));
  }
  return `authUsername=${encodeURIComponent(username)}&authPublicKey=${encodeURIComponent(publicKey)}`;
}

export function slugFromClashfinderUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/clashfinder\.com\/(?:s|m|l|data\/event)\/([a-z0-9_-]+)/i);
  return m ? m[1] : null;
}

interface EventListEntry {
  slug: string;
  name: string;
  startDate?: string;
}

// The list format is parsed defensively: either an object keyed by slug or an
// array of objects carrying the slug in one of a few fields.
export function parseEventList(json: unknown): EventListEntry[] {
  const out: EventListEntry[] = [];
  const read = (slug: unknown, v: any) => {
    const name = v?.name ?? v?.title ?? v?.fullName;
    if (typeof slug === 'string' && typeof name === 'string') {
      out.push({ slug, name, startDate: v?.startDate ?? v?.start ?? v?.date });
    }
  };
  if (Array.isArray(json)) {
    for (const v of json) read((v as any)?.short ?? (v as any)?.slug ?? (v as any)?.id ?? (v as any)?.url, v);
  } else if (json && typeof json === 'object') {
    const obj = json as Record<string, any>;
    const inner = Array.isArray(obj.events) ? obj.events : null;
    if (inner) return parseEventList(inner);
    for (const [slug, v] of Object.entries(obj)) read(slug, v);
  }
  return out;
}

export function matchEdition(entries: EventListEntry[], eventName: string, year: number): EventListEntry | null {
  const wanted = normalizeName(eventName.replace(/\b(19|20)\d{2}\b/g, ' ')).split(' ').filter(Boolean);
  const yy = String(year).slice(2);
  let best: { entry: EventListEntry; score: number } | null = null;
  for (const entry of entries) {
    const name = normalizeName(entry.name);
    if (!wanted.every((w) => ` ${name} `.includes(` ${w} `))) continue;
    const yearHit =
      name.includes(String(year)) ||
      entry.startDate?.startsWith(String(year)) ||
      new RegExp(`(^|[^0-9])(${year}|${yy})$`).test(entry.slug);
    if (!yearHit) continue;
    const score = 100 - Math.abs(name.length - wanted.join(' ').length);
    if (!best || score > best.score) best = { entry, score };
  }
  return best?.entry ?? null;
}

interface ClashfinderAct {
  name: string;
  start?: string;
  end?: string;
  stage?: string;
}

// Event data: { name, locations: [{ name, events: [{ name, start, end }] }] }.
export function parseEventData(json: any): { eventName?: string; acts: ClashfinderAct[] } {
  const acts: ClashfinderAct[] = [];
  for (const loc of Array.isArray(json?.locations) ? json.locations : []) {
    for (const ev of Array.isArray(loc?.events) ? loc.events : []) {
      if (typeof ev?.name === 'string' && ev.name.trim()) {
        acts.push({ name: ev.name.trim(), start: ev.start, end: ev.end, stage: loc?.name });
      }
    }
  }
  return { eventName: typeof json?.name === 'string' ? json.name : undefined, acts };
}

// Festival day for a set: sets starting before 06:00 belong to the previous day.
export function festivalDay(start: string | undefined): string | undefined {
  if (!start) return undefined;
  const m = start.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):/);
  if (!m) return undefined;
  if (Number(m[2]) >= 6) return m[1];
  const d = new Date(`${m[1]}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export const clashfinderAdapter: SourceAdapter = {
  id: 'clashfinder',
  enabled: () => clashfinderAuthQuery() !== null,

  async collect(ctx: AdapterContext): Promise<AdapterResult> {
    const result = emptyResult();
    const auth = clashfinderAuthQuery()!;
    const year = String(ctx.input.year);

    let slug =
      slugFromClashfinderUrl(ctx.input.lineupUrl) ?? ctx.series?.clashfinderSlugs?.[year] ?? null;

    if (!slug) {
      const listUrl = `${BASE}/data/events/all.json?${auth}`;
      const res = await ctx.fetcher.get(listUrl);
      if (res.status === 401) throw new HttpError(401, listUrl, 'Clashfinder rejected the credentials (401). Check CLASHFINDER_* settings.');
      const match = matchEdition(parseEventList(parseJson(res)), ctx.input.eventName, ctx.input.year);
      if (!match) {
        result.notes.push('Clashfinder: no matching edition in the event list.');
        return result;
      }
      slug = match.slug;
    }

    const url = `${BASE}/data/event/${slug}.json?${auth}`;
    const res = await ctx.fetcher.get(url);
    if (res.status === 401) throw new HttpError(401, url, 'Clashfinder rejected the credentials (401). Check CLASHFINDER_* settings.');
    if (res.status === 404) {
      result.notes.push(`Clashfinder: edition "${slug}" not found.`);
      return result;
    }
    const data = parseEventData(parseJson(res));
    const publicUrl = `${BASE}/s/${slug}/`;
    const doc = makeDocument(publicUrl, 'clashfinder', res.body, 'json');
    result.documents.push(doc);
    result.seriesHints = { clashfinderSlugs: { ...(ctx.series?.clashfinderSlugs ?? {}), [year]: slug } };

    const days = data.acts.map((a) => festivalDay(a.start)).filter((d): d is string => Boolean(d)).sort();
    result.facts = {
      name: fact(data.eventName, 'clashfinder', publicUrl),
      startDate: fact(days[0], 'clashfinder', publicUrl),
      endDate: fact(days[days.length - 1], 'clashfinder', publicUrl),
    };

    result.performers = data.acts.map(
      (a): NewPerformerClaim => ({
        documentId: doc.id,
        sourceType: 'clashfinder',
        sourceUrl: publicUrl,
        name: a.name,
        quotedSpan: a.name,
        evidence: 'crowd',
        day: festivalDay(a.start),
        stage: a.stage,
        startTime: a.start,
        endTime: a.end,
        extractor: 'clashfinder',
        extractorVersion: VERSION,
      }),
    );
    result.notes.push(`Clashfinder: ${result.performers.length} sets in "${slug}".`);
    return result;
  },
};
