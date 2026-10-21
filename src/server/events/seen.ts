import type { Billing } from '../lineup/billing';
import type { SeenAct, SetKind } from './types';

// Your marks on the acts you saw: DJ set or live set, and B2B pairs. They are
// yours only: no lineup, source or rule sets them. An act in a B2B stays its
// own seen act, so every artist in it is credited with the event.
// Browser-safe: the event view and the Table use it.

export const SET_LABELS: Record<SetKind, string> = { dj: 'DJ set', live: 'Live set' };

export const isSetKind = (v: unknown): v is SetKind => v === 'dj' || v === 'live';

// One act as an event patch sends it (EventPatch.seen).
export interface SeenInput {
  name: string;
  from?: SeenAct['from'];
  role?: Billing | null;
  roleFrom?: SeenAct['roleFrom'];
  favourite?: boolean;
  set?: SetKind | null;
  b2b?: string[]; // keys of the other acts in the B2B
}

// The whole seen list as a patch, keeping every mark, so a change to one act
// never drops another's.
export const toSeenInput = (seen: SeenAct[]): SeenInput[] =>
  seen.map(({ name, from, role, roleFrom, favourite, set, b2b }) => {
    const out: SeenInput = { name, from };
    if (role) Object.assign(out, { role, roleFrom });
    if (favourite) out.favourite = true;
    if (set) out.set = set;
    if (b2b?.length) out.b2b = b2b;
    return out;
  });

// B2B partners as groups of keys. A pair named from either side links both;
// keys not on the event are dropped, and a group needs two acts.
export function b2bGroups(acts: Array<{ key: string; b2b?: string[] }>): string[][] {
  const keys = new Set(acts.map((a) => a.key));
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    const p = parent.get(k) ?? k;
    if (p === k) return k;
    const root = find(p);
    parent.set(k, root);
    return root;
  };
  for (const a of acts) {
    for (const other of a.b2b ?? []) {
      if (!keys.has(other) || other === a.key) continue;
      const [ra, rb] = [find(a.key), find(other)];
      if (ra !== rb) parent.set(rb, ra);
    }
  }
  const groups = new Map<string, string[]>();
  for (const a of acts) {
    const root = find(a.key);
    groups.set(root, [...(groups.get(root) ?? []), a.key]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

// Each act's partners, from the groups: the stored form of SeenAct.b2b.
export function withB2b<T extends { key: string; b2b?: string[] }>(acts: T[]): T[] {
  const partners = new Map<string, string[]>();
  for (const g of b2bGroups(acts)) for (const k of g) partners.set(k, g.filter((x) => x !== k));
  return acts.map((a) => {
    const { b2b: _old, ...rest } = a;
    const b2b = partners.get(a.key);
    return (b2b ? { ...rest, b2b } : rest) as T;
  });
}

// Pair two acts (and whoever is already in a B2B with either).
export function pairB2b(seen: SeenAct[], a: string, b: string): SeenAct[] {
  return withB2b(seen.map((s) => (s.key === a ? { ...s, b2b: [...(s.b2b ?? []), b] } : s)));
}

// Take an act out of its B2B; the others stay paired with each other.
export function leaveB2b(seen: SeenAct[], key: string): SeenAct[] {
  return withB2b(
    seen.map((s) => (s.key === key ? { ...s, b2b: undefined } : { ...s, b2b: s.b2b?.filter((k) => k !== key) })),
  );
}

// Seen acts as slots: a B2B is one slot of several acts, every other act its
// own. Slots keep the order of their first act.
export function seenSlots<T extends { key: string; b2b?: string[] }>(seen: T[]): T[][] {
  const groupOf = new Map<string, string[]>();
  for (const g of b2bGroups(seen)) for (const k of g) groupOf.set(k, g);
  const byKey = new Map(seen.map((s) => [s.key, s]));
  const done = new Set<string>();
  const out: T[][] = [];
  for (const s of seen) {
    if (done.has(s.key)) continue;
    const keys = groupOf.get(s.key) ?? [s.key];
    keys.forEach((k) => done.add(k));
    out.push(keys.map((k) => byKey.get(k)!));
  }
  return out;
}

// "Sasha b2b John Digweed (DJ set)", "Bicep (Live set)", or the bare name.
// Acts in a B2B marked differently each keep their own mark.
export function slotLabel(slot: Array<Pick<SeenAct, 'name' | 'set'>>): string {
  const sets = new Set(slot.map((s) => s.set));
  if (sets.size === 1) {
    const set = slot[0].set;
    const names = slot.map((s) => s.name).join(' b2b ');
    return set ? `${names} (${SET_LABELS[set]})` : names;
  }
  return slot.map((s) => (s.set ? `${s.name} (${SET_LABELS[s.set]})` : s.name)).join(' b2b ');
}
