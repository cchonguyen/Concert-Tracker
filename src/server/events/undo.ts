import type { LineupStore } from '../lineup/store/types';
import { checkUndo } from './activityLog';
import type { LoggedEvent } from './types';

export type UndoOutcome = { ok: true } | { ok: false; reason: 'not-found' | 'not-undoable' | 'gone' | 'vault-locked' | 'value-changed' };

// Reverse one Log row, using only the store's own methods, so both stores and the member scope behave the same.
// A field edit is written back only if the field still holds the value the row logged. Adds go to Recently deleted;
// deletes and restores swap back. A sensitive row (notes, companions) writes back its stored ciphertext, and only when the
// caller says the vault is unlocked. The server cannot see the vault, so the caller says so; a missing answer counts as locked.
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
    const current = (ev as unknown as Record<string, unknown>)[field] ?? null;
    const check = checkUndo(entry, current, vaultLocked);
    if (!check.ok) return check;
    await store.putEvent({ ...ev, [field]: entry.before ?? null } as LoggedEvent);
    return { ok: true };
  }
  return { ok: false, reason: 'not-undoable' };
}
