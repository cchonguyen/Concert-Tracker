// Inferred billing roles for a shared edition (docs/specs/inferred-values.md, "Rules for an inferred value").
// A concert named after one of its acts infers that act as headliner and the others as support. It is never
// stored as a billing role: it sits in edition_inferences with field 'billing' and the act as its subject.
// Every change goes through recordEditionNote so it lands in edition_changes and can be undone.
import type { Edition, EditionInference, InferenceInput } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';
import type { Billing } from '../lineup/billing';
import { isBilling } from '../lineup/billing';
import { normalizeName } from '../lineup/normalizeName';
import { CONCERT_MAX_ACTS, lineupFacts } from '../events/scale';
import { INFERENCE_ADDED_KEY, recordEditionNote } from './editions';
import { resolveRecorded } from './inferences';

export const BILLING_INFER_RULE = 'billing-named-after-act';
export const BILLING_INFER_ACTOR = 'system:billing-infer';

export interface BillingInference {
  subject: string; // the performance's artist key
  role: Billing;
  reason: string;
}

// The rule, in code only. Nothing here is a model call or a guess from a name alone.
export function billingInferencesFor(edition: Edition): BillingInference[] {
  if (edition.seriesKind === 'festival') return [];
  if (edition.endDate && edition.endDate !== edition.startDate) return [];
  // A source has spoken about billing on this edition: infer nothing.
  if (edition.performances.some((p) => p.billing)) return [];
  const facts = lineupFacts(edition);
  if (facts.acts > CONCERT_MAX_ACTS || facts.clashfinder) return [];
  const live = edition.performances.filter((p) => p.status !== 'cancelled');
  if (live.length < 2) return [];
  const target = normalizeName(edition.name ?? '');
  if (!target) return [];
  const named = edition.performances.filter((p) => normalizeName(p.name) === target);
  if (named.length !== 1 || named[0].status === 'cancelled') return [];
  const head = named[0];
  const reason = `The event is named after ${head.name} and the lineup lists ${live.length - 1} other act(s).`;
  return live.map((p) => ({
    subject: p.artistKey,
    role: p.artistKey === head.artistKey ? 'headliner' : 'support',
    reason,
  }));
}

export interface InferredBilling {
  role: Billing;
  reason: string;
  inferenceId: string;
}

// The active billing inferences by act, for display on a linked event. Never written anywhere.
export function inferredBillingFor(inferences: EditionInference[]): Record<string, InferredBilling> {
  const out: Record<string, InferredBilling> = {};
  for (const inf of inferences) {
    if (inf.field !== 'billing' || inf.status !== 'active' || !inf.subject || !isBilling(inf.value)) continue;
    out[inf.subject] = { role: inf.value, reason: inf.reason, inferenceId: inf.id };
  }
  return out;
}

export interface InferBillingResult {
  added: EditionInference[];
  resolved: EditionInference[];
}

// Heals the active billing inferences against the edition as it is now, then adds the rule's new ones.
// `edition` should be the reloaded edition. Running it twice adds nothing the second time.
export async function inferBillingRoles(
  store: LineupStore,
  edition: Edition,
  actor: string = BILLING_INFER_ACTOR,
): Promise<InferBillingResult> {
  const desired = billingInferencesFor(edition);
  const all = await store.listEditionInferences(edition.id);
  const resolved: EditionInference[] = [];

  for (const inf of all.filter((i) => i.field === 'billing' && i.status === 'active' && i.subject)) {
    const performance = edition.performances.find((p) => p.artistKey === inf.subject);
    let status: 'confirmed' | 'replaced';
    let reason: string;
    if (!performance || performance.status === 'cancelled') {
      status = 'replaced';
      reason = 'the act is no longer on the lineup';
    } else if (performance.billing) {
      status = performance.billing === inf.value ? 'confirmed' : 'replaced';
      reason = 'a stated billing arrived';
    } else if (desired.find((d) => d.subject === inf.subject)?.role !== inf.value) {
      status = 'replaced';
      reason = 'the lineup no longer fits the rule';
    } else {
      continue;
    }
    const row = await resolveRecorded(store, edition.id, inf.id, { status, by: actor, reason });
    if (row) resolved.push(row);
  }

  const activeSubjects = new Set(
    all.filter((i) => i.field === 'billing' && i.status === 'active').map((i) => i.subject),
  );
  // An owner's undo of an inferred role is not argued back in on the next lookup.
  const rejectedSubjects = new Set(
    all.filter((i) => i.field === 'billing' && i.status === 'rejected').map((i) => i.subject),
  );
  const added: EditionInference[] = [];
  for (const d of desired) {
    if (activeSubjects.has(d.subject) || rejectedSubjects.has(d.subject)) continue;
    const inputs: InferenceInput[] = [{ kind: 'record', table: 'event_editions', id: edition.id }];
    const row = await store.addEditionInference({
      editionId: edition.id,
      field: 'billing',
      subject: d.subject,
      value: d.role,
      reason: d.reason,
      rule: BILLING_INFER_RULE,
      inputs,
      parents: [],
      actor,
    });
    try {
      await recordEditionNote(store, {
        editionId: edition.id,
        actor,
        reason: `inferred billing for ${edition.name}: ${d.reason}`,
        after: { [INFERENCE_ADDED_KEY]: row.id, field: 'billing', subject: d.subject, value: d.role },
      });
    } catch (err) {
      // The inference has no history row, so it is withdrawn rather than left unrecorded.
      await store.resolveEditionInference(row.id, { status: 'rejected', by: actor, reason: 'its change record failed' });
      throw err;
    }
    added.push(row);
  }
  return { added, resolved };
}
