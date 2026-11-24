// Runs auto-verify when a lineup lookup (stage 2) finishes (docs/auto-verify-spec.md). Never on save.
// Candidate acts on the shared edition become verified when the lookup's own fetched sources list the same name for
// the same edition date. A provisional edition becomes verified when name, act, location, venue and date each come
// from a verified writer, read from its change record. Every write goes through autoVerifyAct / autoVerifyEdition,
// so it goes through writeEdition with a system actor and a reason, and can be undone. No model call.
import type { CandidateLineup, CandidateSource, Edition, EditionChange, LookupJob } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';
import { autoVerifyAct, autoVerifyEdition } from './editions';
import { locationVerifiedBy, type ActEvidence, type EditionFieldFacts, type EvidenceKind } from './autoVerify';
import { MEMBER_TICK_EXTRACTOR } from './memberTick';

export const AUTO_VERIFY_ACTOR = 'system:auto-verify';

// How a lookup source counts. Lineup pages the app fetched (a promoter page, Clashfinder) and API records with the
// act's name and date (Ticketmaster, MusicBrainz) are trusted: one is enough. Pages found by web search or read from
// the Wayback Machine count, but two distinct ones must agree. A setlist.fm ID alone never verifies, and the app's own
// entries (a member's tick, the edition's own name, a ticket email in stage 1) are not lookup evidence.
const KIND: Partial<Record<CandidateSource['sourceType'], { kind: EvidenceKind; trusted: boolean }>> = {
  promoter: { kind: 'fetched_page', trusted: true },
  clashfinder: { kind: 'fetched_page', trusted: true },
  ticketmaster: { kind: 'api_record', trusted: true },
  musicbrainz: { kind: 'api_record', trusted: true },
  discovered: { kind: 'fetched_page', trusted: false },
  wayback: { kind: 'fetched_page', trusted: false },
  setlistfm: { kind: 'external_id', trusted: false },
};

// Writers whose values count as coming from a verified source: the owner, a confirmed lookup, a canonical ingest and
// a ticket email import. A member's own entry, stage 1 research and the weather lookup do not.
export const VERIFIED_FIELD_ACTORS: ReadonlySet<string> = new Set(['owner', 'system:learning', 'system:ingest', 'system:canon-backfill']);

// The lookup's evidence for one edition. The date is the lookup's own start date; an act verifies only when it equals
// the edition's start date. Flagged (low evidence) acts and sources with no stored link or quote are left out.
export function evidenceFromLookup(candidate: CandidateLineup, editionKey: string, date: string | undefined): ActEvidence[] {
  if (!date) return [];
  const out: ActEvidence[] = [];
  for (const p of candidate.performers) {
    if (p.flagged) continue;
    for (const s of p.sources) {
      const k = KIND[s.sourceType];
      if (!k || s.extractor === MEMBER_TICK_EXTRACTOR || !s.sourceUrl || !s.quotedSpan.trim()) continue;
      out.push({ sourceId: s.sourceUrl, kind: k.kind, trusted: k.trusted, editionKey, name: p.name, date });
    }
  }
  return out;
}

const UNDO = /^undo of /;
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The actor of the newest change that set this field to its current value. Changes come newest first, as both stores
// list them. Undone changes and undo records are skipped, so a reverted write never counts.
function lastWriter(changes: EditionChange[], field: string, current: unknown): string | null {
  for (const c of changes) {
    if (c.undoneAt || UNDO.test(c.reason ?? '')) continue;
    const after = (c.after ?? {}) as Record<string, unknown>;
    if (!(field in after)) continue;
    return same(after[field], current) ? c.actor : null;
  }
  return null;
}

// The five edition facts, each with whether its value came from a verified writer.
export function editionFacts(edition: Edition, changes: EditionChange[]): EditionFieldFacts {
  const fromVerified = (field: 'name' | 'startDate' | 'venue' | 'city') => {
    const actor = lastWriter(changes, field, edition[field] ?? null);
    return !!actor && (VERIFIED_FIELD_ACTORS.has(actor) || (field === 'city' && locationVerifiedBy(actor)));
  };
  // A verified act (absent status reads as verified). A member's tick counts only once a source verified it.
  const act = edition.performances.find((p) => (p.verification ?? 'verified') === 'verified');
  return {
    name: { value: edition.name, verified: fromVerified('name') },
    date: { value: edition.startDate, verified: fromVerified('startDate') },
    venue: { value: edition.venue, verified: fromVerified('venue') },
    location: { value: edition.city, verified: fromVerified('city') },
    act: { value: act?.name, verified: !!act },
  };
}

export interface AutoVerifyRunResult {
  acts: string[]; // artist keys flipped to verified
  edition: boolean; // the edition became verified
}

// Called once at the end of a lookup that produced a lineup. The shared edition is the lookup's own (by id, else by
// key); with none, or no start date on it, nothing happens.
export async function autoVerifyAfterLookup(store: LineupStore, job: LookupJob): Promise<AutoVerifyRunResult> {
  const result: AutoVerifyRunResult = { acts: [], edition: false };
  if (!job.candidate) return result;
  const found = job.editionId ? await store.getEdition(job.editionId) : await store.getEditionByKey(job.editionKey);
  if (!found?.startDate) return result;
  const date = job.candidate.facts.startDate ?? job.input.startDate;
  const evidence = evidenceFromLookup(job.candidate, found.key, date);
  for (const p of found.performances) {
    if (p.verification !== 'candidate') continue;
    const r = await autoVerifyAct(store, {
      editionId: found.id,
      artistKey: p.artistKey,
      evidence,
      expected: { editionKey: found.key, name: p.name, date: found.startDate },
      actor: AUTO_VERIFY_ACTOR,
      reason: 'Lineup lookup: a fetched source lists this act for this date',
    });
    if (r.ok && r.changed) result.acts.push(p.artistKey);
  }
  if (found.status === 'provisional') {
    const edition = (await store.getEdition(found.id)) ?? found;
    const r = await autoVerifyEdition(store, {
      editionId: found.id,
      facts: editionFacts(edition, await store.listEditionChanges(found.id)),
      actor: AUTO_VERIFY_ACTOR,
      reason: 'Lineup lookup: name, act, location, venue and date all come from verified sources',
    });
    result.edition = r.ok && r.changed;
  }
  return result;
}
