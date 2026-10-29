// The activity log's rules, kept pure so they can be tested without a database.
// Undo writes a value back only if the field still holds the value the change wrote.
// That is the same rule as the sync rule: never overwrite a newer edit with an older copy.

export type ActivityAction = 'create' | 'update' | 'delete' | 'restore' | 'undo';

export interface ActivityEntry {
  id: string;
  eventId: string | null;
  action: ActivityAction;
  field: string | null;
  before: unknown;
  after: unknown;
  sensitive: boolean; // notes and companions: stored as ciphertext, never printed
  at: string;
}

// Fields whose text is private. The log says that they changed, not what they say.
export const SENSITIVE_FIELDS = new Set(['notes', 'companions']);

export function isSensitiveField(field: string): boolean {
  return SENSITIVE_FIELDS.has(field);
}

// Fixed wording for a row. Sensitive rows never include before or after.
export function describeEntry(entry: ActivityEntry, eventName: string): string {
  if (entry.action === 'delete') return `You deleted ${eventName}`;
  if (entry.action === 'restore') return `You restored ${eventName}`;
  if (entry.action === 'create') return `You added ${eventName}`;
  if (entry.action === 'undo') return `You undid a change to ${eventName}`;
  if (entry.field === 'notes') return `You updated the notes of ${eventName}`;
  if (entry.field === 'companions') return `You updated who you went with at ${eventName}`;
  return `You changed ${entry.field ?? 'a field'} of ${eventName}`;
}

export type UndoCheck = { ok: true } | { ok: false; reason: 'vault-locked' | 'value-changed' };

// Decide whether an undo may write back. A sensitive field needs the vault unlocked.
// Any field changed since the logged write is left alone.
export function checkUndo(entry: ActivityEntry, current: unknown, vaultLocked: boolean): UndoCheck {
  if (entry.sensitive && vaultLocked) return { ok: false, reason: 'vault-locked' };
  if (!sameValue(current, entry.after)) return { ok: false, reason: 'value-changed' };
  return { ok: true };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
