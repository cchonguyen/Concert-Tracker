// Inferred values for a shared edition (docs/specs/inferred-values.md, "Rules for an inferred value").
// An inference fills an empty field with a stated reason and named inputs. It is shown with the "Inferred"
// label, never overwrites a typed or verified value, and is replaced or confirmed when such a value arrives.
// Every change goes through recordEditionNote so it lands in edition_changes and can be undone.
import type { Edition, EditionInference, InferenceField, InferenceInput } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';
import type { LoggedEvent } from '../events/types';
import { INFERENCE_ADDED_KEY, INFERENCE_FIELDS, isEmptyValue, recordEditionNote } from './editions';
import { domainOf } from '../lineup/text';

export { INFERENCE_ADDED_KEY, INFERENCE_FIELDS };

export const READER_INFER_ACTOR = 'system:reader-infer';

// Structurally the same as ReaderInference in events/detailsGemini.ts (kept here to avoid an import cycle).
export interface ReaderInferenceInput {
  field: 'venue' | 'city' | 'region' | 'country';
  value: string;
  quote: string;
  reason: string;
  url: string;
}

export interface InferEditionFieldInput {
  edition: Edition;
  field: InferenceField;
  value: unknown;
  reason: string;
  rule: string;
  inputs: InferenceInput[];
  parents?: string[];
  actor: string;
}

export type InferRefusal = 'field_has_value' | 'no_reason' | 'empty_value' | 'bad_parent' | 'already_inferred';
export type InferEditionFieldResult = { ok: true; inference: EditionInference } | { ok: false; reason: InferRefusal };

export async function inferEditionField(store: LineupStore, input: InferEditionFieldInput): Promise<InferEditionFieldResult> {
  const { edition, field, actor } = input;
  const reason = (input.reason ?? '').trim();
  const parents = [...new Set(input.parents ?? [])];
  if (!isEmptyValue(edition[field])) return { ok: false, reason: 'field_has_value' };
  if (!reason) return { ok: false, reason: 'no_reason' };
  if (isEmptyValue(input.value)) return { ok: false, reason: 'empty_value' };
  const active = (await store.listEditionInferences(edition.id)).filter((i) => i.status === 'active');
  if (parents.some((p) => !active.some((i) => i.id === p))) return { ok: false, reason: 'bad_parent' };
  if (active.some((i) => i.field === field)) return { ok: false, reason: 'already_inferred' };
  const inputs: InferenceInput[] = [...input.inputs];
  for (const p of parents) {
    if (!inputs.some((x) => x.kind === 'inference' && x.id === p)) inputs.push({ kind: 'inference', id: p });
  }
  const inference = await store.addEditionInference({
    editionId: edition.id,
    field,
    value: input.value,
    reason,
    rule: input.rule,
    inputs,
    parents,
    actor,
  });
  try {
    await recordEditionNote(store, {
      editionId: edition.id,
      actor,
      reason: `inferred ${field}: ${reason}`,
      after: { [INFERENCE_ADDED_KEY]: inference.id, field, value: input.value },
    });
  } catch (err) {
    // The inference has no history row, so it is withdrawn rather than left unrecorded.
    await store.resolveEditionInference(inference.id, { status: 'rejected', by: actor, reason: 'its change record failed' });
    throw err;
  }
  return { ok: true, inference };
}

// Stores reader inferences (rule 'reader') on an edition. A refused one (field has a value, already inferred, ...) is skipped.
export async function storeReaderInferences(
  store: LineupStore,
  edition: Edition,
  list: ReaderInferenceInput[],
  actor: string = READER_INFER_ACTOR,
): Promise<EditionInference[]> {
  const out: EditionInference[] = [];
  for (const item of list) {
    const domain = domainOf(item.url);
    const reason = domain && domain !== '*' ? `${item.reason} (read from ${domain})` : item.reason;
    const r = await inferEditionField(store, {
      edition,
      field: item.field,
      value: item.value,
      reason,
      rule: 'reader',
      inputs: [{ kind: 'source', url: item.url, quote: item.quote }],
      actor,
    });
    if (r.ok) out.push(r.inference);
  }
  return out;
}

function sameInferred(field: InferenceField, own: unknown, inferred: unknown): boolean {
  const a = typeof own === 'string' ? own.trim() : JSON.stringify(own);
  const b = typeof inferred === 'string' ? inferred.trim() : JSON.stringify(inferred);
  if (field === 'startDate' || field === 'endDate') return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

// Resolves one active inference and records the resolution. Returns null when it was not active.
export async function resolveRecorded(
  store: LineupStore,
  editionId: string,
  id: string,
  r: { status: 'confirmed' | 'replaced' | 'rejected'; by: string; reason: string },
): Promise<EditionInference | null> {
  const row = await store.resolveEditionInference(id, r);
  if (!row) return null;
  await recordEditionNote(store, {
    editionId,
    actor: r.by,
    reason: `inferred ${row.field}: ${r.reason}`,
    after: { inferenceResolved: id, status: r.status },
  });
  return row;
}

// Replaces every still-active inference built on these, directly or further down. Visited ids guard against cycles.
async function replaceDescendants(
  store: LineupStore,
  editionId: string,
  parentId: string,
  actor: string,
  reason: string,
  out: EditionInference[],
  visited: Set<string>,
): Promise<void> {
  for (const child of await store.listInferenceChildren(parentId)) {
    if (visited.has(child.id)) continue;
    visited.add(child.id);
    if (child.status === 'active') {
      const row = await resolveRecorded(store, editionId, child.id, { status: 'replaced', by: actor, reason });
      if (row) out.push(row);
    }
    await replaceDescendants(store, editionId, child.id, actor, reason, out, visited);
  }
}

// Runs after a verified or typed value lands on a field. Returns the inferences it resolved.
export async function healEdition(store: LineupStore, editionId: string, edition: Edition, actor: string): Promise<EditionInference[]> {
  const active = (await store.listEditionInferences(editionId)).filter((i) => i.status === 'active');
  const out: EditionInference[] = [];
  const visited = new Set<string>();
  for (const inf of active) {
    // Billing rows are about one act (inferredBilling.ts), never an edition field.
    if (inf.field === 'billing') continue;
    const own = edition[inf.field];
    if (isEmptyValue(own)) continue;
    const status = sameInferred(inf.field, own, inf.value) ? 'confirmed' : 'replaced';
    const row = await resolveRecorded(store, editionId, inf.id, { status, by: actor, reason: 'a verified or typed value arrived' });
    if (!row) continue;
    out.push(row);
    visited.add(row.id);
    // A confirmed value backs what was built on it, so only a replaced one takes its descendants with it.
    if (status === 'replaced') await replaceDescendants(store, editionId, row.id, actor, 'its input was replaced', out, visited);
  }
  return out;
}

export type RejectResult = { ok: true; rows: EditionInference[] } | { ok: false; reason: 'stale' };

// Rejects one active inference and replaces what was built on it. Used by undo.
export async function rejectInference(
  store: LineupStore,
  id: string,
  editionId: string,
  actor: string,
  reason: string,
): Promise<RejectResult> {
  const target = (await store.listEditionInferences(editionId)).find((i) => i.id === id);
  if (!target || target.status !== 'active') return { ok: false, reason: 'stale' };
  const row = await resolveRecorded(store, editionId, id, { status: 'rejected', by: actor, reason });
  const rows: EditionInference[] = row ? [row] : [];
  await replaceDescendants(store, editionId, id, actor, 'its input was rejected', rows, new Set([id]));
  return { ok: true, rows };
}

export type ShownValue =
  | { value: unknown; inferred: false }
  | { value: unknown; inferred: true; reason: string; inferenceId: string };

// The value to show: the edition's own value first, then the active inference for the field, else nothing.
export function shownValue(edition: Edition, field: InferenceField, inferences: EditionInference[]): ShownValue | null {
  const own = edition[field];
  if (!isEmptyValue(own)) return { value: own, inferred: false };
  const active = inferences.find((i) => i.field === field && i.status === 'active');
  if (active) return { value: active.value, inferred: true, reason: active.reason, inferenceId: active.id };
  return null;
}

// An inferred value to show on an event whose own field is still empty. Never written into the event.
export interface InferredField {
  value: unknown;
  reason: string;
  inferenceId: string;
}

// `event` is the resolved event (inherited values filled in), so a field the person typed always wins.
export function inferredFieldsFor(
  event: LoggedEvent,
  inferences: EditionInference[],
): Partial<Record<InferenceField, InferredField>> {
  const out: Partial<Record<InferenceField, InferredField>> = {};
  for (const inf of inferences) {
    if (inf.field === 'billing') continue;
    if (inf.status !== 'active' || out[inf.field]) continue;
    if (!isEmptyValue(event[inf.field])) continue;
    out[inf.field] = { value: inf.value, reason: inf.reason, inferenceId: inf.id };
  }
  return out;
}
