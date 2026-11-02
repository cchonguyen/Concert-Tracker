import type { Billing } from '../lineup/billing';
import type { SeenAct, SetKind } from './types';

// Your marks on the acts you saw: DJ set or live set, and B2B pairs. They are
// yours only: no lineup, source or rule sets them. An act in a B2B stays its
// own seen act, so every artist in it is credited with the event. An act in a
// B2B can also have played on its own at the same event (solo, soloSet): one
// seen act, shown as two slots.
// Multiple performances of the same artist (e.g. solo set and B2B set) are
// supported as distinct performance instances.
// Browser-safe: the event view and the Table use it.

export const SET_LABELS: Record<SetKind, string> = { dj: 'DJ set', live: 'Live set' };

export const isSetKind = (v: unknown): v is SetKind => v === 'dj' || v === 'live';

// One act as an event patch sends it (EventPatch.seen).
export interface SeenInput {
  id?: string;
  slotId?: string;
  alias?: string;
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
  seen.map(({ id, slotId, alias, name, from, role, roleFrom, favourite, set, b2b, solo, soloSet }) => {
    const out: SeenInput = { name, from };
    if (id) out.id = id;
    if (slotId) out.slotId = slotId;
    if (alias) out.alias = alias;
    if (role) Object.assign(out, { role, roleFrom });
    if (favourite) out.favourite = true;
    if (set) out.set = set;
    if (b2b?.length) out.b2b = b2b;
    if (solo) out.solo = true;
    if (soloSet) out.soloSet = soloSet;
    return out;
  });

type Linked = { id?: string; slotId?: string; alias?: string; key: string; b2b?: string[]; set?: SetKind; solo?: boolean; soloSet?: SetKind };

// Helper to group performance items into B2B slots by instance identity
function findPerformanceGroups<T>(
  items: T[],
  getKey: (item: T) => string,
  getB2b: (item: T) => string[] | undefined,
  getSlotId: (item: T) => string | undefined,
): number[][] {
  const n = items.length;
  if (!n) return [];
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    let p = parent[i];
    while (p !== parent[p]) p = parent[p];
    parent[i] = p;
    return p;
  };
  const union = (i: number, j: number) => {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) parent[rootJ] = rootI;
  };

  // Group by slotId first
  const bySlotId = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const sid = getSlotId(items[i]);
    if (sid) {
      const list = bySlotId.get(sid) ?? [];
      list.push(i);
      bySlotId.set(sid, list);
    }
  }
  for (const list of bySlotId.values()) {
    for (let k = 1; k < list.length; k++) {
      union(list[0], list[k]);
    }
  }

  // Link by b2b keys
  for (let i = 0; i < n; i++) {
    const b2b = getB2b(items[i]);
    if (!b2b?.length) continue;
    const keyI = getKey(items[i]);
    const sidI = getSlotId(items[i]);

    for (const partnerKey of b2b) {
      if (partnerKey === keyI) continue;
      // Find candidate partner indices
      const candidates: number[] = [];
      for (let j = 0; j < n; j++) {
        if (j !== i && getKey(items[j]) === partnerKey) {
          candidates.push(j);
        }
      }
      if (!candidates.length) continue;

      // Score candidates to pick the best match
      let bestCandidate = -1;
      let bestScore = -1;

      for (const c of candidates) {
        const b2bC = getB2b(items[c]);
        const sidC = getSlotId(items[c]);
        const isReciprocal = Boolean(b2bC?.includes(keyI));
        const sameSlot = Boolean(sidI && sidC && sidI === sidC);

        let score = 0;
        if (isReciprocal && sameSlot) score = 4;
        else if (isReciprocal) score = 3;
        else if (sameSlot) score = 2;
        else if ((!b2bC || b2bC.length === 0) && candidates.length === 1) score = 1;

        if (score > bestScore) {
          bestScore = score;
          bestCandidate = c;
        }
      }

      if (bestScore > 0 && bestCandidate !== -1) {
        union(i, bestCandidate);
      }
    }
  }

  const groupsMap = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groupsMap.get(root) ?? [];
    list.push(i);
    groupsMap.set(root, list);
  }
  return [...groupsMap.values()];
}

// B2B partners as groups of keys. Multiple distinct B2B groups are preserved.
export function b2bGroups(acts: Array<{ key: string; b2b?: string[]; slotId?: string }>): string[][] {
  const groups = findPerformanceGroups(
    acts,
    (a) => a.key,
    (a) => a.b2b,
    (a) => a.slotId,
  );
  return groups
    .filter((g) => g.length > 1)
    .map((g) => [...new Set(g.map((idx) => acts[idx].key))]);
}

// Each act's partners, from the groups: the stored form of SeenAct.b2b. An act
// left out of any B2B that also had a solo set keeps just the solo set.
export function withB2b<T extends Linked>(acts: T[]): T[] {
  const groups = findPerformanceGroups(
    acts,
    (a) => a.key,
    (a) => a.b2b,
    (a) => a.slotId,
  );
  const partnersByIndex = new Map<number, string[]>();
  for (const g of groups) {
    if (g.length > 1) {
      for (const idx of g) {
        const partnerKeys = [...new Set(g.filter((other) => other !== idx).map((other) => acts[other].key))];
        partnersByIndex.set(idx, partnerKeys);
      }
    }
  }

  return acts.map((a, i) => {
    const { b2b: _old, solo, soloSet, ...rest } = a;
    const b2b = partnersByIndex.get(i);
    if (b2b && b2b.length > 0) {
      return {
        ...rest,
        b2b,
        ...(solo ? { solo } : {}),
        ...(solo && soloSet ? { soloSet } : {}),
      } as T;
    }
    if (solo) {
      const { set: _b2bSet, ...plain } = rest;
      return (soloSet ? { ...plain, set: soloSet } : plain) as T;
    }
    return rest as T;
  });
}

// Mark that an act in a B2B also played on its own, or take that back.
export function setSolo(seen: SeenAct[], keyOrId: string, solo: boolean): SeenAct[] {
  return seen.map((s) => {
    const matches = s.id ? s.id === keyOrId : s.key === keyOrId;
    if (!matches || !s.b2b?.length) return s;
    const { solo: _s, soloSet: _ss, ...rest } = s;
    return solo ? { ...rest, solo: true } : rest;
  });
}

// Pair two acts (and whoever is already in a B2B with either).
export function pairB2b(seen: SeenAct[], a: string, b: string): SeenAct[] {
  const idxA = seen.findIndex((s) => s.id === a) !== -1 ? seen.findIndex((s) => s.id === a) : seen.findIndex((s) => s.key === a);
  const idxB = seen.findIndex((s) => s.id === b) !== -1 ? seen.findIndex((s) => s.id === b) : seen.findIndex((s) => s.key === b);
  if (idxA === -1 || idxB === -1 || idxA === idxB) return seen;

  const actA = seen[idxA];
  const actB = seen[idxB];
  const slot = actA.slotId ?? actB.slotId;

  const next = seen.map((s, idx) => {
    if (idx === idxA) {
      return {
        ...s,
        b2b: [...(s.b2b ?? []), actB.key],
        ...(slot ? { slotId: slot } : {}),
      };
    }
    if (idx === idxB) {
      return {
        ...s,
        b2b: [...(s.b2b ?? []), actA.key],
        ...(slot ? { slotId: slot } : {}),
      };
    }
    return s;
  });

  return withB2b(next);
}

// Take an act out of its B2B; the others stay paired with each other.
export function leaveB2b(seen: SeenAct[], keyOrId: string): SeenAct[] {
  const targetIdx = seen.findIndex((s) => s.id === keyOrId) !== -1
    ? seen.findIndex((s) => s.id === keyOrId)
    : seen.findIndex((s) => s.key === keyOrId);
  if (targetIdx === -1) return seen;

  const target = seen[targetIdx];
  const targetKey = target.key;

  const groups = findPerformanceGroups(
    seen,
    (s) => s.key,
    (s) => s.b2b,
    (s) => s.slotId,
  );
  const targetGroup = groups.find((g) => g.includes(targetIdx));

  const next = seen.map((s, idx) => {
    if (idx === targetIdx) {
      const { b2b: _b, slotId: _sid, ...rest } = s;
      return rest as SeenAct;
    }
    if (targetGroup?.includes(idx) && s.b2b?.includes(targetKey)) {
      const remainingB2b = s.b2b.filter((k) => k !== targetKey);
      return {
        ...s,
        b2b: remainingB2b.length > 0 ? remainingB2b : undefined,
      };
    }
    return s;
  });

  return withB2b(next);
}

// A slot for the solo set of an act that also played a B2B: the act with its
// solo set as its set, and no partners.
export type SlotAct<T> = T & { asSolo?: boolean };

export const slotId = (slot: Array<SlotAct<{ key: string; id?: string; slotId?: string }>>) => {
  if (slot[0]?.slotId) return slot[0].slotId + (slot[0]?.asSolo ? ':solo' : '');
  const idPrefix = slot[0]?.id ? `${slot[0].id}:` : '';
  return idPrefix + slot.map((s) => s.key).join('+') + (slot[0]?.asSolo ? ':solo' : '');
};

// Seen acts as slots: a B2B is one slot of several acts, every other act its
// own, and an act in a B2B that also played alone has a solo slot after it.
// Slots keep the order of their first act. Multiple performance instances of
// the same artist produce distinct slots without key collision.
export function seenSlots<T extends Linked>(seen: T[]): Array<Array<SlotAct<T>>> {
  const groups = findPerformanceGroups(
    seen,
    (s) => s.key,
    (s) => s.b2b,
    (s) => s.slotId,
  );
  const groupOfIndex = new Map<number, number[]>();
  for (const g of groups) {
    if (g.length > 1) {
      for (const idx of g) groupOfIndex.set(idx, g);
    }
  }

  const done = new Set<number>();
  const out: Array<Array<SlotAct<T>>> = [];

  for (let i = 0; i < seen.length; i++) {
    if (done.has(i)) continue;
    const group = groupOfIndex.get(i);
    if (group) {
      group.forEach((idx) => done.add(idx));
      const acts = group.map((idx) => seen[idx]);
      out.push(acts);
      for (const a of acts) {
        if (a.solo) {
          out.push([{ ...a, b2b: undefined, set: a.soloSet, asSolo: true }]);
        }
      }
    } else {
      done.add(i);
      const act = seen[i];
      out.push([act]);
      if (act.solo && act.b2b?.length) {
        out.push([{ ...act, b2b: undefined, set: act.soloSet, asSolo: true }]);
      }
    }
  }

  return out;
}

// Group EditionPerformance items into B2B slots for the Lineup UI
export function lineupSlots<T extends { artistKey: string; b2b?: string[]; name: string; slotId?: string }>(
  performances: T[],
): Array<Array<T>> {
  const groups = findPerformanceGroups(
    performances,
    (p) => p.artistKey,
    (p) => p.b2b,
    (p) => p.slotId,
  );
  const groupOfIndex = new Map<number, number[]>();
  for (const g of groups) {
    if (g.length > 1) {
      for (const idx of g) groupOfIndex.set(idx, g);
    }
  }

  const done = new Set<number>();
  const out: Array<Array<T>> = [];

  for (let i = 0; i < performances.length; i++) {
    if (done.has(i)) continue;
    const group = groupOfIndex.get(i);
    if (group) {
      group.forEach((idx) => done.add(idx));
      out.push(group.map((idx) => performances[idx]));
    } else {
      done.add(i);
      out.push([performances[i]]);
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
