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
  sensitive: boolean; // notes, companions and people: stored as ciphertext or ids, never printed
  at: string;
}

// Fields whose text is private. The log says that they changed, not what they say.
// `personIds` are the ids of the people you went with (vault on): opaque, but still who you went with.
export const SENSITIVE_FIELDS = new Set(['notes', 'companions', 'personIds']);

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
  if (entry.field === 'companions' || entry.field === 'personIds') return `You updated who you went with at ${eventName}`;
  return `You changed ${entry.field ?? 'a field'} of ${eventName}`;
}

export type UndoCheck = { ok: true } | { ok: false; reason: 'vault-locked' | 'value-changed' | 'not-undoable' };

// Decide whether an undo may write back. A sensitive field needs the vault unlocked, and a sensitive
// row that stored no ciphertext (plaintext notes, or rows from before the vault) has nothing to write back.
// A note whose earlier value is not stored is never written back as empty: that would erase it.
// Any field changed since the logged write is left alone.
export function checkUndo(entry: ActivityEntry, current: unknown, vaultLocked: boolean): UndoCheck {
  if (entry.sensitive && vaultLocked) return { ok: false, reason: 'vault-locked' };
  if (entry.sensitive && entry.before === null && entry.after === null) return { ok: false, reason: 'not-undoable' };
  if (entry.field === 'notes' && entry.before === null) return { ok: false, reason: 'not-undoable' };
  if (!sameValue(current, entry.after)) return { ok: false, reason: 'value-changed' };
  return { ok: true };
}

// Person ids as the log and the event hold them: an empty list and no list are the same thing.
export function canonicalIds(v: unknown): string[] | null {
  return Array.isArray(v) && v.length ? (v as string[]) : null;
}

// Private text that is not ciphertext (plaintext notes, names in companions) is never kept.
function hasText(v: unknown): boolean {
  return v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);
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
    if (key === 'personIds') {
      drafts.push({ eventId: after.id, action: 'update', field: key, before: canonicalIds(b), after: canonicalIds(a), sensitive });
      continue;
    }
    // Plaintext private text is never kept in the Log. When the change drops such text, the row keeps neither side:
    // undoing it would write back nothing, and writing null over the text would lose it.
    const lost = sensitive && hasText(b) && !isCipher(b);
    const kept = (v: unknown) => (sensitive && !isCipher(v) ? null : v ?? null);
    drafts.push({ eventId: after.id, action: 'update', field: key, before: lost ? null : kept(b), after: lost ? null : kept(a), sensitive });
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
