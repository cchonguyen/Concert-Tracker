// The one door for writing a shared edition. Everything that saves an edition goes through
// writeEdition so each change is recorded with old value, new value, who and why. Nothing outside this file
// and the store implementations may call store.upsertEdition (tests/editionChanges.test.ts checks it).
//
// Atomicity: the row is written first, then its change. There is no Supabase function that does both in one
// call and this slice adds no migration, so a failed change write is retried once, then logged loudly. The row
// write is never rolled back silently; a missing change record is reported by the log, not hidden.
import type { Edition, EditionChange, EditionPerformance, EditionWeekend, InferenceField } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';
import { runReserved } from '../lineup/budget';
import { editionVerified, verifyAct, type ActEvidence, type ActExpectation, type ActVerdict, type EditionFieldFacts } from './autoVerify';

const FIELDS = [
  'name',
  'startDate',
  'endDate',
  'venue',
  'city',
  'region',
  'country',
  'status',
  'venueId',
  'subjectKey',
  'seriesSlug',
  'subtitle',
  'weekends',
  'hasLineup',
] as const;
type Field = (typeof FIELDS)[number];
const SUMMARY = 'performanceCount';

type Snapshot = Record<string, unknown>;
type ChangeRecord = Parameters<LineupStore['recordEditionChange']>[0];

// Inferred values (docs/specs/inferred-values.md). Re-exported by inferences.ts.
export const INFERENCE_ADDED_KEY = 'inferenceAdded';
// Set on a change that wrote an inferred value into a field because the owner or two members confirmed it. Undo sets the inference back to active.
export const INFERENCE_CONFIRMED_KEY = 'inferenceConfirmed';
export const INFERENCE_FIELDS: readonly InferenceField[] = ['startDate', 'endDate', 'venue', 'city', 'region', 'country'];

export function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function normalizeWeekends(weekends: EditionWeekend[] | undefined): EditionWeekend[] | null {
  if (!weekends || weekends.length === 0) return null;
  return weekends.map((w) => ({
    weekend: w.weekend,
    startDate: w.startDate,
    ...(w.endDate ? { endDate: w.endDate } : {}),
  }));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function snapshot(e: Edition | null): Snapshot {
  const s: Snapshot = {};
  for (const f of FIELDS) {
    if (f === 'weekends') s[f] = normalizeWeekends(e?.weekends);
    else if (f === 'subtitle') s[f] = e?.subtitle?.trim() || null;
    else s[f] = (e?.[f] as string | boolean | undefined) ?? null;
  }
  s[SUMMARY] = e ? e.performances.length : null;
  s.weather = e?.weather ?? null;
  return s;
}

export interface WriteEditionInput {
  edition: Edition;
  actor: string;
  reason: string;
  before?: Edition | null;
  // Extra keys recorded with the change (e.g. the act an add or undo touched). Not diffed.
  extra?: { before?: Snapshot; after?: Snapshot };
}

export interface WriteEditionResult {
  changed: boolean;
  change?: EditionChange;
}

export async function writeEdition(store: LineupStore, rawInput: WriteEditionInput): Promise<WriteEditionResult> {
  const existing = rawInput.before !== undefined ? rawInput.before : await store.getEdition(rawInput.edition.id);
  // An edition without a subtitle key keeps the stored one (0058), so it is not recorded as a removal.
  const input =
    rawInput.edition.subtitle === undefined && existing?.subtitle
      ? { ...rawInput, edition: { ...rawInput.edition, subtitle: existing.subtitle } }
      : rawInput;
  const before = snapshot(existing);
  // An edition without a weather key keeps the stored record, so it is not recorded as a removal.
  const after = snapshot(input.edition.weather === undefined ? { ...input.edition, weather: existing?.weather } : input.edition);
  const b: Snapshot = {};
  const a: Snapshot = {};
  for (const k of [...FIELDS, SUMMARY, 'weather']) {
    if (!sameValue(before[k], after[k])) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  if (input.before && Object.keys(a).length === 0) return { changed: false };
  await store.upsertEdition(input.edition);
  // A change that writes no shared field itself (an act's verification status) is recorded when the caller names it in extra.after.
  if (Object.keys(a).length === 0 && !input.extra?.after) return { changed: false };
  const rec = {
    editionId: input.edition.id,
    actor: input.actor,
    reason: input.reason,
    before: { ...b, ...(input.extra?.before ?? {}) },
    after: { ...a, ...(input.extra?.after ?? {}) },
  };
  // The edition is already saved, so its change record may use the request budget's reserve:
  // a spent budget must not leave a saved change without its history row.
  const change = await recordChange(store, rec);
  await healAfterWrite(store, input.edition, existing, input.actor);
  return { changed: true, change };
}

// Writes one change record. A personal-field refusal is not retried; any other failure is retried once.
async function recordChange(store: LineupStore, rec: ChangeRecord): Promise<EditionChange> {
  // The edition is already saved, so its change record may use the request budget's reserve:
  // a spent budget must not leave a saved change without its history row.
  const record = () => runReserved(() => store.recordEditionChange(rec));
  try {
    return await record();
  } catch (err) {
    if (isPersonal(err)) throw err;
    try {
      return await record();
    } catch (err2) {
      console.error(`change record for edition ${rec.editionId} failed twice`, err2);
      throw err2;
    }
  }
}

// Records a change that writes no shared field (an inference added, resolved or rejected). The edition row is not touched.
export interface EditionNoteInput {
  editionId: string;
  actor: string;
  reason: string;
  after: Snapshot;
}

export async function recordEditionNote(store: LineupStore, input: EditionNoteInput): Promise<EditionChange> {
  return recordChange(store, { editionId: input.editionId, actor: input.actor, reason: input.reason, before: {}, after: input.after });
}

// A value that lands on an empty inferred field re-checks the inferences on that field (docs/specs/inferred-values.md).
// It is best-effort: a store without the inference methods, or a missing table, must never fail the save.
async function healAfterWrite(store: LineupStore, edition: Edition, existing: Edition | null | undefined, actor: string): Promise<void> {
  const filled = INFERENCE_FIELDS.some((f) => isEmptyValue(existing?.[f]) && !isEmptyValue(edition[f]));
  if (!filled) return;
  try {
    const { healEdition } = await import('./inferences');
    await healEdition(store, edition.id, edition, actor);
  } catch (err) {
    console.error(`inferred values of edition ${edition.id} were not re-checked after a save`, err);
  }
}

function isPersonal(err: unknown) {
  return err instanceof Error && err.name === 'PersonalFieldError';
}

// Undo of an inference: the inference is rejected and what was built on it is replaced.
async function undoInference(store: LineupStore, edition: Edition, change: EditionChange, inferenceId: string, actor: string): Promise<UndoResult> {
  const { rejectInference } = await import('./inferences');
  const rejected = await rejectInference(store, inferenceId, edition.id, actor, `undo of ${change.id}`);
  if (!rejected.ok) return { ok: false, reason: 'stale' };
  await store.markChangeUndone(change.id);
  return { ok: true, change };
}

// Undo of a confirmed write: the inference goes back to active (its votes stay). Recorded like other resolutions.
async function reactivateConfirmed(store: LineupStore, editionId: string, inferenceId: string, actor: string, changeId: string): Promise<void> {
  const row = await store.reactivateEditionInference(inferenceId, { by: actor, reason: `undo of ${changeId}` });
  if (!row) return;
  await recordEditionNote(store, {
    editionId,
    actor,
    reason: `inferred ${row.field}: back to inferred after undo of ${changeId}`,
    after: { inferenceReactivated: inferenceId },
  });
}

export type UndoResult =
  | { ok: true; change: EditionChange }
  | { ok: false; reason: 'unknown' | 'already_undone' | 'stale' | 'not_undoable' };

export async function undoEditionChange(store: LineupStore, editionId: string, changeId: string, actor: string): Promise<UndoResult> {
  const change = (await store.listEditionChanges(editionId)).find((c) => c.id === changeId);
  if (!change) return { ok: false, reason: 'unknown' };
  if (change.undoneAt) return { ok: false, reason: 'already_undone' };
  const edition = await store.getEdition(editionId);
  if (!edition) return { ok: false, reason: 'unknown' };
  const inferred = (change.after as Snapshot | null)?.[INFERENCE_ADDED_KEY];
  if (typeof inferred === 'string') return undoInference(store, edition, change, inferred, actor);
  const autoEdition = (change.after as Snapshot | null)?.[AUTO_EDITION_KEY];
  if (typeof autoEdition === 'string') return undoAutoEdition(store, edition, change, actor);
  const autoAct = (change.after as Snapshot | null)?.[AUTO_VERIFY_KEY];
  if (typeof autoAct === 'string') return undoAutoVerify(store, edition, change, autoAct, actor);
  const addedAct = (change.after as Snapshot | null)?.lineupActAdded;
  if (typeof addedAct === 'string') return undoLineupAct(store, edition, change, addedAct, actor);
  const tickAct = (change.after as Snapshot | null)?.[MEMBER_TICK_KEY];
  if (typeof tickAct === 'string') return undoMemberTick(store, edition, change, tickAct, actor);
  // weather is recorded with the field edits. It is restored to null when the change had none.
  const fields = Object.keys(change.after ?? {}).filter((k): k is Field | 'weather' => (FIELDS as readonly string[]).includes(k) || k === 'weather');
  const before = change.before ?? {};
  // The edition's first write (name was empty before) and summary-only changes cannot be rolled back as a field edit.
  if (fields.length === 0 || ('name' in before && before.name == null)) return { ok: false, reason: 'not_undoable' };
  const current = snapshot(edition);
  // A later change touched these fields when the edition no longer holds what this change wrote.
  if (fields.some((f) => !sameValue(current[f], (change.after as Snapshot)[f]))) return { ok: false, reason: 'stale' };
  const restored = { ...edition, updatedAt: new Date().toISOString() } as Edition;
  for (const f of fields) {
    if (f === 'weekends') {
      restored.weekends = Array.isArray(before[f]) ? normalizeWeekends(before[f] as EditionWeekend[]) ?? undefined : undefined;
    } else if (f === 'weather') {
      restored.weather = (before.weather as Edition['weather']) ?? null;
    } else if (f === 'subtitle') {
      // '' clears it: an absent subtitle would keep the stored one.
      restored.subtitle = (before.subtitle as string | null) ?? '';
    } else if (f === 'seriesSlug') {
      const prev = before[f] ?? undefined;
      restored.seriesSlug = prev as string | undefined;
      if (!prev) {
        delete restored.seriesName;
        delete restored.seriesBrand;
        delete restored.seriesAliases;
        delete restored.seriesKind;
        delete restored.seriesCity;
        delete restored.seriesRegion;
        delete restored.seriesCountry;
      }
    } else {
      (restored as any)[f] = before[f] ?? undefined;
    }
  }
  const written = await writeEdition(store, { edition: restored, actor, reason: `undo of ${changeId}` });
  await store.markChangeUndone(changeId);
  const confirmed = (change.after as Snapshot | null)?.[INFERENCE_CONFIRMED_KEY];
  if (typeof confirmed === 'string') await reactivateConfirmed(store, editionId, confirmed, actor, changeId);
  return { ok: true, change: written.change ?? change };
}

// Shared lineup from the edition's name. An act added this way is the only performance with a
// single 'edition name' source. The change record carries its artist key so undo can remove that act.
export const LINEUP_NAME_KEY = 'lineupActAdded';

export interface AddEditionActInput {
  editionId: string;
  artistKey: string;
  artistName: string;
  actor: string;
  reason: string;
}

export type AddEditionActResult =
  | { ok: true; changeId: string | null }
  | { ok: false; reason: 'unknown' | 'already_listed' };

export async function addEditionAct(store: LineupStore, input: AddEditionActInput): Promise<AddEditionActResult> {
  const edition = await store.getEdition(input.editionId);
  if (!edition) return { ok: false, reason: 'unknown' };
  if (edition.performances.some((p) => p.artistKey === input.artistKey)) return { ok: false, reason: 'already_listed' };
  const act: EditionPerformance = {
    artistKey: input.artistKey,
    name: input.artistName,
    days: [],
    stages: [],
    status: 'billed',
    confidence: 0,
    sources: [
      {
        sourceType: 'edition name',
        sourceUrl: `edition:${edition.id}`,
        quotedSpan: edition.name,
        evidence: 'billed',
        extractor: 'edition-name-match',
      },
    ],
  };
  const next: Edition = { ...edition, performances: [...edition.performances, act], updatedAt: new Date().toISOString() };
  const written = await writeEdition(store, {
    edition: next,
    actor: input.actor,
    reason: input.reason,
    extra: { after: { [LINEUP_NAME_KEY]: input.artistKey } },
  });
  return { ok: true, changeId: written.change?.id ?? null };
}

// Member tick: undo removes only a candidate act still sourced from a single "your entry" tick.
// An act that an owner or a source has since changed is left alone.
export const MEMBER_TICK_KEY = 'memberTickAct';

async function undoMemberTick(store: LineupStore, edition: Edition, change: EditionChange, artistKey: string, actor: string): Promise<UndoResult> {
  const idx = edition.performances.findIndex((p) => p.artistKey === artistKey);
  if (idx < 0) return { ok: false, reason: 'stale' };
  const act = edition.performances[idx];
  if (act.verification !== 'candidate' || act.sources.length !== 1 || act.sources[0].extractor !== 'your entry') return { ok: false, reason: 'stale' };
  const next: Edition = {
    ...edition,
    performances: edition.performances.filter((_, i) => i !== idx),
    updatedAt: new Date().toISOString(),
  };
  const written = await writeEdition(store, { edition: next, actor, reason: `undo of ${change.id}` });
  await store.markChangeUndone(change.id);
  return { ok: true, change: written.change ?? change };
}

async function undoLineupAct(store: LineupStore, edition: Edition, change: EditionChange, artistKey: string, actor: string): Promise<UndoResult> {
  const idx = edition.performances.findIndex((p) => p.artistKey === artistKey);
  if (idx < 0) return { ok: false, reason: 'stale' };
  const act = edition.performances[idx];
  // Edited since it was added (more sources or a different source): leave it to the owner.
  if (act.sources.length !== 1 || act.sources[0].sourceType !== 'edition name') return { ok: false, reason: 'stale' };
  const next: Edition = {
    ...edition,
    performances: edition.performances.filter((_, i) => i !== idx),
    updatedAt: new Date().toISOString(),
  };
  const written = await writeEdition(store, {
    edition: next,
    actor,
    reason: `undo of ${change.id}`,
    extra: { before: { [LINEUP_NAME_KEY]: artistKey } },
  });
  await store.markChangeUndone(change.id);
  return { ok: true, change: written.change ?? change };
}

// Auto-verify of an act already on a shared edition (docs/auto-verify-spec.md). Only a candidate
// act becomes verified, and only when verifyAct says so. The change records the act and its previous
// status, so undo puts it back. Nothing is added here and no personal field is written.
export const AUTO_VERIFY_KEY = 'autoVerifiedAct';
export const AUTO_VERIFY_PREVIOUS_KEY = 'autoVerifiedPrevious';

export interface AutoVerifyActInput {
  editionId: string;
  artistKey: string;
  evidence: readonly ActEvidence[];
  expected: ActExpectation;
  actor: string;
  reason: string;
}

export type AutoVerifyActResult =
  | { ok: true; changed: boolean; changeId: string | null; verdict: ActVerdict }
  | { ok: false; reason: 'unknown' };

export async function autoVerifyAct(store: LineupStore, input: AutoVerifyActInput): Promise<AutoVerifyActResult> {
  const edition = await store.getEdition(input.editionId);
  if (!edition) return { ok: false, reason: 'unknown' };
  const verdict = verifyAct(input.evidence, input.expected);
  const idx = edition.performances.findIndex((p) => p.artistKey === input.artistKey);
  const current = idx >= 0 ? edition.performances[idx] : undefined;
  // Acts stored before migration 0052 have no status and read as verified.
  if (!current || verdict.status !== 'verified' || (current.verification ?? 'verified') === 'verified') {
    return { ok: true, changed: false, changeId: null, verdict };
  }
  const performances = edition.performances.map((p, i) => (i === idx ? { ...p, verification: 'verified' as const } : p));
  const next: Edition = { ...edition, performances, updatedAt: new Date().toISOString() };
  const written = await writeEdition(store, {
    edition: next,
    actor: input.actor,
    reason: input.reason,
    extra: {
      before: { [AUTO_VERIFY_KEY]: input.artistKey, [AUTO_VERIFY_PREVIOUS_KEY]: 'candidate' },
      after: { [AUTO_VERIFY_KEY]: input.artistKey },
    },
  });
  return { ok: true, changed: true, changeId: written.change?.id ?? null, verdict };
}

async function undoAutoVerify(store: LineupStore, edition: Edition, change: EditionChange, artistKey: string, actor: string): Promise<UndoResult> {
  const idx = edition.performances.findIndex((p) => p.artistKey === artistKey);
  if (idx < 0) return { ok: false, reason: 'stale' };
  // Changed since the auto-verify (for example, the owner set it again): leave it to the owner.
  if (edition.performances[idx].verification !== 'verified') return { ok: false, reason: 'stale' };
  const performances = edition.performances.map((p, i) => (i === idx ? { ...p, verification: 'candidate' as const } : p));
  const next: Edition = { ...edition, performances, updatedAt: new Date().toISOString() };
  const written = await writeEdition(store, {
    edition: next,
    actor,
    reason: `undo of ${change.id}`,
    extra: { before: { [AUTO_VERIFY_KEY]: artistKey }, after: { [AUTO_VERIFY_KEY]: null } },
  });
  await store.markChangeUndone(change.id);
  return { ok: true, change: written.change ?? change };
}

// Auto-verify of a provisional edition (docs/auto-verify-spec.md). The edition becomes verified
// only when name, act, location, venue and date each come from a verified source. The change records the
// previous status, so undo puts the edition back to provisional.
export const AUTO_EDITION_KEY = 'autoVerifiedEdition';

export interface AutoVerifyEditionInput {
  editionId: string;
  facts: EditionFieldFacts;
  actor: string;
  reason: string;
}

export type AutoVerifyEditionResult =
  | { ok: true; changed: boolean; changeId: string | null }
  | { ok: false; reason: 'unknown' };

export async function autoVerifyEdition(store: LineupStore, input: AutoVerifyEditionInput): Promise<AutoVerifyEditionResult> {
  const edition = await store.getEdition(input.editionId);
  if (!edition) return { ok: false, reason: 'unknown' };
  if (edition.status !== 'provisional' || !editionVerified(input.facts)) {
    return { ok: true, changed: false, changeId: null };
  }
  const next: Edition = { ...edition, status: 'verified', updatedAt: new Date().toISOString() };
  const written = await writeEdition(store, {
    edition: next,
    actor: input.actor,
    reason: input.reason,
    extra: {
      before: { [AUTO_EDITION_KEY]: 'provisional' },
      after: { [AUTO_EDITION_KEY]: 'verified' },
    },
  });
  return { ok: true, changed: written.changed, changeId: written.change?.id ?? null };
}

async function undoAutoEdition(store: LineupStore, edition: Edition, change: EditionChange, actor: string): Promise<UndoResult> {
  // Changed since the auto-verify (the owner set the status again): leave it to the owner.
  if (edition.status !== 'verified') return { ok: false, reason: 'stale' };
  const previous = ((change.before ?? {}) as Snapshot)[AUTO_EDITION_KEY];
  const next: Edition = { ...edition, status: (typeof previous === 'string' ? previous : 'provisional') as Edition['status'], updatedAt: new Date().toISOString() };
  const written = await writeEdition(store, {
    edition: next,
    actor,
    reason: `undo of ${change.id}`,
    extra: { before: { [AUTO_EDITION_KEY]: 'verified' }, after: { [AUTO_EDITION_KEY]: null } },
  });
  await store.markChangeUndone(change.id);
  return { ok: true, change: written.change ?? change };
}
