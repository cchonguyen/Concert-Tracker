import { randomUUID } from 'node:crypto';
import { EditionOccurrenceConflictError, isVerifiedStatus, LineupStore, MergeSummary } from './store/types';
import { Edition, EditionHeader, EditionPerformance, EditionWeekend } from './types';
import { isBilling, Billing } from './billing';
import { normalizeName, seriesSlugFor } from './text';
import { writeEdition } from '../canon/editions';

// Canonical confirm (spec Phase 2a). The owner curates an edition directly.
// It writes only the shared catalog (event_editions, performances,
// canonical_artists, series) and never touches any member's logged_events.
//
// Admin curation is a source (owner decision, 2026-11-03). Each act is
// recorded with the existing 'user' source type; a weblink is optional and
// recommended, never required.

export class CanonicalInputError extends Error {}

export interface CanonicalPerformerInput {
  name: string;
  accepted?: boolean; // default true; false ignores the act (never removes one)
  billing?: Billing;
  days?: string[];
  stages?: string[];
  set?: string;
  oneAct?: boolean; // kept whole by the owner: not split on B2B marks
  sourceUrl?: string; // optional weblink
}

export interface CanonicalConfirmInput {
  editionId?: string;
  seriesSlug?: string | null;
  name: string;
  year: number;
  startDate?: string;
  endDate?: string;
  venue?: string;
  city?: string;
  country?: string;
  performers: CanonicalPerformerInput[];
  apply?: boolean; // false (default) returns the diff only; true writes it
  jobId?: string; // the lookup being reviewed; a successful apply marks it confirmed
}

export interface CanonicalDiff {
  editionKey: string;
  added: string[];
  changed: string[];
  unchanged: string[];
  // Facts the edition already has with a different value. Not overwritten.
  factConflicts: Array<{ field: string; stored: string; sent: string }>;
  filledFacts: string[];
}

export interface CanonicalConfirmResult {
  applied: boolean;
  diff: CanonicalDiff;
  edition?: Edition;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, field: string, max = 200): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new CanonicalInputError(`${field} must be text.`);
  const t = v.trim();
  if (t.length > max) throw new CanonicalInputError(`${field} is too long.`);
  return t || undefined;
};

// Validates the request. Nothing is defaulted or inferred: a missing field stays missing.
export function parseCanonicalInput(body: unknown): CanonicalConfirmInput {
  if (!body || typeof body !== 'object') throw new CanonicalInputError('Send a JSON body.');
  const b = body as Record<string, unknown>;
  const name = str(b.name, 'name');
  if (!name) throw new CanonicalInputError('An edition needs a name.');
  const editionId = str(b.editionId, 'editionId', 100);
  const seriesSlug = b.seriesSlug === undefined ? undefined : (str(b.seriesSlug, 'seriesSlug', 120) ?? null);
  const jobId = str(b.jobId, 'jobId', 100);
  if (typeof b.year !== 'number' || !Number.isInteger(b.year) || b.year < 1900 || b.year > 2100) {
    throw new CanonicalInputError('year must be a whole number from 1900 to 2100.');
  }
  for (const f of ['startDate', 'endDate'] as const) {
    if (b[f] !== undefined && b[f] !== null && b[f] !== '' && (typeof b[f] !== 'string' || !DATE.test(b[f] as string))) {
      throw new CanonicalInputError(`${f} must be YYYY-MM-DD.`);
    }
  }
  if (!Array.isArray(b.performers)) throw new CanonicalInputError('performers must be a list.');
  const performers: CanonicalPerformerInput[] = b.performers.map((raw, i) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const pname = str(p.name, `performers[${i}].name`);
    if (!pname) throw new CanonicalInputError(`performers[${i}] needs a name.`);
    if (p.billing !== undefined && p.billing !== null && !isBilling(p.billing)) {
      throw new CanonicalInputError(`performers[${i}].billing must be headliner or support.`);
    }
    const list = (v: unknown, f: string) => {
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new CanonicalInputError(`${f} must be a list of text.`);
      return v.map((x) => x.trim()).filter(Boolean);
    };
    return {
      name: pname,
      accepted: p.accepted === undefined ? true : p.accepted === true,
      billing: isBilling(p.billing) ? p.billing : undefined,
      days: list(p.days, `performers[${i}].days`),
      stages: list(p.stages, `performers[${i}].stages`),
      set: str(p.set, `performers[${i}].set`, 60),
      oneAct: p.oneAct === true ? true : undefined,
      sourceUrl: str(p.sourceUrl, `performers[${i}].sourceUrl`, 2000),
    };
  });
  return {
    ...(editionId ? { editionId } : {}),
    ...(seriesSlug !== undefined ? { seriesSlug } : {}),
    name,
    year: b.year,
    startDate: (str(b.startDate, 'startDate') as string | undefined) || undefined,
    endDate: (str(b.endDate, 'endDate') as string | undefined) || undefined,
    venue: str(b.venue, 'venue'),
    city: str(b.city, 'city'),
    country: str(b.country, 'country', 80),
    performers,
    apply: b.apply === true,
    jobId,
  };
}

const actFromInput = (p: CanonicalPerformerInput): EditionPerformance => ({
  artistKey: normalizeName(p.name),
  name: p.name,
  days: p.days ?? [],
  stages: p.stages ?? [],
  set: p.set,
  status: 'billed',
  billing: p.billing,
  ...(p.oneAct ? { oneAct: true } : {}),
  // Owner-reviewed: no computed score yet, so 1 marks "reviewed by the owner".
  confidence: 1,
  sources: [
    {
      sourceType: 'user',
      sourceUrl: p.sourceUrl ?? '',
      quotedSpan: '',
      evidence: 'billed',
      extractor: 'admin_curation',
    },
  ],
});

const sameAct = (a: EditionPerformance, b: EditionPerformance) =>
  a.name === b.name &&
  Boolean(a.oneAct) === Boolean(b.oneAct) &&
  a.billing === b.billing &&
  a.set === b.set &&
  JSON.stringify(a.days) === JSON.stringify(b.days) &&
  JSON.stringify(a.stages) === JSON.stringify(b.stages);

// Stored sources stay with the act; the owner's curation source is added only if the act has none yet.
const keepSources = (prev: EditionPerformance, act: EditionPerformance) =>
  prev.sources.some((s) => s.extractor === 'admin_curation') ? prev.sources : [...prev.sources, ...act.sources];

// Merges the request into the stored edition. Stored acts are kept unless the
// request names them; changed acts take the request's values on apply.
// Blank facts are filled; differing facts are reported, never overwritten.
export async function confirmCanonicalEdition(store: LineupStore, input: CanonicalConfirmInput, now = new Date().toISOString()): Promise<CanonicalConfirmResult> {
  const slug = seriesSlugFor(input.name);
  if (!slug) throw new CanonicalInputError('The name has no letters or digits to make a series from.');
  const fallbackKey = `${slug}/${input.startDate ?? input.year}`;
  const existing = (input.editionId ? await store.getEdition(input.editionId) : null) ?? (await store.getEditionByKey(fallbackKey));
  const editionKey = existing?.key ?? fallbackKey;

  let resolvedSeriesSlug = existing?.seriesSlug;
  if (input.seriesSlug !== undefined) {
    if (input.seriesSlug === null || input.seriesSlug === '') {
      resolvedSeriesSlug = undefined;
    } else {
      const series = await store.getSeries(input.seriesSlug);
      if (!series) throw new CanonicalInputError(`Series "${input.seriesSlug}" not found.`);
      resolvedSeriesSlug = series.slug;
    }
  }

  const byKey = new Map<string, EditionPerformance>((existing?.performances ?? []).map((p) => [p.artistKey, p]));
  const diff: CanonicalDiff = { editionKey, added: [], changed: [], unchanged: [], factConflicts: [], filledFacts: [] };
  for (const p of input.performers) {
    if (!p.accepted) continue;
    const act = actFromInput(p);
    const prev = byKey.get(act.artistKey);
    if (!prev) diff.added.push(p.name);
    else if (sameAct(prev, act)) diff.unchanged.push(p.name);
    else diff.changed.push(p.name);
    // A changed act keeps the sources it was stored with (its quotes); the owner's source is added once.
    if (!prev) byKey.set(act.artistKey, act);
    else if (!sameAct(prev, act)) byKey.set(act.artistKey, { ...act, sources: keepSources(prev, act) });
  }

  const facts: Record<'name' | 'startDate' | 'endDate' | 'venue' | 'city' | 'country', string | undefined> = {
    name: input.name,
    startDate: input.startDate,
    endDate: input.endDate,
    venue: input.venue,
    city: input.city,
    country: input.country,
  };
  const merged: Record<string, string | undefined> = {
    name: existing?.name,
    startDate: existing?.startDate,
    endDate: existing?.endDate,
    venue: existing?.venue,
    city: existing?.city,
    country: existing?.country,
  };
  for (const f of Object.keys(facts) as Array<keyof typeof facts>) {
    const sent = facts[f];
    if (!sent) continue;
    const stored = merged[f];
    if (!stored) {
      merged[f] = sent;
      diff.filledFacts.push(f);
    } else if (stored !== sent) {
      diff.factConflicts.push({ field: f, stored, sent });
    }
  }

  const edition: Edition = {
    ...(existing ?? {}),
    id: existing?.id ?? randomUUID(),
    key: editionKey,
    year: input.year,
    name: merged.name ?? input.name,
    startDate: merged.startDate,
    endDate: merged.endDate,
    venue: merged.venue,
    city: merged.city,
    country: merged.country,
    status: 'verified',
    performances: [...byKey.values()],
    confirmedAt: now,
    updatedAt: now,
    // A re-confirm keeps the owner's fact source note; it is not part of the lineup.
    factSourceNote: existing?.factSourceNote,
  };
  if (resolvedSeriesSlug) {
    edition.seriesSlug = resolvedSeriesSlug;
  } else {
    delete edition.seriesSlug;
    delete edition.seriesName;
    delete edition.seriesBrand;
    delete edition.seriesAliases;
  }

  if (!input.apply) return { applied: false, diff };

  await store.ensureArtists(edition.performances.map((p) => ({ key: p.artistKey, name: p.name })));
  await writeEdition(store, { edition, actor: 'system:ingest', reason: 'canonical ingest' });

  // Close the lookup that fed this edition, so its line leaves "Review". Only a catalog
  // lookup (no saved event) is touched; a personal lookup is closed by its own confirm.
  if (input.jobId) {
    const job = await store.getJob(input.jobId);
    if (job && !job.eventId && job.status === 'needs_review') {
      job.status = 'confirmed';
      job.editionId = edition.id;
      job.updatedAt = now;
      job.log = [...job.log, { at: now, message: `Confirmed ${edition.performances.length} act(s) into the shared catalog.` }];
      await store.updateJob(job);
    }
  }
  return { applied: true, diff, edition: (await store.getEdition(edition.id)) ?? edition };
}

// Edition facts (GA4). The owner edits name, dates, venue and city with a source note.
// The form sends all four facts: a blank one is stored as blank (null), never defaulted.
// The note is required and stored on the edition. Acts, the key and status do not change here.
export interface EditionFactsInput {
  name: string;
  startDate: string | null;
  endDate: string | null;
  venue: string | null;
  city: string | null;
  region?: string | null;
  country?: string | null;
  seriesSlug?: string | null;
  weekends?: EditionWeekend[];
  sourceNote: string;
}

export class EditionNotFoundError extends Error {}

function parseWeekends(raw: unknown): EditionWeekend[] {
  if (!Array.isArray(raw)) throw new CanonicalInputError('weekends must be a list.');
  const seen = new Set<number>();
  const out: EditionWeekend[] = raw.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new CanonicalInputError(`weekends[${idx}] must be an object.`);
    }
    const w = item as Record<string, unknown>;
    if (typeof w.weekend !== 'number' || !Number.isInteger(w.weekend) || w.weekend < 1 || w.weekend > 9) {
      throw new CanonicalInputError(`weekends[${idx}].weekend must be a whole number from 1 to 9.`);
    }
    if (seen.has(w.weekend)) {
      throw new CanonicalInputError(`Duplicate weekend number ${w.weekend}.`);
    }
    seen.add(w.weekend);
    if (typeof w.startDate !== 'string' || !DATE.test(w.startDate.trim())) {
      throw new CanonicalInputError(`weekends[${idx}].startDate must be YYYY-MM-DD.`);
    }
    const startDate = w.startDate.trim();
    let endDate: string | undefined;
    if (w.endDate !== undefined && w.endDate !== null && w.endDate !== '') {
      if (typeof w.endDate !== 'string' || !DATE.test(w.endDate.trim())) {
        throw new CanonicalInputError(`weekends[${idx}].endDate must be YYYY-MM-DD.`);
      }
      const trimmedEnd = w.endDate.trim();
      if (trimmedEnd < startDate) {
        throw new CanonicalInputError(`weekends[${idx}].endDate cannot be before startDate.`);
      }
      if (trimmedEnd !== startDate) endDate = trimmedEnd;
    }
    return { weekend: w.weekend, startDate, ...(endDate ? { endDate } : {}) };
  });
  return out.sort((a, b) => a.weekend - b.weekend);
}

export function parseEditionFacts(body: unknown): EditionFactsInput {
  if (!body || typeof body !== 'object') throw new CanonicalInputError('Send a JSON body.');
  const b = body as Record<string, unknown>;
  const name = str(b.name, 'name');
  if (!name) throw new CanonicalInputError('An edition needs a name. Leave the name as it was rather than blank.');
  for (const f of ['startDate', 'endDate'] as const) {
    if (b[f] !== undefined && b[f] !== null && b[f] !== '' && (typeof b[f] !== 'string' || !DATE.test(b[f] as string))) {
      throw new CanonicalInputError(`${f} must be YYYY-MM-DD.`);
    }
  }
  const sourceNote = str(b.sourceNote, 'sourceNote', 500);
  if (!sourceNote) throw new CanonicalInputError('An edit to an edition fact needs a source note saying where it came from.');
  return {
    name,
    startDate: str(b.startDate, 'startDate') ?? null,
    endDate: str(b.endDate, 'endDate') ?? null,
    venue: str(b.venue, 'venue') ?? null,
    city: str(b.city, 'city') ?? null,
    ...(b.region !== undefined ? { region: str(b.region, 'region', 100) ?? null } : {}),
    ...(b.country !== undefined ? { country: str(b.country, 'country', 80) ?? null } : {}),
    ...(b.seriesSlug !== undefined ? { seriesSlug: str(b.seriesSlug, 'seriesSlug', 120) ?? null } : {}),
    ...(b.weekends !== undefined ? { weekends: parseWeekends(b.weekends) } : {}),
    sourceNote,
  };
}

// Writes the facts to the catalog edition only (event_editions). Never touches logged_events or seen.
export async function editEditionFacts(store: LineupStore, editionId: string, input: EditionFactsInput, now = new Date().toISOString()): Promise<Edition> {
  const existing = await store.getEdition(editionId);
  if (!existing) throw new EditionNotFoundError('No such edition.');
  const edition: Edition = {
    ...existing,
    name: input.name,
    startDate: input.startDate ?? undefined,
    endDate: input.endDate ?? undefined,
    venue: input.venue ?? undefined,
    city: input.city ?? undefined,
    factSourceNote: input.sourceNote,
    updatedAt: now,
  };
  if (input.region !== undefined) edition.region = input.region ?? undefined;
  if (input.country !== undefined) edition.country = input.country ?? undefined;
  if (input.seriesSlug !== undefined) {
    if (input.seriesSlug === null || input.seriesSlug === '') {
      delete edition.seriesSlug;
      delete edition.seriesName;
      delete edition.seriesBrand;
      delete edition.seriesAliases;
    } else {
      const series = await store.getSeries(input.seriesSlug);
      if (!series) throw new CanonicalInputError(`Series "${input.seriesSlug}" not found.`);
      edition.seriesSlug = series.slug;
    }
  }
  if (input.weekends !== undefined) {
    const validated = parseWeekends(input.weekends);
    if (validated.length > 0) {
      edition.weekends = validated;
      const minStart = validated.reduce((m, w) => (w.startDate < m ? w.startDate : m), validated[0].startDate);
      const maxEnd = validated.reduce((m, w) => {
        const end = w.endDate ?? w.startDate;
        return end > m ? end : m;
      }, minStart);
      edition.startDate = minStart;
      edition.endDate = maxEnd === minStart ? undefined : maxEnd;
    } else {
      delete edition.weekends;
    }
  }
  await writeEdition(store, { edition, actor: 'owner', reason: 'edition facts edited' });
  // The owner's correction of a title or venue shows in the review inbox (ids, field, old and new public value only).
  for (const field of ['name', 'venue'] as const) {
    const old = existing[field] ?? null;
    const next = edition[field] ?? null;
    if (old === null || old === next) continue;
    try {
      await store.addReviewItem({ kind: 'formatting', editionId, payload: { field, old, new: next, editionId } });
    } catch (err) {
      console.error(`editEditionFacts: formatting review row failed for ${editionId}`, err);
    }
  }
  return (await store.getEdition(editionId)) ?? edition;
}

export interface MergeCanonicalEditionsInput {
  keepId: string;
  dropIds: string[];
  factChoices?: Partial<Pick<Edition, 'name' | 'startDate' | 'endDate' | 'venue' | 'city' | 'region' | 'country' | 'seriesSlug'>>;
  combineAsWeekends?: boolean;
  reason?: string;
  actor?: string;
}

export interface MergeCanonicalEditionsResult {
  edition: Edition;
  merged: MergeSummary[];
}

type MergeFactField = 'name' | 'startDate' | 'endDate' | 'venue' | 'city' | 'region' | 'country' | 'seriesSlug';
const MERGE_FACT_FIELDS: MergeFactField[] = ['name', 'startDate', 'endDate', 'venue', 'city', 'region', 'country', 'seriesSlug'];

export async function mergeCanonicalEditions(
  store: LineupStore,
  input: MergeCanonicalEditionsInput,
  now = new Date().toISOString(),
): Promise<MergeCanonicalEditionsResult> {
  const keepId = typeof input.keepId === 'string' ? input.keepId.trim() : '';
  if (!keepId) throw new CanonicalInputError('keepId is required.');
  if (!Array.isArray(input.dropIds) || input.dropIds.length === 0) {
    throw new CanonicalInputError('Select at least one edition to merge.');
  }
  const cleanDrops = input.dropIds.map((id) => (typeof id === 'string' ? id.trim() : ''));
  if (cleanDrops.some((id) => !id)) throw new CanonicalInputError('dropIds must be non-empty ids.');
  const uniqueDropIds = [...new Set(cleanDrops)];
  if (uniqueDropIds.length !== cleanDrops.length) throw new CanonicalInputError('dropIds must be unique.');
  if (uniqueDropIds.includes(keepId)) throw new CanonicalInputError('An edition cannot be merged into itself.');

  const keep = await store.getEdition(keepId);
  if (!keep) throw new EditionNotFoundError(`Edition ${keepId} not found.`);
  const drops: Edition[] = [];
  for (const dropId of uniqueDropIds) {
    const drop = await store.getEdition(dropId);
    if (!drop) throw new EditionNotFoundError(`Edition ${dropId} not found.`);
    drops.push(drop);
  }

  const next: Edition = { ...keep, updatedAt: now };
  const choices = input.factChoices;
  if (choices?.seriesSlug !== undefined && choices.seriesSlug !== null && choices.seriesSlug !== '') {
    const series = await store.getSeries(choices.seriesSlug);
    if (!series) throw new CanonicalInputError(`Series "${choices.seriesSlug}" not found.`);
  }

  for (const field of MERGE_FACT_FIELDS) {
    const hasChoice = Boolean(choices && Object.prototype.hasOwnProperty.call(choices, field));
    const chosen = hasChoice ? choices![field] : undefined;
    if (hasChoice && chosen !== undefined) {
      if (chosen === null || chosen === '') {
        if (field === 'name') throw new CanonicalInputError('An edition needs a name.');
        delete (next as unknown as Record<string, unknown>)[field];
      } else if (typeof chosen === 'string') {
        const trimmed = chosen.trim();
        if (!trimmed) {
          if (field === 'name') throw new CanonicalInputError('An edition needs a name.');
          delete (next as unknown as Record<string, unknown>)[field];
        } else {
          (next as unknown as Record<string, unknown>)[field] = trimmed;
        }
      }
      continue;
    }
    const current = next[field];
    if (!current) {
      const donor = drops.find((d) => Boolean(d[field]));
      if (donor?.[field]) (next as unknown as Record<string, unknown>)[field] = donor[field];
    }
  }

  if (!next.seriesSlug) {
    delete next.seriesSlug;
    delete next.seriesName;
    delete next.seriesBrand;
    delete next.seriesAliases;
  }
  if (!next.venueId && (!choices?.venue || choices.venue === keep.venue)) {
    const donorVenueId = drops.find((d) => Boolean(d.venueId) && (!next.venue || d.venue === next.venue))?.venueId;
    if (donorVenueId) next.venueId = donorVenueId;
  }
  if (!next.subjectKey) {
    const donorSubject = drops.find((d) => Boolean(d.subjectKey))?.subjectKey;
    if (donorSubject) next.subjectKey = donorSubject;
  }
  if (isVerifiedStatus(keep.status) || drops.some((d) => isVerifiedStatus(d.status))) {
    next.status = 'verified';
  }

  const actor = input.actor?.trim() || 'owner';
  const reason = input.reason?.trim() || 'merged duplicate editions';

  type StampAction = { editionId: string; weekend: number };
  const stampActions: StampAction[] = [];

  if (input.combineAsWeekends) {
    const allEditions = [keep, ...drops];
    type Slot = { editionId: string; startDate: string; endDate?: string; singleSlot: boolean };
    const slots: Slot[] = [];
    for (const ed of allEditions) {
      if (ed.weekends && ed.weekends.length > 0) {
        const single = ed.weekends.length === 1;
        for (const w of ed.weekends) slots.push({ editionId: ed.id, startDate: w.startDate, endDate: w.endDate, singleSlot: single });
      } else if (ed.startDate) {
        slots.push({ editionId: ed.id, startDate: ed.startDate, endDate: ed.endDate, singleSlot: true });
      }
    }
    const distinctStarts = new Set(slots.map((s) => s.startDate));
    if (distinctStarts.size >= 2) {
      const rangeKey = (s: { startDate: string; endDate?: string }) => `${s.startDate}|${s.endDate ?? s.startDate}`;
      const uniqueRanges = new Map<string, { startDate: string; endDate?: string }>();
      const sortedSlots = [...slots].sort(
        (a, b) =>
          a.startDate.localeCompare(b.startDate) ||
          (a.endDate ?? a.startDate).localeCompare(b.endDate ?? b.startDate) ||
          (a.editionId === keepId ? -1 : b.editionId === keepId ? 1 : a.editionId.localeCompare(b.editionId)),
      );
      for (const s of sortedSlots) {
        const rk = rangeKey(s);
        if (!uniqueRanges.has(rk)) {
          uniqueRanges.set(rk, {
            startDate: s.startDate,
            ...(s.endDate && s.endDate !== s.startDate ? { endDate: s.endDate } : {}),
          });
        }
      }
      if (uniqueRanges.size > 9) {
        throw new CanonicalInputError('Cannot combine more than 9 weekends into one edition.');
      }
      const rangeToWeekend = new Map<string, number>();
      const combinedWeekends: EditionWeekend[] = [];
      let wNum = 1;
      for (const [rk, range] of uniqueRanges.entries()) {
        rangeToWeekend.set(rk, wNum);
        combinedWeekends.push({ weekend: wNum, ...range });
        wNum++;
      }

      for (const s of slots) {
        if (!s.singleSlot) continue;
        const assigned = rangeToWeekend.get(rangeKey(s));
        if (assigned !== undefined) {
          stampActions.push({ editionId: s.editionId, weekend: assigned });
        }
      }

      next.weekends = combinedWeekends;
      const minStart = combinedWeekends[0].startDate;
      const maxEnd = combinedWeekends.reduce((m, w) => {
        const end = w.endDate ?? w.startDate;
        return end > m ? end : m;
      }, minStart);
      next.startDate = minStart;
      next.endDate = maxEnd === minStart ? undefined : maxEnd;
    }
  }

  // Before any mutation (stampUnsetWeekend, store.mergeEditions, writeEdition),
  // if next.startDate && next.venueId && next.subjectKey are all present,
  // check whether an edition outside [keepId, ...uniqueDropIds] already holds them.
  if (next.startDate && next.venueId && next.subjectKey) {
    const excluded = new Set([keepId, ...uniqueDropIds]);
    let clash: Edition | null | undefined = null;
    if (typeof store.findEditionByOccurrence === 'function') {
      clash = await store.findEditionByOccurrence(next.startDate, next.venueId, next.subjectKey);
    } else if (typeof store.listEditions === 'function') {
      const all = await store.listEditions(5000);
      clash =
        all.find(
          (e) =>
            e.startDate === next.startDate &&
            e.venueId === next.venueId &&
            e.subjectKey === next.subjectKey,
        ) ?? null;
    }
    if (clash && !excluded.has(clash.id)) {
      throw new EditionOccurrenceConflictError(keepId, next.startDate, next.venueId, next.subjectKey, {
        id: clash.id,
        key: clash.key,
        name: clash.name,
      });
    }
  }

  // Stamp unset logged_events.weekend on keep and drop editions BEFORE mergeEditions moves drop's events onto keep.
  for (const action of stampActions) {
    await store.stampUnsetWeekend(action.editionId, action.weekend);
  }

  const merged: MergeSummary[] = [];
  for (const dropId of uniqueDropIds) {
    merged.push(await store.mergeEditions(keepId, dropId, actor, reason));
  }

  const currentKeep = await store.getEdition(keepId);
  if (currentKeep) {
    next.performances = currentKeep.performances;
  }
  if ((next.performances && next.performances.length > 0) || keep.hasLineup || drops.some((d) => d.hasLineup)) {
    next.hasLineup = true;
  }

  await writeEdition(store, { edition: next, actor, reason });

  const updatedKeep = (await store.getEdition(keepId)) ?? next;
  return { edition: updatedKeep, merged };
}

export async function autoMergeZeroLineupGroup(
  store: LineupStore,
  candidates: EditionHeader[],
  opts: { actor: string; reason: string },
): Promise<{ keep: EditionHeader; droppedIds: string[] } | null> {
  const uniqueCandidates = [...new Map(candidates.map((c) => [c.id, c])).values()];
  if (uniqueCandidates.length < 2) return null;

  const facts = await store.editionLineupFacts(uniqueCandidates.map((c) => c.id));
  const populatedVerified: EditionHeader[] = [];
  const populatedOther: EditionHeader[] = [];
  const empty: EditionHeader[] = [];

  for (const c of uniqueCandidates) {
    const acts = facts[c.id]?.acts ?? 0;
    if (acts > 0) {
      if (isVerifiedStatus(c.status)) {
        populatedVerified.push(c);
      } else {
        populatedOther.push(c);
      }
    } else {
      empty.push(c);
    }
  }

  if (populatedVerified.length !== 1 || populatedOther.length !== 0 || empty.length < 1) {
    return null;
  }

  const winner = populatedVerified[0];
  let keep = winner;
  let drops = empty;

  if (winner.key.startsWith('operator-recheck/')) {
    const canonicalEmptyRows = empty.filter(
      (e) => isVerifiedStatus(e.status) && !e.key.startsWith('operator-recheck/') && !e.key.startsWith('provisional/'),
    );
    if (canonicalEmptyRows.length === 1) {
      keep = canonicalEmptyRows[0];
      drops = [winner, ...empty.filter((e) => e.id !== keep.id)];
    }
  }

  const mergeRes = await mergeCanonicalEditions(store, {
    keepId: keep.id,
    dropIds: drops.map((d) => d.id),
    actor: opts.actor,
    reason: opts.reason,
  });

  return { keep: mergeRes.edition, droppedIds: drops.map((d) => d.id) };
}

// Clashfinder "Find lineup" (slice 2.10): only a festival edition with no lineup can ask for one. The request is
// the edition's own name and year, so the existing ingest adapter ranks the Clashfinder versions. Its result still
// waits for review under Lookups and is written by the usual confirm path.
export type FindLineupRequest =
  | { ok: true; eventName: string; year: number; startDate?: string; endDate?: string; venue?: string; city?: string; country?: string }
  | { ok: false; error: string };

export function findLineupRequest(edition: Edition | null): FindLineupRequest {
  if (!edition) return { ok: false, error: 'No such edition.' };
  if (edition.seriesKind !== 'festival') return { ok: false, error: 'Find lineup works on festival editions only.' };
  if (edition.performances.length > 0) return { ok: false, error: 'This edition already has a lineup.' };
  const eventName = edition.name?.trim();
  if (!eventName) return { ok: false, error: 'Give the edition a name first.' };
  if (!Number.isInteger(edition.year)) return { ok: false, error: 'The edition needs a year first.' };
  return {
    ok: true,
    eventName,
    year: edition.year,
    startDate: edition.startDate,
    endDate: edition.endDate,
    venue: edition.venue,
    city: edition.city,
    country: edition.country,
  };
}
