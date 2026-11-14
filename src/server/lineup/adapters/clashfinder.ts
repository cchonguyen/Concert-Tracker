import { AdapterContext, AdapterResult, FetchResponse, NewPerformerClaim, SourceAdapter } from '../types';
import { HttpError, parseJson } from '../http';
import { normalizeName, sha256 } from '../text';
import { isNonMusicProgramming, isSilentDiscoSlot } from '../actName';
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
  isPrivate?: boolean;
  edits?: number;
  numActs?: number;
  lastEdit?: string; // "2026-10-17 10:37", from the list's lastEdit or modified field
}

// Clashfinder dates are Unix seconds; older formats used ISO strings.
function toIsoDate(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return new Date(v > 1e11 ? v : v * 1000).toISOString().slice(0, 10);
  }
  if (typeof v === 'string' && /^\d+$/.test(v)) return toIsoDate(Number(v));
  return typeof v === 'string' ? v : undefined;
}

// The list is an object keyed by slug. In it, "name" repeats the slug and the
// readable title is "desc" (e.g. "EDC Las Vegas 2026"); startDate is Unix
// seconds. Older array formats are still accepted.
export function parseEventList(json: unknown): EventListEntry[] {
  const out: EventListEntry[] = [];
  const read = (slug: unknown, v: any) => {
    const title = [v?.desc, v?.title, v?.fullName, v?.name].find((t) => typeof t === 'string' && t.trim() && t !== slug);
    const name = title ?? v?.name;
    if (typeof slug === 'string' && typeof name === 'string') {
      out.push({
        slug,
        name,
        startDate: toIsoDate(v?.startDate ?? v?.start ?? v?.date),
        isPrivate: Boolean(v?.private),
        edits: typeof v?.edits === 'number' ? v.edits : undefined,
        numActs: typeof v?.numActs === 'number' ? v.numActs : undefined,
        lastEdit: typeof (v?.lastEdit ?? v?.modified) === 'string' ? (v.lastEdit ?? v.modified) : undefined,
      });
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

// Clashfinder holds user-made "fantasy" or predicted lineups next to the real
// ones. Those are guesses, so they are never used as evidence.
const SPECULATIVE = /\b(fantasy|prediction|predicted|predictions|guess|guesses|wishlist)\b/i;

export const FESTIVAL_STOPWORDS = /\b(music|festival|arts|annual)\b/gi;
const STOPWORDS_COMPOUND = /\b(music|festival|arts|annual)(\s+(?:and|&)\s+(?:music|festival|arts|annual))*\b/gi;
export const WEEKEND_PATTERN = /\b(?:weekend|wknd)[\s-]*\d+\b|(?:^|[\s_/-]|\d)w[\s-]*\d+(?![a-z0-9])/gi;

export function stripStopwords(text: string): string {
  return text.replace(STOPWORDS_COMPOUND, ' ').replace(FESTIVAL_STOPWORDS, ' ');
}

export function weekendFromName(text: string): number | null {
  if (!text) return null;
  const m1 = text.match(/\b(?:weekend|wknd)[\s-]*(\d+)\b/i);
  if (m1) return Number(m1[1]);
  const m2 = text.match(/(?:^|[\s_/-]|\d)w[\s-]*(\d+)(?![a-z0-9])/i);
  if (m2) return Number(m2[1]);
  return null;
}

export function daysBetween(a: string, b: string): number {
  const dateA = a.slice(0, 10);
  const dateB = b.slice(0, 10);
  const msA = Date.parse(`${dateA}T00:00:00Z`);
  const msB = Date.parse(`${dateB}T00:00:00Z`);
  if (Number.isNaN(msA) || Number.isNaN(msB)) return Infinity;
  return Math.abs(Math.round((msA - msB) / 86_400_000));
}

// Several slugs often exist for one edition (edc2026, edclv2026, a livestream
// schedule...). Candidates must match every word of the event name in the
// title, or start the slug with those words run together, and fall in the
// year. Among them the most-edited public clash wins, as the crowd's choice.
// When an event date or weekend is known, date-window proximity and matching
// weekend tokens disambiguate multi-weekend festivals (e.g. Coachella W1 vs W2).
export function rankEditions(
  entries: EventListEntry[],
  eventName: string,
  year: number,
  targetStartDateOrOptions?: string | { startDate?: string },
): EventListEntry[] {
  const targetStartDate =
    typeof targetStartDateOrOptions === 'string'
      ? targetStartDateOrOptions
      : targetStartDateOrOptions?.startDate;
  const targetWeekend = weekendFromName(eventName);

  const stripped = stripStopwords(eventName.replace(/\b(19|20)\d{2}\b/g, ' '))
    .replace(WEEKEND_PATTERN, ' ');
  let wanted = normalizeName(stripped).split(' ').filter(Boolean);
  if (!wanted.length) {
    wanted = normalizeName(eventName.replace(/\b(19|20)\d{2}\b/g, ' ')).split(' ').filter(Boolean);
  }
  if (!wanted.length) return [];
  const joined = wanted.join('');
  const yy = String(year).slice(2);
  const candidates: { entry: EventListEntry; tier: number; recency: number; edits: number; shape: number }[] = [];
  for (const entry of entries) {
    if (entry.isPrivate || SPECULATIVE.test(entry.name) || SPECULATIVE.test(entry.slug) || entry.numActs === 0) continue;

    const entryWeekend = weekendFromName(entry.name) ?? weekendFromName(entry.slug);
    if (targetWeekend !== null && entryWeekend !== null && entryWeekend !== targetWeekend) {
      continue;
    }

    const name = normalizeName(entry.name);
    const cleanEntryName = normalizeName(stripStopwords(entry.name));
    const titleHit = wanted.every((w) => ` ${name} `.includes(` ${w} `) || ` ${cleanEntryName} `.includes(` ${w} `));
    const slugHit = entry.slug.toLowerCase().startsWith(joined);
    if (!titleHit && !slugHit) continue;
    const yearHit = entry.startDate
      ? entry.startDate.startsWith(String(year))
      : name.includes(String(year)) || new RegExp(`(^|[^0-9])(${year}|${yy})$`).test(entry.slug);
    if (!yearHit) continue;
    // Edition fit first (title, date window, weekend). Recency only breaks ties
    // between clashes that fit equally well.
    const tier =
      (titleHit ? 1_000_000 : 0) +
      (targetStartDate && entry.startDate && daysBetween(entry.startDate, targetStartDate) <= 2 ? 500_000 : 0) +
      (targetWeekend !== null && entryWeekend === targetWeekend ? 500_000 : 0);
    // Last resort: acts listed, then the closest name length (as before).
    const shape =
      Math.min(entry.numActs ?? 0, 9) -
      Math.abs(cleanEntryName.replace(/\b(19|20)\d{2}\b/g, ' ').trim().length - wanted.join(' ').length) / 1000;
    candidates.push({ entry, tier, recency: recencyMs(entry.lastEdit), edits: entry.edits ?? 0, shape });
  }
  candidates.sort(
    (a, b) => b.tier - a.tier || b.recency - a.recency || b.edits - a.edits || b.shape - a.shape,
  );
  return candidates.map((c) => c.entry);
}

// Most recently edited wins the automatic pick. Clashfinder's list dates read
// "2026-10-17 10:37"; they are compared as written. No date sorts last.
export function recencyMs(lastEdit: string | undefined): number {
  if (!lastEdit) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(`${lastEdit.trim().replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

// The automatic pick: the top-ranked public clash, or null.
export function matchEdition(
  entries: EventListEntry[],
  eventName: string,
  year: number,
  targetStartDateOrOptions?: string | { startDate?: string },
): EventListEntry | null {
  return rankEditions(entries, eventName, year, targetStartDateOrOptions)[0] ?? null;
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
        const trimmed = ev.name.trim();
        if (isNonMusicProgramming(trimmed) || isSilentDiscoSlot(trimmed)) continue;
        acts.push({ name: trimmed, start: ev.start, end: ev.end, stage: loc?.name });
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
      const match = matchEdition(parseEventList(parseJson(res)), ctx.input.eventName, ctx.input.year, ctx.input.startDate);
      if (!match) {
        result.notes.push('Clashfinder: no matching edition in the event list.');
        return result;
      }
      slug = match.slug;
      result.notes.push(`Clashfinder: matched "${match.name}" (${slug}).`);
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

export interface ClashfinderCandidate {
  slug: string;
  name: string;
  startDate?: string;
  lastEdit?: string;
  edits?: number;
  numActs?: number;
  url: string;
}

// Every public clash that matches the event, best first (the automatic pick is
// the first). One list call, the same one the automatic pick makes.
export async function clashfinderCandidates(
  fetcher: AdapterContext['fetcher'],
  input: { eventName: string; year: number; startDate?: string },
): Promise<ClashfinderCandidate[]> {
  const auth = clashfinderAuthQuery();
  if (!auth) return [];
  const listUrl = `${BASE}/data/events/all.json?${auth}`;
  const res = await fetcher.get(listUrl);
  if (res.status === 401) throw new HttpError(401, listUrl, 'Clashfinder rejected the credentials (401). Check CLASHFINDER_* settings.');
  return rankEditions(parseEventList(listJson(res, listUrl)), input.eventName, input.year, input.startDate).map((e) => ({
    slug: e.slug,
    name: e.name,
    startDate: e.startDate,
    lastEdit: e.lastEdit,
    edits: e.edits,
    numActs: e.numActs,
    url: `${BASE}/s/${e.slug}/`,
  }));
}

// Parses the list reply. A 2xx reply that is not JSON gives the reason and the
// start of the reply, so the cause shows on screen. Only the first 120
// characters of the reply are kept, and the URL is already redacted.
export function listJson(res: FetchResponse, listUrl: string): unknown {
  try {
    return parseJson(res);
  } catch {
    const snippet = String(res.body ?? '').slice(0, 120).replace(/\s+/g, ' ').trim();
    throw new HttpError(
      res.status,
      listUrl,
      `Clashfinder sent a reply that is not JSON (HTTP ${res.status})${snippet ? `: "${snippet}"` : ' with an empty body'}.`,
    );
  }
}
