import { randomUUID } from 'node:crypto';
import { createLookup, InputError, PipelineDeps } from '../lineup/pipeline';
import { LookupJob } from '../lineup/types';
import { normalizeName } from '../lineup/text';
import { parseEventInput } from './parse';
import { isBilling } from '../lineup/billing';
import { EVENT_FIELDS, EventField, EventKind, LineupSummary, LoggedEvent, SeenAct } from './types';

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
  return {
    id: randomUUID(),
    input,
    ...parsed,
    name: parsed.name || input,
    sources,
    details: { status: 'pending', candidates: [], notes: [] },
    seen: [],
    daysAttended: [],
    companions: [],
    createdAt: iso,
    updatedAt: iso,
  };
}

export interface EventPatch {
  name?: string;
  year?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  venue?: string | null;
  city?: string | null;
  country?: string | null;
  seen?: Array<{ name: string; from?: SeenAct['from']; role?: SeenAct['role'] | null; roleFrom?: SeenAct['roleFrom']; favourite?: boolean }>;
  kind?: EventKind | null; // null: worked out by the rule again
  format?: string | null;
  daysAttended?: string[];
  companions?: string[];
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
  if (patch.seen) next.seen = cleanSeen(patch.seen);
  if (patch.kind !== undefined) {
    if (patch.kind !== null && patch.kind !== 'concert' && patch.kind !== 'festival') throw new InputError('Type is concert or festival.');
    next.kind = patch.kind ?? undefined;
  }
  if (patch.format !== undefined) next.format = text(patch.format);
  if (patch.daysAttended) next.daysAttended = patch.daysAttended.filter((d) => DATE.test(d));
  if (patch.companions) next.companions = [...new Set(patch.companions.map((c) => c.trim()).filter(Boolean))];
  if (patch.rating !== undefined) {
    const r = patch.rating === null ? undefined : Number(patch.rating);
    if (r !== undefined && (!Number.isInteger(r) || r < 1 || r > 5)) throw new InputError('Rating is 1 to 5.');
    next.rating = r;
  }
  if (patch.ticketPrice !== undefined) {
    const p = patch.ticketPrice === null ? undefined : Number(patch.ticketPrice);
    if (p !== undefined && (!Number.isFinite(p) || p < 0)) throw new InputError('Ticket price must be a positive number.');
    next.ticketPrice = p;
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
// Only the first act marked favourite keeps the mark.
function cleanSeen(list: NonNullable<EventPatch['seen']>): SeenAct[] {
  const out = new Map<string, SeenAct>();
  let favourite = false;
  for (const s of list) {
    const name = text(s.name);
    const key = name && normalizeName(name);
    if (!key || out.has(key)) continue;
    const act: SeenAct = { key, name: name!, from: s.from === 'lineup' ? 'lineup' : 'you' };
    if (isBilling(s.role)) {
      act.role = s.role;
      act.roleFrom = s.roleFrom === 'lineup' ? 'lineup' : 'you';
    }
    if (s.favourite === true && !favourite) favourite = act.favourite = true;
    out.set(key, act);
  }
  return [...out.values()];
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
      city: event.city,
      country: event.country,
      lineupUrl: text(lineupUrl),
    },
    { eventId: event.id },
  );
  const updated = { ...event, lineupJobId: job.id, updatedAt: deps.now().toISOString() };
  await deps.store.putEvent(updated);
  return { event: updated, job };
}

export const MAX_BULK_LOOKUPS = 50;

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
