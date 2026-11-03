import { randomUUID } from 'node:crypto';
import { LineupStore } from './store/types';
import { Edition, EditionPerformance } from './types';
import { isBilling, Billing } from './billing';
import { normalizeName, seriesSlugFor } from './text';

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
  a.billing === b.billing &&
  a.set === b.set &&
  JSON.stringify(a.days) === JSON.stringify(b.days) &&
  JSON.stringify(a.stages) === JSON.stringify(b.stages);

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
    if (!prev || !sameAct(prev, act)) byKey.set(act.artistKey, act);
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
  };

  if (!input.apply) return { applied: false, diff };

  await store.ensureArtists(edition.performances.map((p) => ({ key: p.artistKey, name: p.name })));
  if (!(await store.getSeries(slug))) await store.upsertSeries({ slug, name: edition.name });
  await store.upsertEdition(edition);
  return { applied: true, diff, edition };
}
