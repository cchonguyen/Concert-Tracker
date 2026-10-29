import type { LoggedEvent } from './types';

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

export type UndoCheck = { ok: true } | { ok: false; reason: 'vault-locked' | 'value-changed' | 'not-undoable' };

// Decide whether an undo may write back. A sensitive field needs the vault unlocked, and a sensitive
// row that stored no ciphertext (plaintext notes, or rows from before the vault) has nothing to write back.
// Any field changed since the logged write is left alone.
export function checkUndo(entry: ActivityEntry, current: unknown, vaultLocked: boolean): UndoCheck {
  if (entry.sensitive && vaultLocked) return { ok: false, reason: 'vault-locked' };
  if (entry.sensitive && entry.before === null && entry.after === null) return { ok: false, reason: 'not-undoable' };
  if (!sameValue(current, entry.after)) return { ok: false, reason: 'value-changed' };
  return { ok: true };
}

function sameValue(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

// One row the store writes. A sensitive field keeps its value only when it is ciphertext (the vault is on),
// so undo can write the exact stored text back without the Log ever holding readable text.
export interface ActivityDraft {
  eventId: string;
  action: ActivityAction;
  field: string | null;
  before: unknown;
  after: unknown;
  sensitive: boolean;
}

// Fields that are bookkeeping, not something you chose. They never make a log row.
const IGNORED_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt']);

// Work out what changed between the stored event and the one being saved.
// A new event gives one 'create' row; an edit gives one 'update' row per changed field.
// `isCipher` says whether a value is vault ciphertext (the server passes its check; the pure rules do not import it).
export function diffEvent(before: LoggedEvent | null, after: LoggedEvent, isCipher: (v: unknown) => boolean = () => false): ActivityDraft[] {
  if (!before) return [{ eventId: after.id, action: 'create', field: null, before: null, after: null, sensitive: false }];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const drafts: ActivityDraft[] = [];
  for (const key of [...keys].sort()) {
    if (IGNORED_FIELDS.has(key)) continue;
    const b = (before as unknown as Record<string, unknown>)[key];
    const a = (after as unknown as Record<string, unknown>)[key];
    if (stableJson(b) === stableJson(a)) continue;
    const sensitive = isSensitiveField(key);
    // Plaintext private text is never kept in the Log.
    const kept = (v: unknown) => (sensitive && !isCipher(v) ? null : v ?? null);
    drafts.push({ eventId: after.id, action: 'update', field: key, before: kept(b), after: kept(a), sensitive });
  }
  return drafts;
}

// Key order must not matter: a row read back from the database can list keys in another order.
export function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
