import { randomUUID } from 'node:crypto';
import {
  CandidatePerformer,
  CandidateSource,
  Correction,
  Edition,
  EditionPerformance,
  LookupJob,
  SourceStat,
  SourceType,
} from './types';
import { LineupStore } from './store/types';
import { domainOf, lineupWindow, normalizeName, seriesSlugFor } from './text';
import { slugFromClashfinderUrl } from './adapters/clashfinder';
import { LoggedEvent, SeenAct, SetKind } from '../events/types';
import { isSetKind, withB2b } from '../events/seen';
import { Billing, isBilling } from './billing';
import { writeEdition } from '../canon/editions';

// Review is where the system learns. Every decision is stored as data that the
// next lookup reads: aliases, a per-site blocklist, measured source accuracy
// and confirmed extraction examples. Nothing here retrains a model.

export type RejectReason = 'not_an_act' | 'wrong_event' | 'cancelled';

export interface ReviewedPerformer {
  key?: string; // candidate key; absent for acts you added
  slotId?: string;
  alias?: string;
  b2b?: string[];
  name: string;
  // You kept this name as one act (no B2B split). Stored on the edition.
  oneAct?: boolean;
  accepted: boolean;
  rejectReason?: RejectReason;
  seen: boolean;
  days?: string[];
  stages?: string[];
  // Your role for the act: null means no lead stated. Left out, the role the
  // sources agreed on is kept.
  billing?: Billing | null;
  // Your set type for an act you saw: null for none. Left out, the lineup's
  // DJ set mark (or your earlier one) is kept.
  set?: SetKind | null;
}

type EditionFactsInput = { name: string; startDate?: string; endDate?: string; venue?: string; city?: string; country?: string };

export interface ConfirmRequest {
  // Defaults to the logged event's facts, then what the sources found.
  facts?: EditionFactsInput;
  performers: ReviewedPerformer[];
}

export interface ConfirmResult {
  edition: Edition;
  event: LoggedEvent | null;
}

// The edition's facts: what was sent, else your event's, with gaps filled
// from what the lineup sources cited.
function editionFacts(job: LookupJob, event: LoggedEvent | null, sent?: EditionFactsInput): EditionFactsInput {
  const found = job.candidate?.facts;
  const base = sent ?? event ?? { ...job.input, name: job.input.eventName };
  return {
    name: base.name,
    startDate: base.startDate || found?.startDate,
    endDate: base.endDate || found?.endDate,
    venue: base.venue || found?.venue,
    city: base.city || found?.city,
    country: base.country || found?.country,
  };
}

// Your seen acts after review: what you ticked, plus anything you had added
// by hand that the lineup did not list.
// A set type chosen in the review (setChosen) replaces your earlier one.
export function mergeSeen(before: SeenAct[], ticked: SeenAct[], reviewedKeys: Set<string>, setChosen = new Set<string>()): SeenAct[] {
  const out: SeenAct[] = [];
  for (const s of before) {
    if (!reviewedKeys.has(s.key)) {
      out.push(s.id ? s : { ...s, id: randomUUID() });
    }
  }
  for (const raw of ticked) {
    const s: SeenAct = { ...raw, id: raw.id || randomUUID() };
    const was = before.find((b) => {
      if (s.id && b.id && b.id === s.id) return true;
      if (s.slotId && b.slotId && b.slotId === s.slotId && b.key === s.key) return true;
      if (s.b2b?.length) {
        return b.key === s.key && b.b2b && b.b2b.length === s.b2b.length && b.b2b.every((k) => s.b2b!.includes(k));
      }
      return b.key === s.key && (!b.b2b || b.b2b.length === 0);
    }) ?? before.find((b) => b.key === s.key);

    out.push({
      ...s,
      ...(was?.favourite ? { favourite: true } : {}),
      ...(was?.set && !setChosen.has(s.key) ? { set: was.set } : {}),
      ...(s.b2b?.length ? { b2b: s.b2b } : (was?.b2b ? { b2b: was.b2b } : {})),
      ...(was?.solo ? { solo: true } : {}),
      ...(was?.soloSet ? { soloSet: was.soloSet } : {}),
    });
  }
  return withB2b(out);
}

function findCandidate(
  candidates: CandidatePerformer[],
  reviewed: ReviewedPerformer,
  usedCandidates: Set<CandidatePerformer>,
): CandidatePerformer | undefined {
  if (!reviewed.key) return undefined;
  if (reviewed.slotId) {
    const match = candidates.find((c) => !usedCandidates.has(c) && c.key === reviewed.key && c.slotId === reviewed.slotId);
    if (match) {
      usedCandidates.add(match);
      return match;
    }
  }
  if (reviewed.b2b?.length) {
    const match = candidates.find((c) => {
      if (usedCandidates.has(c) || c.key !== reviewed.key || !c.b2b) return false;
      return c.b2b.length === reviewed.b2b!.length && c.b2b.every((k) => reviewed.b2b!.includes(k));
    });
    if (match) {
      usedCandidates.add(match);
      return match;
    }
  }
  if (!reviewed.slotId && (!reviewed.b2b || reviewed.b2b.length === 0)) {
    const match = candidates.find((c) => !usedCandidates.has(c) && c.key === reviewed.key && (!c.b2b || c.b2b.length === 0) && !c.slotId);
    if (match) {
      usedCandidates.add(match);
      return match;
    }
  }
  const fallback = candidates.find((c) => !usedCandidates.has(c) && c.key === reviewed.key);
  if (fallback) {
    usedCandidates.add(fallback);
    return fallback;
  }
  return undefined;
}

const EXAMPLE_CHARS = 6000;

// A model reader's extractor id is 'gemini:<model>' or 'workers-ai:<model>'.
export function isReaderExtractor(extractor: string): boolean {
  return extractor.startsWith('gemini:') || extractor.startsWith('workers-ai:');
}

// One review outcome per source type, for this series and overall.
function statDeltas(types: SourceType[], slug: string, accepted: boolean): SourceStat[] {
  const out: SourceStat[] = [];
  for (const t of new Set(types)) {
    if (t === 'user') continue;
    for (const scope of [slug, '*']) out.push({ sourceType: t, scope, accepted: accepted ? 1 : 0, rejected: accepted ? 0 : 1 });
  }
  return out;
}

export async function confirmLookup(store: LineupStore, job: LookupJob, req: ConfirmRequest): Promise<ConfirmResult> {
  if (!['needs_review', 'no_data', 'confirmed'].includes(job.status)) {
    throw new Error(`Lookup is ${job.status}; it can be confirmed once it has finished.`);
  }
  const event = job.eventId ? await store.getEvent(job.eventId) : null;
  const facts = editionFacts(job, event, req.facts);
  if (!facts.name?.trim()) throw new Error('Event name is required.');

  const now = new Date().toISOString();
  const slug = seriesSlugFor(job.input.eventName);
  // Cached lineups and re-edits of a confirmed one were already counted once.
  const fresh = !job.candidate?.cached && job.status !== 'confirmed';
  const candidates = job.candidate?.performers ?? [];
  const usedCandidates = new Set<CandidatePerformer>();
  const performances: EditionPerformance[] = [];
  const ticked: SeenAct[] = [];
  const setChosen = new Set<string>();
  const reviewedKeys = new Set<string>();
  const acceptedByDoc = new Map<string, string[]>();
  // Learning writes are collected and saved in a few batched calls after the
  // loop, so a large lineup stays within a Worker's subrequest limit.
  const corrections: Correction[] = [];
  const stats: SourceStat[] = [];
  const blocked: Array<{ domain: string; normalized: string }> = [];
  const aliases: Record<string, string> = {};

  for (const reviewed of req.performers) {
    const name = reviewed.name.trim();
    if (!name) continue;
    reviewedKeys.add(normalizeName(name));
    const cand = findCandidate(candidates, reviewed, usedCandidates);
    const types = cand?.sources.map((s) => s.sourceType) ?? [];
    const urls = cand?.sources.map((s) => s.sourceUrl) ?? [];

    if (cand && !reviewed.accepted) {
      if (reviewed.rejectReason === 'cancelled') {
        performances.push({ ...toPerformance(cand, cand.name), status: 'cancelled' });
        continue;
      }
      corrections.push({
        id: randomUUID(),
        editionKey: job.editionKey,
        kind: 'rejected',
        original: cand.name,
        sourceTypes: types,
        sourceUrls: urls,
        createdAt: now,
      });
      if (fresh) stats.push(...statDeltas(types, slug, false));
      if (reviewed.rejectReason !== 'wrong_event') {
        for (const domain of new Set(urls.map(domainOf))) blocked.push({ domain, normalized: normalizeName(cand.name) });
      }
      continue;
    }
    if (!reviewed.accepted) continue;

    if (cand) {
      if (fresh) stats.push(...statDeltas(types, slug, true));
      const isPartnerSwap =
        Boolean(cand.b2b?.includes(normalizeName(name))) ||
        Boolean(reviewed.b2b?.includes(normalizeName(cand.name)));
      if (name !== cand.name && !isPartnerSwap) {
        aliases[normalizeName(cand.name)] = name;
        corrections.push({
          id: randomUUID(),
          editionKey: job.editionKey,
          kind: 'renamed',
          original: cand.name,
          corrected: name,
          sourceTypes: types,
          sourceUrls: urls,
          createdAt: now,
        });
      }
    } else {
      corrections.push({
        id: randomUUID(),
        editionKey: job.editionKey,
        kind: 'added',
        corrected: name,
        sourceTypes: ['user'],
        sourceUrls: [],
        createdAt: now,
      });
    }

    const perf: EditionPerformance = cand
      ? toPerformance(cand, name)
      : {
          artistKey: normalizeName(name),
          name,
          slotId: reviewed.slotId,
          alias: reviewed.alias,
          b2b: reviewed.b2b,
          days: [],
          stages: [],
          status: 'billed' as const,
          confidence: 1,
          sources: [userSource(name)],
        };
    if (reviewed.days) perf.days = reviewed.days;
    if (reviewed.stages) perf.stages = reviewed.stages;
    if (reviewed.slotId) perf.slotId = reviewed.slotId;
    if (reviewed.alias) perf.alias = reviewed.alias;
    if (reviewed.b2b?.length) perf.b2b = reviewed.b2b;
    if (reviewed.oneAct && !perf.b2b?.length) perf.oneAct = true;
    if (reviewed.billing !== undefined) perf.billing = isBilling(reviewed.billing) ? reviewed.billing : undefined;
    if (reviewed.seen) {
      perf.status = 'performed'; // you were there
      const act: SeenAct = {
        id: randomUUID(),
        key: perf.artistKey,
        name: perf.name,
        from: cand ? 'lineup' : 'you',
      };
      const actSlotId = cand?.slotId ?? reviewed.slotId;
      if (actSlotId) act.slotId = actSlotId;
      const actAlias = reviewed.alias ?? cand?.alias;
      if (actAlias) act.alias = actAlias;
      const actB2b = cand?.b2b?.length ? cand.b2b : reviewed.b2b;
      if (actB2b?.length) act.b2b = actB2b;
      if (perf.billing) {
        act.role = perf.billing;
        act.roleFrom = cand && perf.billing === cand.billing ? 'lineup' : 'you';
      }
      // As the lineup billed it; your own marks win (mergeSeen).
      if (cand?.set) act.set = cand.set;
      if (reviewed.set !== undefined) {
        setChosen.add(act.key);
        if (isSetKind(reviewed.set)) act.set = reviewed.set;
        else delete act.set;
      }
      ticked.push(act);
    }
    performances.push(perf);
    if (reviewed.alias && (perf.b2b?.length || reviewed.b2b?.length)) {
      const aliasKey = normalizeName(reviewed.alias);
      if (aliasKey && !aliases[aliasKey]) {
        const partners = [reviewed.name, ...(reviewed.b2b ?? perf.b2b ?? []).map((k) => req.performers.find((p) => normalizeName(p.name) === k)?.name ?? k)];
        aliases[aliasKey] = partners.join(' b2b ');
      }
    }
    if (cand) {
      for (const s of cand.sources) {
        acceptedByDoc.set(s.sourceUrl, [...(acceptedByDoc.get(s.sourceUrl) ?? []), cand.name]);
      }
    }
  }

  await store.addCorrections(corrections);
  await store.bumpSourceStats(stats);
  await store.bumpBlocklist(blocked);
  await store.putAliases(aliases);
  await store.ensureArtists(performances.map((p) => ({ key: p.artistKey, name: p.name })));

  const existing = await store.getEditionByKey(job.editionKey);
  const edition: Edition = {
    id: existing?.id ?? randomUUID(),
    key: job.editionKey,
    seriesSlug: slug,
    year: job.input.year,
    name: facts.name.trim(),
    startDate: facts.startDate || undefined,
    endDate: facts.endDate || undefined,
    venue: facts.venue || undefined,
    city: facts.city || undefined,
    country: facts.country || undefined,
    status: 'confirmed',
    performances: dedupe(performances),
    confirmedAt: now,
    updatedAt: now,
  };
  const series = await store.getSeries(slug);
  if (!series) await store.upsertSeries({ slug, name: edition.name });
  await writeEdition(store, { edition, actor: 'system:learning', reason: 'lineup confirmed' });

  if (fresh) await learnFromSources(store, job, acceptedByDoc, slug);

  let updated: LoggedEvent | null = null;
  if (event) {
    updated = {
      ...event,
      editionId: edition.id,
      seen: mergeSeen(event.seen, ticked, reviewedKeys, setChosen),
      updatedAt: now,
    };
    await store.putEvent(updated);
  }

  job.status = 'confirmed';
  job.editionId = edition.id;
  job.updatedAt = now;
  job.log = [...job.log, { at: now, message: `Confirmed ${edition.performances.length} act(s); you saw ${ticked.length}.` }];
  await store.updateJob(job);
  return { edition, event: updated };
}

// A member's review of a lookup. It changes only the member's own event: the
// acts they ticked go into its `seen` (a lineup act as billed, or a name they
// typed as "you"). It writes nothing shared: no edition, performances,
// corrections, source stats, blocklist, aliases or series, because the shared
// lineup is written only by the owner's review, from sources with quotes
// (ARCHITECTURE.md, Multi-user). If the owner already confirmed this edition,
// the member's event links to it.
export async function confirmLookupForMember(store: LineupStore, job: LookupJob, req: ConfirmRequest): Promise<ConfirmResult> {
  if (!['needs_review', 'no_data', 'confirmed'].includes(job.status)) {
    throw new Error(`Lookup is ${job.status}; it can be confirmed once it has finished.`);
  }
  const event = job.eventId ? await store.getEvent(job.eventId) : null;
  if (!event) throw new Error('This lookup is not attached to one of your events.');
  const now = new Date().toISOString();
  const candidates = job.candidate?.performers ?? [];
  const usedCandidates = new Set<CandidatePerformer>();
  const ticked: SeenAct[] = [];
  const setChosen = new Set<string>();
  const reviewedKeys = new Set<string>();
  const draft: EditionPerformance[] = [];

  for (const reviewed of req.performers) {
    const name = reviewed.name.trim();
    if (!name) continue;
    reviewedKeys.add(normalizeName(name));
    if (!reviewed.accepted) continue;
    const cand = findCandidate(candidates, reviewed, usedCandidates);
    if (cand) draft.push(toPerformance(cand, name));
    if (!reviewed.seen) continue;
    const billing = reviewed.billing !== undefined ? (isBilling(reviewed.billing) ? reviewed.billing : undefined) : cand?.billing;
    const act: SeenAct = {
      id: randomUUID(),
      key: normalizeName(name),
      name,
      from: cand ? 'lineup' : 'you',
    };
    const actSlotId = cand?.slotId ?? reviewed.slotId;
    if (actSlotId) act.slotId = actSlotId;
    const actAlias = reviewed.alias ?? cand?.alias;
    if (actAlias) act.alias = actAlias;
    const actB2b = cand?.b2b?.length ? cand.b2b : reviewed.b2b;
    if (actB2b?.length) act.b2b = actB2b;
    if (billing) {
      act.role = billing;
      act.roleFrom = cand && billing === cand.billing ? 'lineup' : 'you';
    }
    if (cand?.set) act.set = cand.set;
    if (reviewed.set !== undefined) {
      setChosen.add(act.key);
      if (isSetKind(reviewed.set)) act.set = reviewed.set;
      else delete act.set;
    }
    ticked.push(act);
  }

  const existing = await store.getEditionByKey(job.editionKey);
  const updated: LoggedEvent = {
    ...event,
    editionId: existing?.id ?? event.editionId,
    seen: mergeSeen(event.seen, ticked, reviewedKeys, setChosen),
    updatedAt: now,
  };
  await store.putEvent(updated);

  job.status = 'confirmed';
  job.editionId = existing?.id;
  job.updatedAt = now;
  job.log = [...job.log, { at: now, message: `You saw ${ticked.length} act(s); saved to your event only.` }];
  await store.updateJob(job);
  // What the page shows after a review: the shared edition if the owner has
  // confirmed one, else a draft of the sourced acts you accepted (not stored).
  const edition: Edition = existing ?? {
    id: `draft-${job.id}`,
    key: job.editionKey,
    seriesSlug: seriesSlugFor(job.input.eventName),
    year: job.input.year,
    name: event.name,
    status: 'draft',
    performances: dedupe(draft),
    updatedAt: now,
  };
  return { edition, event: updated };
}

// Remember the lineup page for next year and keep a confirmed extraction
// example per website for Gemini's next read of that site.
async function learnFromSources(
  store: LineupStore,
  job: LookupJob,
  acceptedByUrl: Map<string, string[]>,
  slug: string,
): Promise<void> {
  const claims = await store.listPerformerClaims(job.id);
  // Without a URL from the person, an accepted promoter page (for example the
  // event's own site found by web search) becomes next year's lineup URL.
  const promoterUrl = claims.find((c) => c.sourceType === 'promoter' && acceptedByUrl.has(c.sourceUrl))?.sourceUrl;
  const url = job.input.lineupUrl ?? promoterUrl;
  const usedOfficialPage = [...acceptedByUrl.keys()].some((u) => {
    const d = domainOf(u);
    return d !== 'clashfinder.com' && d !== '*';
  });
  if (url && !slugFromClashfinderUrl(url) && usedOfficialPage) {
    const series = await store.getSeries(slug);
    if (series) await store.upsertSeries({ ...series, lineupUrl: url });
  }

  const readerDocs = new Set(claims.filter((c) => isReaderExtractor(c.extractor)).map((c) => c.documentId));
  for (const docId of readerDocs) {
    const doc = await store.getDocument(docId);
    if (!doc) continue;
    const excerpt = lineupWindow(doc.body, EXAMPLE_CHARS);
    const normalizedExcerpt = ` ${normalizeName(excerpt)} `;
    const names = (acceptedByUrl.get(doc.url) ?? []).filter((n) => normalizedExcerpt.includes(` ${normalizeName(n)} `));
    if (names.length >= 3) {
      await store.addExample({ domain: domainOf(doc.url), excerpt, names, createdAt: new Date().toISOString() });
    }
  }
}

function userSource(name: string): CandidateSource {
  return { sourceType: 'user', sourceUrl: '', quotedSpan: name, evidence: 'billed', extractor: 'user' };
}

function toPerformance(cand: CandidatePerformer, name: string): EditionPerformance {
  return {
    artistKey: normalizeName(name),
    name,
    slotId: cand.slotId,
    alias: cand.alias,
    set: cand.set,
    b2b: cand.b2b,
    days: cand.days,
    stages: cand.stages,
    status: cand.status,
    billing: cand.billing,
    confidence: cand.confidence,
    sources: cand.sources,
  };
}

function dedupe(perfs: EditionPerformance[]): EditionPerformance[] {
  const out: EditionPerformance[] = [];
  for (const p of perfs) {
    const prev = out.find((existing) => {
      if (existing.artistKey !== p.artistKey) return false;
      if (existing.set !== p.set) return false;
      if (existing.slotId && p.slotId) return existing.slotId === p.slotId;
      const existingIsB2b = Boolean(existing.b2b?.length);
      const pIsB2b = Boolean(p.b2b?.length);
      if (existingIsB2b !== pIsB2b) return false;
      if (existingIsB2b && pIsB2b) {
        const p1 = [...existing.b2b!].sort().join(',');
        const p2 = [...p.b2b!].sort().join(',');
        return p1 === p2;
      }
      return true;
    });

    if (!prev) {
      out.push({ ...p });
    } else {
      prev.slotId ??= p.slotId;
      prev.b2b ??= p.b2b;
      prev.days = [...new Set([...prev.days, ...p.days])].sort();
      prev.stages = [...new Set([...prev.stages, ...p.stages])];
      prev.sources = [...prev.sources, ...p.sources];
      if (p.status === 'performed') prev.status = 'performed';
      prev.billing ??= p.billing;
    }
  }
  return out;
}
