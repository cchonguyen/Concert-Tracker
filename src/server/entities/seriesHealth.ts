import type { LineupStore } from '../lineup/store/types';
import type { EditionArtistRef, EditionHeader, SeriesRecord } from '../lineup/types';
import type { LoggedEvent } from '../events/types';
import { normalizeName } from '../lineup/normalizeName';
import { slugify } from '../lineup/text';
import { runSeriesCleanup, type CleanupResult, type CleanupStep } from './seriesCleanup';

// Series health (docs/specs/series-sync.md, Rule 2): a read-only check of the shared series, shown to the owner in
// Data health. Each issue carries one offer, worked out in code from stored data only, as cleanup steps. Nothing is
// applied without the owner's tap; a tap runs the steps through runSeriesCleanup, so every change is logged and undoable.
export type SeriesHealthKind = 'no-brand' | 'not-built' | 'no-series';

export interface SeriesHealthIssue {
  id: string;
  kind: SeriesHealthKind;
  title: string; // what is wrong, in plain words
  offer: string; // what the tap does
  steps: CleanupStep[];
}

export interface SeriesHealthInput {
  series: SeriesRecord[];
  editions: EditionHeader[];
  acts: EditionArtistRef[]; // stored lineup acts of the shared editions
  events: LoggedEvent[]; // the owner's events: their own ticks on linked events count as acts too
}

const MAX_EDITIONS_PER_FIX = 20;
const YEAR = /(^|\s)(19|20)\d{2}(\s|$)/g;
const same = (a: string | undefined, b: string | undefined) => !!a && !!b && normalizeName(a) === normalizeName(b);

// The edition's name without its year ("Coachella 2024" -> "Coachella").
export function baseName(name: string): string {
  return name.replace(YEAR, ' ').replace(/\s+/g, ' ').trim();
}

// The series name with a leading brand and separator removed ("Kylie Minogue: Tension Tour" -> "Tension Tour").
export function qualifierFrom(name: string, brand: string): string {
  const n = name.trim();
  if (normalizeName(n.slice(0, brand.length)) !== normalizeName(brand)) return n;
  return n.slice(brand.length).replace(/^[\s:\-–—|]+/, '').trim();
}

// Distinct acts (key -> shown name) across a series' editions: their stored lineups and the owner's own ticks.
function actsOf(editionIds: Set<string>, input: SeriesHealthInput): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of input.acts) if (editionIds.has(a.editionId) && a.artistKey) out.set(a.artistKey, a.name);
  for (const e of input.events) {
    if (!e.editionId || e.deletedAt || !editionIds.has(e.editionId)) continue;
    for (const s of e.seen ?? []) if (s.key && !out.has(s.key)) out.set(s.key, s.name);
  }
  return out;
}

const withAlias = (s: SeriesRecord, alias: string): string[] => {
  const aliases = s.aliases ?? [];
  return aliases.some((a) => same(a, alias)) ? aliases : [...aliases, alias];
};

export function findSeriesIssues(input: SeriesHealthInput): SeriesHealthIssue[] {
  const issues: SeriesHealthIssue[] = [];
  const bySeries = new Map<string, Set<string>>();
  for (const e of input.editions) if (e.seriesSlug) (bySeries.get(e.seriesSlug) ?? bySeries.set(e.seriesSlug, new Set()).get(e.seriesSlug)!).add(e.id);

  for (const s of input.series) {
    const brand = s.brand?.trim();
    const qualifier = s.qualifier?.trim();
    if (!brand) {
      const acts = [...actsOf(bySeries.get(s.slug) ?? new Set(), input).values()];
      if (acts.length === 1 && !same(acts[0], s.name)) {
        issues.push({
          id: `no-brand:${s.slug}`,
          kind: 'no-brand',
          title: `"${s.name}" has no brand`,
          offer: `Every edition lists only ${acts[0]}: make ${acts[0]} the brand and "${s.name}" the name after it`,
          steps: [{ op: 'series', slug: s.slug, brand: acts[0], qualifier: s.name, aliases: withAlias(s, s.name) }],
        });
      } else {
        issues.push({
          id: `no-brand:${s.slug}`,
          kind: 'no-brand',
          title: `"${s.name}" has no brand`,
          offer: `Use "${s.name}" as its brand`,
          steps: [{ op: 'series', slug: s.slug, brand: s.name }],
        });
      }
      continue;
    }
    if (!qualifier && !same(s.name, brand)) {
      const q = qualifierFrom(s.name, brand);
      if (!q || same(q, brand)) continue;
      issues.push({
        id: `not-built:${s.slug}`,
        kind: 'not-built',
        title: `"${s.name}" is not built from its brand ${brand}`,
        offer: `Keep ${brand} as the brand and set "${q}" as the name after it`,
        steps: [{ op: 'series', slug: s.slug, qualifier: q, aliases: withAlias(s, s.name) }],
      });
    }
  }

  // Editions with no series, grouped by their name without the year.
  const groups = new Map<string, EditionHeader[]>();
  for (const e of input.editions) {
    if (e.seriesSlug) continue;
    const base = baseName(e.name ?? '');
    if (!base) continue;
    const k = normalizeName(base);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
  }
  const slugs = new Set(input.series.map((s) => s.slug));
  for (const [k, eds] of groups) {
    const base = baseName(eds[0].name ?? '');
    const matches = input.series.filter((s) => same(s.name, base) || (s.aliases ?? []).some((a) => same(a, base)));
    const moved = eds.slice(0, MAX_EDITIONS_PER_FIX);
    const names = eds.length === 1 ? `"${eds[0].name}"` : `${eds.length} editions of "${base}"`;
    if (matches.length === 1) {
      issues.push({
        id: `no-series:${k}`,
        kind: 'no-series',
        title: `${names} ${eds.length === 1 ? 'has' : 'have'} no series`,
        offer: `Add to the series "${matches[0].name}"`,
        steps: moved.map((e) => ({ op: 'edition' as const, id: e.id, seriesSlug: matches[0].slug })),
      });
      continue;
    }
    // A new series only for a name that recurs: a one-off night is not a series.
    if (matches.length || eds.length < 2) continue;
    let slug = slugify(base) || 'series';
    for (let i = 2; slugs.has(slug); i++) slug = `${slugify(base)}-${i}`;
    slugs.add(slug);
    issues.push({
      id: `no-series:${k}`,
      kind: 'no-series',
      title: `${names} have no series`,
      offer: `Make a new series "${base}" and add them to it`,
      steps: [{ op: 'series', slug, create: true, name: base, brand: base }, ...moved.map((e) => ({ op: 'edition' as const, id: e.id, seriesSlug: slug }))],
    });
  }
  return issues;
}

// Reads what the check needs in four calls.
export async function seriesHealth(store: LineupStore): Promise<SeriesHealthIssue[]> {
  const [series, editions, acts, events] = await Promise.all([
    store.listSeries({ limit: 500 }),
    store.listEditionHeaders({ limit: 5000 }),
    store.listEditionArtistRefs(),
    store.listEvents(),
  ]);
  return findSeriesIssues({ series, editions, acts, events });
}

// The owner's tap: the issue is worked out again from live data and its steps run, logged and undoable.
export async function fixSeriesIssue(store: LineupStore, id: string, actor: string): Promise<CleanupResult[] | null> {
  const issue = (await seriesHealth(store)).find((i) => i.id === id);
  if (!issue) return null;
  return runSeriesCleanup(store, issue.steps, { apply: true, actor, reason: `Series health: ${issue.offer}` });
}
