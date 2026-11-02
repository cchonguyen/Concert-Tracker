// Which acts the review screen starts from. A first review starts from the
// lookup's candidate; reopening a confirmed lineup starts from what you saved,
// so earlier keeps, rejections, renames and hand-added acts carry over.
import { readActName } from '../server/lineup/actName';
import { normalizeName } from '../server/lineup/text';
import type { CandidatePerformer, Edition, EditionPerformance } from '../server/lineup/types';

export interface StartRow {
  key?: string;
  seenKey: string; // the key a seen act would have
  slotId?: string;
  alias?: string;
  b2b?: string[];
  name: string;
  accepted: boolean;
  cancelled: boolean;
  billing?: string;
  days: string[];
  stages: string[];
  candidate?: CandidatePerformer;
}

const sameSource = (a: EditionPerformance, c: CandidatePerformer) =>
  a.sources.some((s) => c.sources.some((t) => t.sourceUrl === s.sourceUrl && t.quotedSpan === s.quotedSpan));

const b2bEqual = (a?: string[], b?: string[]) => {
  const sa = [...(a ?? [])].sort().join(',');
  const sb = [...(b ?? [])].sort().join(',');
  return sa === sb;
};

function unpackCandidates(list: CandidatePerformer[]): CandidatePerformer[] {
  const result: CandidatePerformer[] = [];
  for (const p of list) {
    if (p.b2b?.length) {
      result.push(p);
      continue;
    }
    const read = readActName(p.name);
    if (read.parts.length <= 1) {
      result.push(p);
      continue;
    }
    const allKeys = read.parts.map(normalizeName).filter(Boolean);
    if (allKeys.length <= 1) {
      result.push(p);
      continue;
    }
    const slotId = p.slotId || crypto.randomUUID();
    for (const part of read.parts) {
      const key = normalizeName(part);
      result.push({
        ...p,
        key,
        name: part,
        slotId,
        alias: p.alias,
        b2b: allKeys.filter((k) => k !== key),
      });
    }
  }
  return result;
}

function unpackPerformances(list: EditionPerformance[]): EditionPerformance[] {
  const result: EditionPerformance[] = [];
  for (const e of list) {
    if (e.b2b?.length) {
      result.push(e);
      continue;
    }
    const read = readActName(e.name);
    if (read.parts.length <= 1) {
      result.push(e);
      continue;
    }
    const allKeys = read.parts.map(normalizeName).filter(Boolean);
    if (allKeys.length <= 1) {
      result.push(e);
      continue;
    }
    const slotId = e.slotId || crypto.randomUUID();
    for (const part of read.parts) {
      const key = normalizeName(part);
      result.push({
        ...e,
        artistKey: key,
        name: part,
        slotId,
        alias: e.alias,
        b2b: allKeys.filter((k) => k !== key),
      });
    }
  }
  return result;
}

export function startRows(rawPerformers: CandidatePerformer[], edition?: Edition | null): StartRow[] {
  const performers = unpackCandidates(rawPerformers);
  if (!edition) {
    return performers.map((p) => ({
      key: p.key,
      seenKey: p.key,
      slotId: p.slotId,
      alias: p.alias,
      b2b: p.b2b,
      name: p.name,
      accepted: !p.flagged,
      cancelled: false,
      billing: p.billing,
      days: p.days,
      stages: p.stages,
      candidate: p,
    }));
  }
  const editionPerformances = unpackPerformances(edition.performances);
  const used = new Set<EditionPerformance>();
  const rows: StartRow[] = performers.map((p) => {
    // 1. Same slotId if available on both
    let saved: EditionPerformance | undefined;
    if (p.slotId) {
      saved = editionPerformances.find((e) => !used.has(e) && e.slotId === p.slotId && e.artistKey === p.key);
    }
    // 2. Same artistKey and same b2b partners
    if (!saved) {
      saved = editionPerformances.find((e) => !used.has(e) && e.artistKey === p.key && b2bEqual(e.b2b, p.b2b));
    }
    // 3. Same artistKey fallback
    if (!saved) {
      saved = editionPerformances.find((e) => !used.has(e) && e.artistKey === p.key);
    }
    // 4. Same source fallback (only when artistKey was not found, e.g. renamed acts)
    if (!saved) {
      const sourceMatches = editionPerformances.filter((e) => !used.has(e) && sameSource(e, p));
      if (sourceMatches.length === 1) {
        saved = sourceMatches[0];
      } else if (sourceMatches.length > 1) {
        // If multiple performances share the source (like B2B partners), match the one with matching b2b structure if possible
        saved = sourceMatches.find((e) => b2bEqual(e.b2b, p.b2b)) ?? sourceMatches[0];
      }
    }

    if (!saved) {
      return {
        key: p.key,
        seenKey: p.key,
        slotId: p.slotId,
        alias: p.alias,
        b2b: p.b2b,
        name: p.name,
        accepted: false,
        cancelled: false,
        billing: p.billing,
        days: p.days,
        stages: p.stages,
        candidate: p,
      };
    }
    used.add(saved);
    const cancelled = saved.status === 'cancelled';
    return {
      key: p.key,
      seenKey: saved.artistKey,
      slotId: p.slotId ?? saved.slotId,
      alias: saved.alias ?? p.alias,
      b2b: p.b2b ?? saved.b2b,
      name: saved.name,
      accepted: !cancelled,
      cancelled,
      billing: saved.billing,
      days: saved.days,
      stages: saved.stages,
      candidate: p,
    };
  });
  // Acts you added by hand last time have no candidate.
  for (const e of editionPerformances) {
    if (used.has(e) || e.status === 'cancelled') continue;
    rows.push({
      seenKey: e.artistKey,
      slotId: e.slotId,
      alias: e.alias,
      b2b: e.b2b,
      name: e.name,
      accepted: true,
      cancelled: false,
      billing: e.billing,
      days: e.days,
      stages: e.stages,
    });
  }
  return rows;
}

export interface ReviewSlot<T> {
  id: string;
  name: string;
  alias?: string;
  isB2b: boolean;
  b2bPartners: string[];
  days: string[];
  stages: string[];
  confidence: number;
  flagged: boolean;
  status: 'billed' | 'performed';
  items: Array<{ item: T; index: number }>;
}

export interface SlotCandidateItem {
  key?: string;
  slotId?: string;
  alias?: string;
  b2b?: string[];
  name: string;
  days?: string[];
  stages?: string[];
  confidence?: number;
  flagged?: boolean;
  status?: 'billed' | 'performed' | 'cancelled';
}

export function groupReviewSlots<T extends SlotCandidateItem>(items: T[]): Array<ReviewSlot<T>> {
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    if (parent[i] === i) return i;
    parent[i] = find(parent[i]);
    return parent[i];
  };
  const union = (i: number, j: number) => {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) parent[rootI] = rootJ;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = items[i];
      const b = items[j];
      if (a.slotId && b.slotId) {
        if (a.slotId === b.slotId) union(i, j);
      } else if (a.key && b.key && a.key !== b.key) {
        const aHasB = a.b2b?.includes(b.key);
        const bHasA = b.b2b?.includes(a.key);
        if (aHasB && bHasA) {
          const daysOverlap =
            !a.days?.length || !b.days?.length || a.days.some((d) => b.days?.includes(d));
          if (daysOverlap) union(i, j);
        }
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(i);
    groups.set(root, list);
  }

  const slots: Array<ReviewSlot<T>> = [];
  for (const indices of groups.values()) {
    const members = indices.map((idx) => ({ item: items[idx], index: idx }));
    const isB2b = members.length > 1 || Boolean(members[0].item.b2b?.length);
    const alias = members.find((m) => m.item.alias)?.item.alias;
    const partnerNames = members.map((m) => m.item.name).join(' b2b ');
    const name = members.length > 1
      ? (alias ? `${alias} (${partnerNames})` : partnerNames)
      : members[0].item.name;
    const days = [...new Set(members.flatMap((m) => m.item.days ?? []))].sort();
    const stages = [...new Set(members.flatMap((m) => m.item.stages ?? []))].sort((a, b) => a.localeCompare(b));
    const confidence = members.reduce((acc, m) => Math.min(acc, m.item.confidence ?? 1), 1);
    const flagged = members.some((m) => m.item.flagged);
    const status = members.some((m) => m.item.status === 'performed') ? 'performed' : 'billed';
    const b2bPartners = [...new Set(members.flatMap((m) => m.item.b2b ?? []))];
    const id = members[0].item.slotId ?? members.map((m) => m.item.key ?? m.item.name).join('+');

    slots.push({
      id,
      name,
      alias,
      isB2b,
      b2bPartners,
      days,
      stages,
      confidence,
      flagged,
      status,
      items: members,
    });
  }

  return slots;
}

// Day and stage choices for the review filters, in order.
export function filterOptions(rows: Array<{ days: string[]; stages: string[] }>): { days: string[]; stages: string[] } {
  const days = new Set<string>();
  const stages = new Set<string>();
  for (const r of rows) {
    r.days.forEach((d) => days.add(d));
    r.stages.forEach((s) => stages.add(s));
  }
  return { days: [...days].sort(), stages: [...stages].sort((a, b) => a.localeCompare(b)) };
}
