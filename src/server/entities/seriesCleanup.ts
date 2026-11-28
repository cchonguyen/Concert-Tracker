import type { LineupStore } from '../lineup/store/types';
import type { Edition, EditionHeader, SeriesKind, SeriesRecord } from '../lineup/types';
import type { LoggedEvent } from '../events/types';
import { writeEdition } from '../canon/editions';
import { mergeCanonicalEditions } from '../lineup/canonicalIngest';
import { eventSeriesSlug } from '../events/routes';
import { removeUnusedSeries } from './manage';
import { mergeSeriesLogged, saveSeriesLogged, withBuiltSeriesName } from './canonicalManage';

// A one-time cleanup of shared series (docs/archive/series-cleanup.md): a list of steps run in order,
// each through the logged path for what it changes, so every change has an actor, a reason and an undo.
// Preview checks each step against the live records and changes nothing.
export type CleanupStep =
  // Set a shared series' fields, or create it when `create` is set. Fields left out stay; null clears one.
  | {
      op: 'series';
      slug: string;
      create?: boolean;
      name?: string;
      brand?: string | null;
      qualifier?: string | null;
      kind?: SeriesKind;
      aliases?: string[];
    }
  // Move an edition to a series and/or set its own subtitle ('' clears it).
  | { op: 'edition'; id: string; seriesSlug?: string; subtitle?: string }
  // Merge one shared series into another (mergeSeriesLogged).
  | { op: 'mergeSeries'; keep: string; drop: string }
  // Merge duplicate editions of the same night; the one with the most acts is kept (the Global Archive merge).
  | { op: 'mergeEditions'; ids: string[] }
  // Remove the requester's own series records that no event uses (removeUnusedSeries).
  | { op: 'removeOwnSeries'; names: string[] }
  // Point each of the requester's events at its shared series (eventSeriesSlug).
  | { op: 'linkEvents' };

export interface CleanupResult {
  step: number;
  op: CleanupStep['op'];
  target: string;
  outcome: 'ready' | 'done' | 'unchanged' | 'missing' | 'failed';
  note?: string;
}

export interface CleanupOptions {
  apply: boolean;
  actor: string;
  reason: string;
  now?: () => Date;
  // Run only steps[from, from + count): a Worker request has a small call budget, so the client sends batches.
  from?: number;
  count?: number;
}

// The store as linkEvents reads it: the shared series list read once, and each series found in it, so linking
// many events costs a few calls, not several per event.
function withSeriesCache(store: LineupStore): LineupStore {
  let list: Promise<Awaited<ReturnType<LineupStore['listSeries']>>> | null = null;
  const all = () => (list ??= store.listSeries({ limit: 500 }));
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'listSeries') return () => all();
      if (prop === 'getSeries') return async (slug: string) => (await all()).find((s) => s.slug === slug) ?? null;
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

const targetOf = (s: CleanupStep): string => {
  switch (s.op) {
    case 'series':
      return s.slug;
    case 'edition':
      return s.id;
    case 'mergeSeries':
      return `${s.drop} -> ${s.keep}`;
    case 'mergeEditions':
      return s.ids.join(', ');
    case 'removeOwnSeries':
      return `${s.names.length} names`;
    case 'linkEvents':
      return 'your events';
  }
};

function nextSeries(existing: SeriesRecord | null, s: Extract<CleanupStep, { op: 'series' }>): SeriesRecord {
  const next: SeriesRecord = existing ? { ...existing } : { slug: s.slug, name: s.name ?? s.slug };
  if (s.name !== undefined) next.name = s.name;
  if (s.kind !== undefined) next.kind = s.kind;
  for (const key of ['brand', 'qualifier'] as const) {
    const v = s[key];
    if (v === undefined) continue;
    if (v === null || !v.trim()) delete next[key];
    else next[key] = v.trim();
  }
  if (s.aliases !== undefined) {
    if (s.aliases.length) next.aliases = s.aliases;
    else delete next.aliases;
  }
  if (next.kind === 'tour') {
    delete next.city;
    delete next.region;
    delete next.country;
  }
  return withBuiltSeriesName(next);
}

const stable = (s: SeriesRecord | null) => JSON.stringify(s && Object.fromEntries(Object.entries(s).sort(([a], [b]) => a.localeCompare(b))));

// `made`: series an earlier step creates, so a preview counts a move into one as ready.
async function runStep(store: LineupStore, s: CleanupStep, opts: CleanupOptions, made: Set<string>): Promise<Omit<CleanupResult, 'step' | 'op' | 'target'>> {
  const at = (opts.now?.() ?? new Date()).toISOString();
  const by = { actor: opts.actor, reason: opts.reason };
  switch (s.op) {
    case 'series': {
      const existing = await store.getSeries(s.slug);
      if (!existing && !s.create) return { outcome: 'missing', note: 'No such series.' };
      const next = nextSeries(existing, s);
      if (existing && stable(withBuiltSeriesName(existing)) === stable(next)) return { outcome: 'unchanged' };
      made.add(s.slug);
      if (!opts.apply) return { outcome: 'ready', note: existing ? `"${existing.name}" -> "${next.name}"` : `new "${next.name}"` };
      if (existing) await saveSeriesLogged(store, existing, next, at);
      else await store.upsertSeries(next);
      return { outcome: 'done', note: next.name };
    }
    case 'edition': {
      const edition = await store.getEdition(s.id);
      if (!edition) return { outcome: 'missing', note: 'No such edition.' };
      if (s.seriesSlug && !made.has(s.seriesSlug) && !(await store.getSeries(s.seriesSlug))) return { outcome: 'missing', note: `No series ${s.seriesSlug}.` };
      const next: Edition = { ...edition, updatedAt: at };
      if (s.seriesSlug !== undefined) next.seriesSlug = s.seriesSlug;
      if (s.subtitle !== undefined) next.subtitle = s.subtitle;
      const same = next.seriesSlug === edition.seriesSlug && (next.subtitle ?? '') === (edition.subtitle ?? '');
      if (same) return { outcome: 'unchanged' };
      if (!opts.apply) return { outcome: 'ready', note: [s.seriesSlug && `to ${s.seriesSlug}`, s.subtitle !== undefined && `subtitle "${s.subtitle}"`].filter(Boolean).join(', ') };
      await writeEdition(store, { edition: next, ...by });
      return { outcome: 'done' };
    }
    case 'mergeSeries': {
      const [keep, drop] = [await store.getSeries(s.keep), await store.getSeries(s.drop)];
      if (!drop) return keep ? { outcome: 'unchanged', note: 'Already merged.' } : { outcome: 'missing' };
      if (!keep) return { outcome: 'missing', note: `No series ${s.keep}.` };
      if (!opts.apply) return { outcome: 'ready', note: `"${drop.name}" into "${keep.name}"` };
      await mergeSeriesLogged(store, s.keep, s.drop, by, at);
      return { outcome: 'done' };
    }
    case 'mergeEditions': {
      const found = (await Promise.all(s.ids.map((id) => store.getEdition(id)))).filter((e): e is Edition => Boolean(e));
      if (found.length < 2) return { outcome: found.length === 1 ? 'unchanged' : 'missing', note: found.length === 1 ? 'Already one edition.' : undefined };
      const [keep, ...drops] = [...found].sort((a, b) => b.performances.length - a.performances.length || a.id.localeCompare(b.id));
      if (!opts.apply) return { outcome: 'ready', note: `keep ${keep.id}` };
      await mergeCanonicalEditions(store, { keepId: keep.id, dropIds: drops.map((d) => d.id), ...by }, at);
      return { outcome: 'done', note: `kept ${keep.id}` };
    }
    case 'removeOwnSeries': {
      if (!opts.apply) return { outcome: 'ready' };
      const entry = await removeUnusedSeries(store, { names: s.names });
      return entry ? { outcome: 'done', note: `${entry.entities.before.length} removed` } : { outcome: 'unchanged' };
    }
    case 'linkEvents': {
      const cached = withSeriesCache(store);
      const events = await store.listEvents();
      const ids = [...new Set(events.flatMap((e) => (e.editionId ? [e.editionId] : [])))];
      const editions = new Map((ids.length ? await store.getEditionHeaders(ids) : []).map((h: EditionHeader) => [h.id, h]));
      const changed: LoggedEvent[] = [];
      for (const e of events) {
        const slug = await eventSeriesSlug(cached, e, (e.editionId && editions.get(e.editionId)) || null);
        if ((slug ?? undefined) === (e.seriesSlug ?? undefined)) continue;
        const { seriesSlug: _old, ...rest } = e;
        changed.push(slug ? { ...rest, seriesSlug: slug } : rest);
      }
      if (!changed.length) return { outcome: 'unchanged' };
      if (!opts.apply) return { outcome: 'ready', note: `${changed.length} events` };
      await store.putEvents(changed);
      return { outcome: 'done', note: `${changed.length} events` };
    }
  }
}

export async function runSeriesCleanup(store: LineupStore, steps: CleanupStep[], opts: CleanupOptions): Promise<CleanupResult[]> {
  const out: CleanupResult[] = [];
  const from = Math.max(0, Math.floor(opts.from ?? 0));
  const to = opts.count === undefined ? steps.length : Math.min(steps.length, from + Math.max(0, Math.floor(opts.count)));
  // Series an earlier batch creates: in a preview they do not exist yet, and moves into them are still ready.
  const made = new Set(steps.slice(0, from).flatMap((s) => (s.op === 'series' && s.create ? [s.slug] : [])));
  for (let i = from; i < to; i++) {
    const s = steps[i];
    const head = { step: i + 1, op: s.op, target: targetOf(s) };
    try {
      out.push({ ...head, ...(await runStep(store, s, opts, made)) });
    } catch (err) {
      out.push({ ...head, outcome: 'failed', note: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
