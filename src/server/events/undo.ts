import type { LineupStore } from '../lineup/store/types';
import { canonicalIds, checkUndo } from './activityLog';
import type { LoggedEvent } from './types';

export type UndoOutcome =
  | { ok: true }
  | { ok: false; reason: 'not-found' | 'not-undoable' | 'gone' | 'vault-locked' | 'value-changed' | 'person-gone' };

// Reverse one Log row, using only the store's own methods, so both stores and the member scope behave the same.
// A field edit is written back only if the field still holds the value the row logged. Adds go to Recently deleted;
// deletes and restores swap back. A sensitive row (notes, companions) writes back its stored ciphertext, and only when the
// caller says the vault is unlocked. The server cannot see the vault, so the caller says so; a missing answer counts as locked.
// Person ids are written back only while every one of those people is still a live person of yours.
export async function undoActivity(store: LineupStore, activityId: string, vaultLocked = true): Promise<UndoOutcome> {
  const entry = (await store.listActivity(500)).find((a) => a.id === activityId);
  if (!entry) return { ok: false, reason: 'not-found' };
  if (!entry.eventId) return { ok: false, reason: 'not-undoable' };
  const eventId = entry.eventId;

  if (entry.action === 'create' || entry.action === 'restore') {
    if (!(await store.getEvent(eventId))) return { ok: false, reason: 'gone' };
    await store.deleteEvent(eventId);
    return { ok: true };
  }
  if (entry.action === 'delete') {
    return (await store.restoreEvent(eventId)) ? { ok: true } : { ok: false, reason: 'gone' };
  }
  if (entry.action === 'update' && entry.field) {
    const ev = await store.getEvent(eventId);
    if (!ev) return { ok: false, reason: 'gone' };
    const field = entry.field;
    const current = field === 'personIds' ? canonicalIds(ev.personIds) : (ev as unknown as Record<string, unknown>)[field] ?? null;
    const check = checkUndo(entry, current, vaultLocked);
    if (!check.ok) return check;
    if (field === 'personIds') {
      const ids = (entry.before as string[] | null) ?? [];
      if (!(await allPeopleLive(store, ids))) return { ok: false, reason: 'person-gone' };
      await store.putEvent({ ...ev, personIds: ids });
      return { ok: true };
    }
    await store.putEvent({ ...ev, [field]: entry.before ?? null } as LoggedEvent);
    return { ok: true };
  }
  return { ok: false, reason: 'not-undoable' };
}

// True when every id is a person of yours that has not been merged into another.
async function allPeopleLive(store: LineupStore, ids: string[]): Promise<boolean> {
  if (!ids.length) return true;
  const live = new Set((await store.listEntities()).filter((e) => e.kind === 'person' && !e.mergedIntoId).map((e) => e.id));
  return ids.every((id) => live.has(id));
}
