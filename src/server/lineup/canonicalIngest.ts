import { randomUUID } from 'node:crypto';
import { LineupStore } from './store/types';
import { Edition, EditionPerformance } from './types';
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
  const editionKey = `${slug}/${input.startDate ?? input.year}`;
  const existing = await store.getEditionByKey(editionKey);

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
    id: existing?.id ?? randomUUID(),
    key: editionKey,
    seriesSlug: slug,
    year: input.year,
    name: merged.name ?? input.name,
    startDate: merged.startDate,
    endDate: merged.endDate,
    venue: merged.venue,
    city: merged.city,
    country: merged.country,
    status: 'confirmed',
    performances: [...byKey.values()],
    confirmedAt: now,
    updatedAt: now,
    // A re-confirm keeps the owner's fact source note; it is not part of the lineup.
    factSourceNote: existing?.factSourceNote,
  };

  if (!input.apply) return { applied: false, diff };

  await store.ensureArtists(edition.performances.map((p) => ({ key: p.artistKey, name: p.name })));
  if (!(await store.getSeries(slug))) await store.upsertSeries({ slug, name: edition.name });
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
  return { applied: true, diff, edition };
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
  sourceNote: string;
}

export class EditionNotFoundError extends Error {}

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
  await writeEdition(store, { edition, actor: 'owner', reason: 'edition facts edited' });
  return edition;
}
