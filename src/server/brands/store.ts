// Applies and undoes brand changes through a small store (Global Editions slice 2).
// The plans come from plan.ts; this file loads the rows, writes them and records history.
// Owner-only callers use these; nothing here writes a personal field.
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BrandError,
  brandKey,
  normalizeBrandName,
  planMerge,
  planOrganization,
  planRename,
  planUndo,
  type BrandChangeRecord,
  type BrandRow,
  type SeriesLink,
} from './plan';

export interface BrandHistoryRow {
  id: string;
  change: BrandChangeRecord;
  undoneAt: string | null;
}

export interface BrandStore {
  listBrands(): Promise<BrandRow[]>;
  getBrand(id: string): Promise<BrandRow | null>;
  listSeriesLinks(): Promise<SeriesLink[]>;
  // The series slug of every edition that has one (one entry per edition).
  listEditionSeriesSlugs(): Promise<string[]>;
  saveBrand(row: BrandRow): Promise<void>;
  removeBrand(id: string): Promise<void>;
  moveSeries(slugs: readonly string[], brandId: string): Promise<void>;
  writeHistory(row: BrandHistoryRow): Promise<void>;
  getHistory(id: string): Promise<BrandHistoryRow | null>;
  markUndone(id: string, at: string): Promise<void>;
}

export interface ApplyDeps {
  store: BrandStore;
  newId: () => string;
  at?: () => string;
}

const nowIso = () => new Date().toISOString();

async function requireBrand(store: BrandStore, id: string): Promise<BrandRow> {
  const brand = await store.getBrand(id);
  if (!brand) throw new BrandError('That brand was not found.', 404);
  return brand;
}

// Writes the rows for a change and records its history. The row changes are written before
// the history row, so a failed history write leaves a change without undo (logged by the caller).
async function commit(deps: ApplyDeps, change: BrandChangeRecord): Promise<BrandHistoryRow> {
  const { store } = deps;
  const after: BrandRow = { id: change.brandId, ...change.after };
  if (change.operation === 'merge') {
    await store.moveSeries(change.seriesMoved.map((s) => s.slug), change.brandId);
    await store.saveBrand(after);
    if (change.mergedFromId) await store.removeBrand(change.mergedFromId);
  } else {
    await store.saveBrand(after);
  }
  const row: BrandHistoryRow = { id: deps.newId(), change, undoneAt: null };
  await store.writeHistory(row);
  return row;
}

export async function renameBrand(deps: ApplyDeps, brandId: string, name: unknown): Promise<BrandHistoryRow> {
  const brand = await requireBrand(deps.store, brandId);
  const others = await deps.store.listBrands();
  const change = planRename(brand, name, others, (deps.at ?? nowIso)());
  return commit(deps, change);
}

export async function setBrandOrganization(
  deps: ApplyDeps,
  brandId: string,
  organizationId: string | null,
): Promise<BrandHistoryRow> {
  const brand = await requireBrand(deps.store, brandId);
  return commit(deps, planOrganization(brand, organizationId, (deps.at ?? nowIso)()));
}

export async function mergeBrands(deps: ApplyDeps, sourceId: string, targetId: string): Promise<BrandHistoryRow> {
  const source = await requireBrand(deps.store, sourceId);
  const target = await requireBrand(deps.store, targetId);
  const series = await deps.store.listSeriesLinks();
  return commit(deps, planMerge(source, target, series, (deps.at ?? nowIso)()));
}

export async function undoBrandChange(deps: ApplyDeps, historyId: string): Promise<BrandHistoryRow> {
  const { store } = deps;
  const history = await store.getHistory(historyId);
  if (!history) throw new BrandError('That change was not found.', 404);
  const current = await store.getBrand(history.change.brandId);
  const series = await store.listSeriesLinks();
  const undo = planUndo(history.change, current, series, history.undoneAt !== null);

  if (undo.restoreBrand) {
    await store.saveBrand({ ...undo.restoreBrand });
    const back = new Map<string, string[]>();
    for (const r of undo.relinkSeries) back.set(r.brandId, [...(back.get(r.brandId) ?? []), r.slug]);
    for (const [brandId, slugs] of back) await store.moveSeries(slugs, brandId);
  }
  await store.saveBrand({ ...undo.restoreTarget });
  const at = (deps.at ?? nowIso)();
  await store.markUndone(historyId, at);
  return { ...history, undoneAt: at };
}

// In-memory store for tests and local use. Names are checked for uniqueness by the plans, not here.
export function createMemoryBrandStore(
  brands: BrandRow[] = [],
  series: SeriesLink[] = [],
  editionSeriesSlugs: string[] = [],
): BrandStore & { brands: Map<string, BrandRow>; series: Map<string, SeriesLink>; history: Map<string, BrandHistoryRow> } {
  const brandMap = new Map(brands.map((b) => [b.id, { ...b, aliases: [...b.aliases] }]));
  const seriesMap = new Map(series.map((s) => [s.slug, { ...s }]));
  const history = new Map<string, BrandHistoryRow>();
  return {
    brands: brandMap,
    series: seriesMap,
    history,
    async listBrands() {
      return [...brandMap.values()].map((b) => ({ ...b, aliases: [...b.aliases] }));
    },
    async getBrand(id) {
      const b = brandMap.get(id);
      return b ? { ...b, aliases: [...b.aliases] } : null;
    },
    async listSeriesLinks() {
      return [...seriesMap.values()].map((s) => ({ ...s }));
    },
    async listEditionSeriesSlugs() {
      return [...editionSeriesSlugs];
    },
    async saveBrand(row) {
      brandMap.set(row.id, { ...row, aliases: [...row.aliases] });
    },
    async removeBrand(id) {
      brandMap.delete(id);
      for (const s of seriesMap.values()) if (s.brandId === id) s.brandId = null;
    },
    async moveSeries(slugs, brandId) {
      for (const slug of slugs) {
        const s = seriesMap.get(slug);
        if (s) s.brandId = brandId;
      }
    },
    async writeHistory(row) {
      history.set(row.id, { ...row, change: { ...row.change } });
    },
    async getHistory(id) {
      const h = history.get(id);
      return h ? { ...h } : null;
    },
    async markUndone(id, at) {
      const h = history.get(id);
      if (h) h.undoneAt = at;
    },
  };
}

// Returns the id of the brands row with this name (case-insensitive, trimmed), creating it when none
// exists. Used when a series is saved with brand text, so the Brands tab lists that brand.
// Throws on a database error or a name the plans would reject; the caller saves nothing.
export async function findOrCreateBrandId(db: SupabaseClient, rawName: string): Promise<string> {
  const name = normalizeBrandName(rawName);
  const key = brandKey(name);
  const lookup = async () => {
    const res = await db.from('brands').select('id').eq('name_key', key).maybeSingle();
    if (res.error) throw new Error(`findOrCreateBrandId: ${res.error.message}`);
    return (res.data as { id: string } | null)?.id ?? null;
  };
  const existing = await lookup();
  if (existing) return existing;
  const id = crypto.randomUUID();
  const ins = await db.from('brands').insert({ id, name, name_key: key });
  if (!ins.error) return id;
  // Another save may have created the same brand between the lookup and the insert.
  const again = await lookup();
  if (again) return again;
  throw new Error(`findOrCreateBrandId: ${ins.error.message}`);
}

// Supabase store. Tables: brands, event_series (brand_id), brand_history (migrations 0047, 0048).
export function createSupabaseBrandStore(db: SupabaseClient): BrandStore {
  const fail = (what: string, error: { message: string } | null) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };
  const toRow = (r: any): BrandRow => ({
    id: r.id,
    name: r.name,
    aliases: r.aliases ?? [],
    organizationId: r.organization_id ?? null,
  });
  return {
    async listBrands() {
      const res = await db.from('brands').select('id, name, aliases, organization_id');
      fail('listBrands', res.error);
      return (res.data ?? []).map(toRow);
    },
    async getBrand(id) {
      const res = await db.from('brands').select('id, name, aliases, organization_id').eq('id', id).maybeSingle();
      fail('getBrand', res.error);
      return res.data ? toRow(res.data) : null;
    },
    async listSeriesLinks() {
      const res = await db.from('event_series').select('slug, brand_id');
      fail('listSeriesLinks', res.error);
      return (res.data ?? []).map((r: any) => ({ slug: r.slug, brandId: r.brand_id ?? null }));
    },
    async listEditionSeriesSlugs() {
      // Pages of 1000 so a large catalog is read whole.
      const slugs: string[] = [];
      for (let from = 0; ; from += 1000) {
        const res = await db.from('event_editions').select('series_slug').not('series_slug', 'is', null).range(from, from + 999);
        fail('listEditionSeriesSlugs', res.error);
        const rows = res.data ?? [];
        for (const r of rows as any[]) slugs.push(r.series_slug);
        if (rows.length < 1000) return slugs;
      }
    },
    async saveBrand(row) {
      const res = await db.from('brands').upsert({
        id: row.id,
        name: row.name,
        name_key: brandKey(row.name),
        aliases: row.aliases,
        organization_id: row.organizationId,
        updated_at: new Date().toISOString(),
      });
      fail('saveBrand', res.error);
    },
    async removeBrand(id) {
      const res = await db.from('brands').delete().eq('id', id);
      fail('removeBrand', res.error);
    },
    async moveSeries(slugs, brandId) {
      if (slugs.length === 0) return;
      const res = await db.from('event_series').update({ brand_id: brandId }).in('slug', [...slugs]);
      fail('moveSeries', res.error);
    },
    async writeHistory(row) {
      const res = await db.from('brand_history').insert({
        id: row.id,
        operation: row.change.operation,
        brand_id: row.change.brandId,
        merged_from_id: row.change.mergedFromId ?? null,
        manifest: row.change,
      });
      fail('writeHistory', res.error);
    },
    async getHistory(id) {
      const res = await db.from('brand_history').select('id, manifest, undone_at').eq('id', id).maybeSingle();
      fail('getHistory', res.error);
      if (!res.data) return null;
      return { id: res.data.id, change: res.data.manifest as BrandChangeRecord, undoneAt: res.data.undone_at ?? null };
    },
    async markUndone(id, at) {
      const res = await db.from('brand_history').update({ undone_at: at }).eq('id', id);
      fail('markUndone', res.error);
    },
  };
}
