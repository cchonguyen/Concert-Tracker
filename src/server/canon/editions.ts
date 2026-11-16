// The one door for writing a shared edition (slice 11.10). Everything that saves an edition goes through
// writeEdition so each change is recorded with old value, new value, who and why. Nothing outside this file
// and the store implementations may call store.upsertEdition (tests/editionChanges.test.ts checks it).
//
// Atomicity: the row is written first, then its change. There is no Supabase function that does both in one
// call and this slice adds no migration, so a failed change write is retried once, then logged loudly. The row
// write is never rolled back silently; a missing change record is reported by the log, not hidden.
import type { Edition, EditionChange, EditionWeekend } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';

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
  'weekends',
  'hasLineup',
] as const;
type Field = (typeof FIELDS)[number];
const SUMMARY = 'performanceCount';

type Snapshot = Record<string, unknown>;

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
    else s[f] = (e?.[f] as string | boolean | undefined) ?? null;
  }
  s[SUMMARY] = e ? e.performances.length : null;
  return s;
}

export interface WriteEditionInput {
  edition: Edition;
  actor: string;
  reason: string;
  before?: Edition | null;
}

export interface WriteEditionResult {
  changed: boolean;
  change?: EditionChange;
}

export async function writeEdition(store: LineupStore, input: WriteEditionInput): Promise<WriteEditionResult> {
  const existing = input.before !== undefined ? input.before : await store.getEdition(input.edition.id);
  const before = snapshot(existing);
  const after = snapshot(input.edition);
  const b: Snapshot = {};
  const a: Snapshot = {};
  for (const k of [...FIELDS, SUMMARY]) {
    if (!sameValue(before[k], after[k])) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  if (input.before && Object.keys(a).length === 0) return { changed: false };
  await store.upsertEdition(input.edition);
  if (Object.keys(a).length === 0) return { changed: false };
  const rec = { editionId: input.edition.id, actor: input.actor, reason: input.reason, before: b, after: a };
  try {
    return { changed: true, change: await store.recordEditionChange(rec) };
  } catch (err) {
    if (isPersonal(err)) throw err;
    try {
      return { changed: true, change: await store.recordEditionChange(rec) };
    } catch (err2) {
      console.error(`writeEdition: edition ${input.edition.id} saved but its change record failed twice`, err2);
      throw err2;
    }
  }
}

function isPersonal(err: unknown) {
  return err instanceof Error && err.name === 'PersonalFieldError';
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
  const fields = Object.keys(change.after ?? {}).filter((k): k is Field => (FIELDS as readonly string[]).includes(k));
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
  return { ok: true, change: written.change ?? change };
}
