import type { Billing } from '../lineup/billing';
import type { SeenAct, SetKind } from './types';

// Your marks on the acts you saw: DJ set or live set, and B2B pairs. They are
// yours only: no lineup, source or rule sets them. An act in a B2B stays its
// own seen act, so every artist in it is credited with the event. An act in a
// B2B can also have played on its own at the same event (solo, soloSet): one
// seen act, shown as two slots.
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
  solo?: boolean;
  soloSet?: SetKind | null;
}

// The whole seen list as a patch, keeping every mark, so a change to one act
// never drops another's.
export const toSeenInput = (seen: SeenAct[]): SeenInput[] =>
  seen.map(({ name, from, role, roleFrom, favourite, set, b2b, solo, soloSet }) => {
    const out: SeenInput = { name, from };
    if (role) Object.assign(out, { role, roleFrom });
    if (favourite) out.favourite = true;
    if (set) out.set = set;
    if (b2b?.length) out.b2b = b2b;
    if (solo) out.solo = true;
    if (soloSet) out.soloSet = soloSet;
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

type Linked = { key: string; b2b?: string[]; set?: SetKind; solo?: boolean; soloSet?: SetKind };

// Each act's partners, from the groups: the stored form of SeenAct.b2b. An act
// left out of any B2B that also had a solo set keeps just the solo set.
export function withB2b<T extends Linked>(acts: T[]): T[] {
  const partners = new Map<string, string[]>();
  for (const g of b2bGroups(acts)) for (const k of g) partners.set(k, g.filter((x) => x !== k));
  return acts.map((a) => {
    const { b2b: _old, solo, soloSet, ...rest } = a;
    const b2b = partners.get(a.key);
    if (b2b) return { ...rest, b2b, ...(solo ? { solo } : {}), ...(solo && soloSet ? { soloSet } : {}) } as T;
    if (solo) {
      const { set: _b2bSet, ...plain } = rest;
      return (soloSet ? { ...plain, set: soloSet } : plain) as T;
    }
    return rest as T;
  });
}

// Mark that an act in a B2B also played on its own, or take that back.
export function setSolo(seen: SeenAct[], key: string, solo: boolean): SeenAct[] {
  return seen.map((s) => {
    if (s.key !== key || !s.b2b?.length) return s;
    const { solo: _s, soloSet: _ss, ...rest } = s;
    return solo ? { ...rest, solo: true } : rest;
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

// A slot for the solo set of an act that also played a B2B: the act with its
// solo set as its set, and no partners.
export type SlotAct<T> = T & { asSolo?: boolean };

export const slotId = (slot: Array<SlotAct<{ key: string }>>) => slot.map((s) => s.key).join('+') + (slot[0]?.asSolo ? ':solo' : '');

// Seen acts as slots: a B2B is one slot of several acts, every other act its
// own, and an act in a B2B that also played alone has a solo slot after it.
// Slots keep the order of their first act.
export function seenSlots<T extends Linked>(seen: T[]): Array<Array<SlotAct<T>>> {
  const groupOf = new Map<string, string[]>();
  for (const g of b2bGroups(seen)) for (const k of g) groupOf.set(k, g);
  const byKey = new Map(seen.map((s) => [s.key, s]));
  const done = new Set<string>();
  const out: Array<Array<SlotAct<T>>> = [];
  for (const s of seen) {
    if (done.has(s.key)) continue;
    const keys = groupOf.get(s.key) ?? [s.key];
    keys.forEach((k) => done.add(k));
    const acts = keys.map((k) => byKey.get(k)!);
    out.push(acts);
    for (const a of acts) {
      if (a.solo && keys.length > 1) out.push([{ ...a, b2b: undefined, set: a.soloSet, asSolo: true }]);
    }
  }
  return out;
}

// "Sasha b2b John Digweed (DJ set)", "Bicep (Live set)", "Sasha (solo, DJ set)"
// for the solo set of an act also in a B2B, or the bare name. Acts in a B2B
// marked differently each keep their own mark.
export function slotLabel(slot: Array<SlotAct<Pick<SeenAct, 'name' | 'set'>>>): string {
  if (slot.length === 1 && slot[0].asSolo) {
    const set = slot[0].set;
    return `${slot[0].name} (solo${set ? `, ${SET_LABELS[set]}` : ''})`;
  }
  const sets = new Set(slot.map((s) => s.set));
  if (sets.size === 1) {
    const set = slot[0].set;
    const names = slot.map((s) => s.name).join(' b2b ');
    return set ? `${names} (${SET_LABELS[set]})` : names;
  }
  return slot.map((s) => (s.set ? `${s.name} (${SET_LABELS[s.set]})` : s.name)).join(' b2b ');
}
