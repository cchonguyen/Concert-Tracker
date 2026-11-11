import { randomUUID } from 'node:crypto';
import { createLookup, InputError, PipelineDeps } from '../lineup/pipeline';
import { Edition, LookupJob } from '../lineup/types';
import { normalizeName } from '../lineup/text';
import { parseEventInput } from './parse';
import { isBilling } from '../lineup/billing';
import { EVENT_FIELDS, EventField, EventKind, LineupSummary, LoggedEvent, SeenAct } from './types';
import { isSetKind, SeenInput, withB2b } from './seen';
import { cityWithRegion, regionCode, regionCountry, splitEventCity } from './regions';
import { isAhead, isAttendance } from './attendance';

// Your event log. Stage 1 (capture and details) lives here; stage 2 hands the
// event to the lineup pipeline. See REQUIREMENTS.md.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

// Stage 1, step 1: store the line you typed, split into fields, right away.
export function newEvent(line: string, now: Date): LoggedEvent {
  const input = line.replace(/\s+/g, ' ').trim();
  if (!input) throw new InputError('Type what you went to, for example "Porter Robinson at the Greek, Oct 5 2024".');
  const parsed = parseEventInput(input);
  const sources: LoggedEvent['sources'] = {};
  for (const f of EVENT_FIELDS) if (parsed[f as keyof typeof parsed]) sources[f] = { sourceType: 'user' };
  const iso = now.toISOString();
  return splitEventCity({
    id: randomUUID(),
    input,
    ...parsed,
    name: parsed.name || input,
    // Still ahead: counted once you say you went.
    ...(isAhead(parsed, iso.slice(0, 10)) ? { attendance: 'planned' as const } : {}),
    sources,
    details: { status: 'pending', candidates: [], notes: [] },
    seen: [],
    daysAttended: [],
    companions: [],
    createdAt: iso,
    updatedAt: iso,
  });
}

// Stage 1 from a confirmed canonical edition, when you tap its suggestion.
// Starts from newEvent, then copies only the edition's known facts, each sourced
// 'edition' and linked by editionId. Missing facts stay missing. Nothing personal
// is copied: seen, companions, rating, price, notes, format, series and kind stay empty.
const EDITION_FIELDS = ['startDate', 'endDate', 'venue', 'city', 'country'] as const;

export function newEventFromEdition(line: string, edition: Edition, now: Date): LoggedEvent {
  const base = newEvent(line, now);
  const sources: LoggedEvent['sources'] = { ...base.sources };
  const next: LoggedEvent = {
    ...base,
    name: edition.name,
    year: edition.year,
    sources,
    editionId: edition.id,
    details: { status: 'matched', candidates: [], notes: [] },
  };
  if (edition.startDate) {
    next.startDate = edition.startDate;
    next.month = undefined;
  }
  for (const f of EDITION_FIELDS) {
    const value = edition[f];
    if (!value) continue;
    next[f] = value;
    sources[f] = { sourceType: 'edition', editionId: edition.id };
  }
  // Same planned rule as newEvent: a date still ahead waits for you to say you went.
  const { attendance: _previous, ...rest } = next;
  const today = now.toISOString().slice(0, 10);
  const dated = isAhead(rest, today) ? { ...rest, attendance: 'planned' as const } : rest;
  return splitEventCity(dated);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EventPatch {
  name?: string;
  year?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  venue?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  seen?: SeenInput[];
  kind?: EventKind | null; // null: worked out by the rule again
  format?: string | null;
  series?: string | null;
  weekend?: number | null;
  attendance?: 'planned' | 'missed' | null; // null: you went
  daysAttended?: string[];
  companions?: string[];
  personIds?: string[]; // vault on: the people by record id (names are encrypted)
  rating?: number | null;
  ticketPrice?: number | null;
  notes?: string | null;
}

// Edits from you. Every field you set becomes a "you" source; null clears it.
export function applyPatch(event: LoggedEvent, patch: EventPatch, now: Date): LoggedEvent {
  const next: LoggedEvent = { ...event, sources: { ...event.sources } };
  if (patch.name !== undefined) {
    const name = text(patch.name);
    if (!name) throw new InputError('An event needs a name.');
    next.name = name;
  }
  for (const f of EVENT_FIELDS) {
    if (!(f in patch)) continue;
    const raw = patch[f];
    const value = text(raw);
    if (value && (f === 'startDate' || f === 'endDate') && !DATE.test(value)) throw new InputError(`${f} must be YYYY-MM-DD.`);
    setField(next, f, value);
  }
  // "Las Vegas, NV" typed in the city box fills the state too. A US or
  // Canadian state you type fills the country when none is stored.
  let placed = 'city' in patch ? splitEventCity(next, true) : next;
  const code = regionCode(placed.region);
  if ('region' in patch && code && !placed.country) {
    placed = { ...placed, country: regionCountry(code), sources: { ...placed.sources, country: { sourceType: 'user' } } };
  }
  Object.assign(next, placed);
  if (next.startDate) {
    next.year = Number(next.startDate.slice(0, 4));
    next.month = undefined;
  } else if (patch.year !== undefined) {
    const y = patch.year === null ? undefined : Number(patch.year);
    if (y !== undefined && (!Number.isInteger(y) || y < 1950 || y > 2100)) throw new InputError('A four-digit year is required.');
    next.year = y;
    next.month = undefined;
  }
  if (next.endDate && (!next.startDate || next.endDate < next.startDate)) setField(next, 'endDate', undefined);
  if (patch.attendance !== undefined) {
    if (patch.attendance !== null && !isAttendance(patch.attendance)) throw new InputError('Attendance is planned, missed, or null for went.');
    next.attendance = patch.attendance ?? undefined;
  } else if (!next.attendance && ('startDate' in patch || 'endDate' in patch || 'year' in patch) && isAhead(next, now.toISOString().slice(0, 10))) {
    // Moved to a date still ahead (or saved from a list with one): you
    // can't have been yet, so it waits for you to say you went.
    next.attendance = 'planned';
  }
  if (patch.seen) next.seen = cleanSeen(patch.seen);
  if (patch.kind !== undefined) {
    if (patch.kind !== null && patch.kind !== 'concert' && patch.kind !== 'festival') throw new InputError('Type is concert or festival.');
    next.kind = patch.kind ?? undefined;
  }
  if (patch.format !== undefined) next.format = text(patch.format);
  if (patch.series !== undefined) next.series = text(patch.series)?.replace(/\s+/g, ' ');
  if (patch.weekend !== undefined) {
    const w = patch.weekend === null ? undefined : Number(patch.weekend);
    if (w !== undefined && (!Number.isInteger(w) || w < 1 || w > 9)) throw new InputError('Weekend is a number from 1 to 9.');
    next.weekend = w;
  }
  if (patch.daysAttended) next.daysAttended = patch.daysAttended.filter((d) => DATE.test(d));
  if (patch.companions) next.companions = [...new Set(patch.companions.map((c) => c.trim()).filter(Boolean))];
  if (patch.personIds) next.personIds = [...new Set(patch.personIds.filter((id) => typeof id === 'string' && UUID.test(id)))];
  if (patch.rating !== undefined) {
    const r = patch.rating === null ? undefined : Number(patch.rating);
    if (r !== undefined && (!Number.isInteger(r) || r < 1 || r > 5)) throw new InputError('Rating is 1 to 5.');
    next.rating = r;
  }
  if (patch.ticketPrice !== undefined) {
    const p = patch.ticketPrice === null ? undefined : Number(patch.ticketPrice);
    if (p !== undefined && (!Number.isFinite(p) || p < 0)) throw new InputError('Ticket price must be a positive number.');
    next.ticketPrice = p;
    // Yours, even cleared: an email's price never fills it again.
    next.sources.ticketPrice = { sourceType: 'user' };
  }
  if (patch.notes !== undefined) next.notes = text(patch.notes);
  next.updatedAt = now.toISOString();
  return next;
}

function setField(ev: LoggedEvent, f: EventField, value: string | undefined): void {
  ev[f] = value;
  if (value) ev.sources[f] = { sourceType: 'user' };
  else delete ev.sources[f];
}

// A role you set is yours unless it is the lineup's role sent back unchanged.
// Favourite set marks are yours. DJ set, live set and
// B2B are yours; a B2B partner must be another act on this event.
function cleanSeen(list: NonNullable<EventPatch['seen']>): SeenAct[] {
  const out = new Map<string, SeenAct>();
  for (const s of list) {
    const name = text(s.name);
    const key = name && normalizeName(name);
    if (!key) continue;
    const actKey = s.id ?? (s.slotId ? `${key}:${s.slotId}` : (s.b2b?.length ? `${key}:b2b:${s.b2b.slice().sort().join('+')}` : key));
    if (out.has(actKey)) continue;
    const act: SeenAct = { key, name: name!, from: s.from === 'lineup' ? 'lineup' : 'you' };
    if (s.id) act.id = s.id;
    if (s.slotId) act.slotId = s.slotId;
    if (s.alias) act.alias = text(s.alias);
    if (isBilling(s.role)) {
      act.role = s.role;
      act.roleFrom = s.roleFrom === 'lineup' ? 'lineup' : 'you';
    }
    if (s.favourite === true) act.favourite = true;
    if (isSetKind(s.set)) act.set = s.set;
    if (Array.isArray(s.b2b)) act.b2b = s.b2b.map((k) => normalizeName(String(k))).filter((k) => k && k !== key);
    if (s.solo === true) act.solo = true;
    if (s.solo === true && isSetKind(s.soloSet)) act.soloSet = s.soloSet;
    out.set(actKey, act);
  }
  return withB2b([...out.values()]);
}

// Stage 2: a lineup lookup built from the event's own facts.
export async function startLineupLookup(
  deps: PipelineDeps,
  event: LoggedEvent,
  lineupUrl?: string,
): Promise<{ event: LoggedEvent; job: LookupJob }> {
  const year = event.year ?? (event.startDate ? Number(event.startDate.slice(0, 4)) : undefined);
  if (!year) throw new InputError('Add when it was (a year is enough) before looking up the lineup.');
  const job = await createLookup(
    deps,
    {
      eventName: event.name,
      year,
      startDate: event.startDate,
      endDate: event.endDate,
      venue: event.venue,
      city: cityWithRegion(event.city, event.region),
      country: event.country,
      lineupUrl: text(lineupUrl),
    },
    { eventId: event.id },
  );
  const updated = { ...event, lineupJobId: job.id, updatedAt: deps.now().toISOString() };
  await deps.store.putEvent(updated);
  return { event: updated, job };
}

// Per request. Each lookup queued costs several database calls and a
// Cloudflare Worker request may make 50, so the Table sends a few at a time.
export const MAX_BULK_LOOKUPS = 5;

export interface BulkLookupResult {
  started: string[]; // event ids
  skipped: Array<{ id: string; reason: string }>;
}

// "Find lineups for all": a lookup for each event that has a year and no
// lineup yet. Jobs are only queued; the worker runs them one at a time, so a
// batch never bursts past the sources' limits, and quota parks them as usual.
export async function startBulkLookups(deps: PipelineDeps, ids: string[]): Promise<BulkLookupResult> {
  const result: BulkLookupResult = { started: [], skipped: [] };
  const unique = [...new Set(ids)];
  if (unique.length > MAX_BULK_LOOKUPS) throw new InputError(`At most ${MAX_BULK_LOOKUPS} events at a time.`);
  for (const id of unique) {
    const event = await deps.store.getEvent(id);
    if (!event) {
      result.skipped.push({ id, reason: 'not found' });
      continue;
    }
    if (event.editionId) {
      result.skipped.push({ id, reason: 'lineup already confirmed' });
      continue;
    }
    if (!event.year && !event.startDate) {
      result.skipped.push({ id, reason: 'no date' });
      continue;
    }
    const job = event.lineupJobId ? await deps.store.getJob(event.lineupJobId) : null;
    if (job && job.status !== 'failed') {
      result.skipped.push({ id, reason: `lookup ${job.status.replace('_', ' ')}` });
      continue;
    }
    await startLineupLookup(deps, event);
    result.started.push(id);
  }
  return result;
}

export function lineupSummary(job: LookupJob): LineupSummary {
  return {
    jobId: job.id,
    status: job.status,
    actCount: job.candidate?.performers.length ?? 0,
    waitingReason: job.waitingReason,
    nextAttemptAt: job.nextAttemptAt,
  };
}

// Newest first; events without any date first of all, since they need one.
export function sortEvents(events: LoggedEvent[]): LoggedEvent[] {
  const when = (e: LoggedEvent) => e.startDate ?? (e.year ? `${e.year}-${String(e.month ?? 12).padStart(2, '0')}-99` : '9999');
  return [...events].sort((a, b) => when(b).localeCompare(when(a)) || b.createdAt.localeCompare(a.createdAt));
}
