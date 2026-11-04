import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Edition } from '../src/server/lineup/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { SupabaseLineupStore } from '../src/server/lineup/store/supabaseStore.ts';
import type { LineupStore } from '../src/server/lineup/store/types.ts';

const makeEdition = (id: string, year: number, name: string, status: Edition['status'], seriesSlug = 'series', venue?: string): Edition => ({
  id,
  key: `${seriesSlug}-${year}-${id}`,
  seriesSlug,
  year,
  name,
  venue,
  status,
  updatedAt: `${year}-01-01T00:00:00.000Z`,
  performances: [],
});

const makeRows = () => [
  ...Array.from({ length: 200 }, (_, i) => {
    const year = 2200 - i;
    const e = makeEdition(`recent-${i}`, year, 'Summer Festival', 'confirmed');
    return {
      id: e.id, key: e.key, series_slug: e.seriesSlug, year: e.year, name: e.name,
      start_date: null, end_date: null, venue: null, city: null, country: null,
      status: e.status, confirmed_at: null, updated_at: e.updatedAt, fact_source_note: null,
    };
  }),
  (() => {
    const e = makeEdition('old-match', 1990, 'Old Festival', 'confirmed', 'late-search-series', 'Old Arena');
    return {
      id: e.id, key: e.key, series_slug: e.seriesSlug, year: e.year, name: e.name,
      start_date: null, end_date: null, venue: e.venue, city: null, country: null,
      status: e.status, confirmed_at: null, updated_at: e.updatedAt, fact_source_note: null,
    };
  })(),
  (() => {
    const e = makeEdition('draft-match', 2300, 'Draft Festival', 'draft');
    return {
      id: e.id, key: e.key, series_slug: e.seriesSlug, year: e.year, name: e.name,
      start_date: null, end_date: null, venue: null, city: null, country: null,
      status: e.status, confirmed_at: null, updated_at: e.updatedAt, fact_source_note: null,
    };
  })(),
];

class FakeQuery {
  private filters: Array<{ field: string; values: unknown[] }> = [];
  private orders: Array<{ field: string; ascending: boolean }> = [];
  private bounds: [number, number] | null = null;
  private maxRows: number | null = null;
  private searchTerm: string | null = null;
  private exactCount = false;

  constructor(private readonly rows: Record<string, unknown>[]) {}
  select(_columns?: string, options?: { count?: string }) { this.exactCount = options?.count === 'exact'; return this; }
  order(field: string, options?: { ascending?: boolean }) {
    this.orders.push({ field, ascending: options?.ascending ?? true });
    return this;
  }
  range(from: number, to: number) { this.bounds = [from, to]; return this; }
  in(field: string, values: unknown[]) { this.filters.push({ field, values }); return this; }
  eq(field: string, value: unknown) { this.filters.push({ field, values: [value] }); return this; }
  or(filters: string) {
    const prefix = 'name.ilike."%';
    const separator = '%",series_slug.ilike."%';
    const start = filters.indexOf(prefix);
    const end = filters.indexOf(separator, start + prefix.length);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    this.searchTerm = filters.slice(start + prefix.length, end).replace(/\\([\\%_*\"])/g, '$1').toLowerCase();
    return this;
  }
  limit(limit: number) { this.maxRows = limit; return this; }

  private result() {
    let out = this.rows.filter((row) => this.filters.every(({ field, values }) => values.includes(row[field])));
    if (this.searchTerm !== null) {
      const query = this.searchTerm;
      out = out.filter((row) => [row.name, row.series_slug, row.venue].some((value) => String(value ?? '').toLowerCase().includes(query)));
    }
    const count = out.length;
    for (const { field, ascending } of [...this.orders].reverse()) {
      out = out.sort((a, b) => {
        const left = a[field] as string | number;
        const right = b[field] as string | number;
        const comparison = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
        return ascending ? comparison : -comparison;
      });
    }
    if (this.bounds) out = out.slice(this.bounds[0], this.bounds[1] + 1);
    if (this.maxRows !== null) out = out.slice(0, this.maxRows);
    return { data: out, error: null, count: this.exactCount ? count : null };
  }

  then(resolve: (value: { data: Record<string, unknown>[]; error: null; count: number | null }) => unknown, reject?: (reason: unknown) => unknown) {
    return Promise.resolve(this.result()).then(resolve, reject);
  }
}

const supabaseStore = (rows: Record<string, unknown>[]) => {
  const db = { from: (table: string) => new FakeQuery(table === 'event_editions' ? rows : []) };
  return new SupabaseLineupStore(db as any);
};

async function assertPageContract(store: LineupStore) {
  const confirmed = await store.listCanonicalEditionsPage({ query: 'festival', status: 'confirmed', limit: 200 });
  assert.equal(confirmed.total, 201);
  assert.equal(confirmed.editions.length, 200);
  assert.equal(confirmed.hasMore, true);
  assert.equal(confirmed.editions[0].year, 2200);
  assert.equal(confirmed.editions.at(-1)?.year, 2001);

  const oldByName = await store.listCanonicalEditionsPage({ query: 'old festival', status: 'all', limit: 200 });
  assert.equal(oldByName.total, 1);
  assert.equal(oldByName.editions[0].id, 'old-match');

  const oldBySeries = await store.listCanonicalEditionsPage({ query: 'late-search-series', status: 'all', limit: 200 });
  assert.equal(oldBySeries.editions[0].id, 'old-match');

  const oldByVenue = await store.listCanonicalEditionsPage({ query: 'old arena', status: 'all', limit: 200 });
  assert.equal(oldByVenue.editions[0].id, 'old-match');

  const drafts = await store.listCanonicalEditionsPage({ query: 'festival', status: 'draft', limit: 200 });
  assert.equal(drafts.total, 1);
  assert.equal(drafts.editions[0].id, 'draft-match');
  assert.equal(drafts.hasMore, false);
}

test('file store filters and counts the full edition catalog before the 200-row limit', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'canonical-editions-'));
  try {
    const store = new FileLineupStore(dir);
    for (const row of makeRows()) {
      await store.upsertEdition(makeEdition(row.id as string, row.year as number, row.name as string, row.status as Edition['status'], row.series_slug as string, row.venue as string | undefined));
    }
    await assertPageContract(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Supabase store filters and counts the full edition catalog before the 200-row limit', async () => {
  await assertPageContract(supabaseStore(makeRows()));
});
