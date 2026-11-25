// Review of inferred values on shared editions (docs/specs/inferred-values.md, "Review" and "Verify").
// The owner confirms or rejects an inference. A member's Verify tap records a vote; two different members
// agreeing writes the value into the edition's own field, the same as the owner confirming it.
// Votes hold no personal fields. Every write goes through writeEdition, so it is logged and can be undone.
import type { Edition, EditionInference, InferenceField, InferenceVote } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';
import { INFERENCE_CONFIRMED_KEY, INFERENCE_FIELDS, isEmptyValue, writeEdition } from './editions';
import { rejectInference, resolveRecorded } from './inferences';

export const MEMBER_VERIFY_ACTOR = 'system:member-verify';
export const MEMBER_VERIFY_THRESHOLD = 2;

export type ConfirmRefusal = 'not_active' | 'field_has_value' | 'billing_not_confirmable';
export type ConfirmResult = { ok: true; inference: EditionInference } | { ok: false; reason: ConfirmRefusal };

export type VoteRefusal = 'not_active' | 'billing_not_votable';
export type VoteResult = { ok: true; votes: number; verified: boolean } | { ok: false; reason: VoteRefusal };

export type RejectReviewRefusal = 'not_active';
export type RejectReviewResult = { ok: true; rows: EditionInference[] } | { ok: false; reason: RejectReviewRefusal };

export type InferenceStanding = 'inferred' | 'candidate';

// Finds one active inference by id. With an edition id, a row of another edition is not found.
async function findActive(store: LineupStore, id: string, editionId?: string): Promise<EditionInference | null> {
  const row = await store.getEditionInference(id);
  if (!row || row.status !== 'active') return null;
  if (editionId && row.editionId !== editionId) return null;
  return row;
}

function isEditionField(field: EditionInference['field']): field is InferenceField {
  return (INFERENCE_FIELDS as readonly string[]).includes(field);
}

// Writes the inferred value into the edition's own field. healAfterWrite marks the inference confirmed; if that
// best-effort step did not run, the inference is confirmed here so it never stays active over a filled field.
async function writeInferredValue(
  store: LineupStore,
  inference: EditionInference,
  actor: string,
  reason: string,
): Promise<boolean> {
  if (!isEditionField(inference.field)) return false;
  const edition = await store.getEdition(inference.editionId);
  if (!edition || !isEmptyValue(edition[inference.field])) return false;
  const next = { ...edition, [inference.field]: inference.value, updatedAt: new Date().toISOString() } as Edition;
  await writeEdition(store, { edition: next, actor, reason, extra: { after: { [INFERENCE_CONFIRMED_KEY]: inference.id } } });
  const current = (await store.listEditionInferences(inference.editionId)).find((i) => i.id === inference.id);
  if (current?.status === 'active') {
    await resolveRecorded(store, inference.editionId, inference.id, { status: 'confirmed', by: actor, reason: 'the value was written into the edition' });
  }
  return true;
}

// Owner confirm: the value becomes the edition's own value, counted as verified. Billing rows cannot be confirmed yet.
export async function confirmInference(store: LineupStore, id: string, actor: string): Promise<ConfirmResult> {
  const inference = await findActive(store, id);
  if (!inference) return { ok: false, reason: 'not_active' };
  if (!isEditionField(inference.field)) return { ok: false, reason: 'billing_not_confirmable' };
  const edition = await store.getEdition(inference.editionId);
  if (!edition || !isEmptyValue(edition[inference.field])) return { ok: false, reason: 'field_has_value' };
  await writeInferredValue(store, inference, actor, `confirmed inferred ${inference.field}: ${inference.reason}`);
  const after = (await store.listEditionInferences(inference.editionId)).find((i) => i.id === inference.id) ?? inference;
  return { ok: true, inference: after };
}

// Owner reject: the inference is rejected and every inference built on it is replaced. Works for billing rows too.
export async function rejectReviewedInference(store: LineupStore, id: string, actor: string): Promise<RejectReviewResult> {
  const inference = await findActive(store, id);
  if (!inference) return { ok: false, reason: 'not_active' };
  const result = await rejectInference(store, id, inference.editionId, actor, 'rejected by the owner');
  if (!result.ok) return { ok: false, reason: 'not_active' };
  return { ok: true, rows: result.rows };
}

// Distinct members who verified this inference.
function distinctMembers(votes: InferenceVote[]): number {
  return new Set(votes.map((v) => v.memberId)).size;
}

// A member's Verify tap. Pass editionId when the caller already knows the linked edition (a member's event).
// Two different members write the value into the edition's own field as system:member-verify.
export async function voteInference(
  store: LineupStore,
  id: string,
  memberId: string,
  editionId?: string,
): Promise<VoteResult> {
  const inference = await findActive(store, id, editionId);
  if (!inference) return { ok: false, reason: 'not_active' };
  if (!isEditionField(inference.field)) return { ok: false, reason: 'billing_not_votable' };
  await store.addInferenceVote(id, memberId);
  const votes = distinctMembers(await store.listInferenceVotes(id));
  if (votes < MEMBER_VERIFY_THRESHOLD) return { ok: true, votes, verified: false };
  const written = await writeInferredValue(store, inference, MEMBER_VERIFY_ACTOR, `two members verified inferred ${inference.field}`);
  return { ok: true, votes, verified: written };
}

// Display standing of an active inference: 'candidate' once one member has verified it, else 'inferred'.
export function inferenceStanding(inference: EditionInference, votes: InferenceVote[]): InferenceStanding {
  const own = votes.filter((v) => v.inferenceId === inference.id);
  return distinctMembers(own) >= 1 ? 'candidate' : 'inferred';
}
