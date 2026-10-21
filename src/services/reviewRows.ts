// Which acts the review screen starts from. A first review starts from the
// lookup's candidate; reopening a confirmed lineup starts from what you saved,
// so earlier keeps, rejections, renames and hand-added acts carry over.
import type { CandidatePerformer, Edition, EditionPerformance } from '../server/lineup/types';

export interface StartRow {
  key?: string;
  seenKey: string; // the key a seen act would have
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

export function startRows(performers: CandidatePerformer[], edition?: Edition | null): StartRow[] {
  if (!edition) {
    return performers.map((p) => ({ key: p.key, seenKey: p.key, name: p.name, accepted: !p.flagged, cancelled: false, billing: p.billing, days: p.days, stages: p.stages, candidate: p }));
  }
  const used = new Set<EditionPerformance>();
  const rows: StartRow[] = performers.map((p) => {
    const saved = edition.performances.find((e) => !used.has(e) && e.artistKey === p.key) ?? edition.performances.find((e) => !used.has(e) && sameSource(e, p));
    if (!saved) return { key: p.key, seenKey: p.key, name: p.name, accepted: false, cancelled: false, billing: p.billing, days: p.days, stages: p.stages, candidate: p };
    used.add(saved);
    const cancelled = saved.status === 'cancelled';
    return { key: p.key, seenKey: saved.artistKey, name: saved.name, accepted: !cancelled, cancelled, billing: saved.billing, days: saved.days, stages: saved.stages, candidate: p };
  });
  // Acts you added by hand last time have no candidate.
  for (const e of edition.performances) {
    if (used.has(e) || e.status === 'cancelled') continue;
    rows.push({ seenKey: e.artistKey, name: e.name, accepted: true, cancelled: false, billing: e.billing, days: e.days, stages: e.stages });
  }
  return rows;
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
