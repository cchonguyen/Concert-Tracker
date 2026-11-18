import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrandError, type BrandRow, type SeriesLink } from '../src/server/brands/plan.ts';
import {
  createMemoryBrandStore,
  findOrCreateBrandId,
  mergeBrands,
  renameBrand,
  setBrandOrganization,
  undoBrandChange,
} from '../src/server/brands/store.ts';

const brands: BrandRow[] = [
  { id: 'b-ins', name: 'Insomniac', aliases: [], organizationId: 'org-1' },
  { id: 'b-edc', name: 'EDC', aliases: ['Electric Daisy'], organizationId: null },
  { id: 'b-gv', name: 'Goldenvoice', aliases: [], organizationId: 'org-2' },
];
const series: SeriesLink[] = [
  { slug: 'edc-las-vegas', brandId: 'b-edc' },
  { slug: 'edc-orlando', brandId: 'b-edc' },
  { slug: 'coachella', brandId: 'b-gv' },
];

function deps(store: ReturnType<typeof createMemoryBrandStore>) {
  let n = 0;
  let t = 0;
  return {
    store,
    newId: () => `h-${++n}`,
    at: () => `2026-11-17T21:${String(10 + t++).padStart(2, '0')}:00.000Z`,
  };
}

test('rename writes the row and records history with the old name as an alias', async () => {
  const store = createMemoryBrandStore(brands, series);
  const row = await renameBrand(deps(store), 'b-edc', 'Electric Daisy Carnival');
  assert.equal(row.id, 'h-1');
  assert.equal(store.brands.get('b-edc')?.name, 'Electric Daisy Carnival');
  assert.deepEqual(store.brands.get('b-edc')?.aliases, ['Electric Daisy', 'EDC']);
  assert.equal(store.history.get('h-1')?.change.operation, 'rename');
});

test('rename to a name another brand uses is refused and nothing is written', async () => {
  const store = createMemoryBrandStore(brands, series);
  await assert.rejects(() => renameBrand(deps(store), 'b-edc', 'insomniac'), BrandError);
  assert.equal(store.brands.get('b-edc')?.name, 'EDC');
  assert.equal(store.history.size, 0);
});

test('organization change is recorded and can be undone', async () => {
  const store = createMemoryBrandStore(brands, series);
  const d = deps(store);
  await setBrandOrganization(d, 'b-edc', 'org-1');
  assert.equal(store.brands.get('b-edc')?.organizationId, 'org-1');
  await undoBrandChange(d, 'h-1');
  assert.equal(store.brands.get('b-edc')?.organizationId, null);
});

test('merge moves series, removes the source, and undo restores both', async () => {
  const store = createMemoryBrandStore(brands, series);
  const d = deps(store);
  await mergeBrands(d, 'b-edc', 'b-ins');
  assert.equal(store.brands.has('b-edc'), false);
  assert.equal(store.series.get('edc-las-vegas')?.brandId, 'b-ins');
  assert.equal(store.series.get('edc-orlando')?.brandId, 'b-ins');
  assert.equal(store.series.get('coachella')?.brandId, 'b-gv');
  assert.deepEqual(store.brands.get('b-ins')?.aliases, ['EDC', 'Electric Daisy']);

  await undoBrandChange(d, 'h-1');
  assert.equal(store.brands.get('b-edc')?.name, 'EDC');
  assert.equal(store.brands.get('b-ins')?.name, 'Insomniac');
  assert.deepEqual(store.brands.get('b-ins')?.aliases, []);
  assert.equal(store.series.get('edc-las-vegas')?.brandId, 'b-edc');
  assert.equal(store.series.get('edc-orlando')?.brandId, 'b-edc');
  assert.equal(store.history.get('h-1')?.undoneAt !== null, true);
});

test('undo refuses a second time', async () => {
  const store = createMemoryBrandStore(brands, series);
  const d = deps(store);
  await renameBrand(d, 'b-edc', 'Electric Daisy Carnival');
  await undoBrandChange(d, 'h-1');
  await assert.rejects(() => undoBrandChange(d, 'h-1'), (e: unknown) => e instanceof BrandError && e.status === 409);
});

test('undo of a merge leaves a series moved again after the merge alone', async () => {
  const store = createMemoryBrandStore(brands, series);
  const d = deps(store);
  await mergeBrands(d, 'b-edc', 'b-ins');
  await store.moveSeries(['edc-orlando'], 'b-gv');
  await undoBrandChange(d, 'h-1');
  assert.equal(store.series.get('edc-las-vegas')?.brandId, 'b-edc');
  assert.equal(store.series.get('edc-orlando')?.brandId, 'b-gv');
});

test('unknown brand ids are reported as not found', async () => {
  const store = createMemoryBrandStore(brands, series);
  await assert.rejects(() => renameBrand(deps(store), 'nope', 'X'), (e: unknown) => e instanceof BrandError && e.status === 404);
});

// A minimal fake of the Supabase builder calls the brand helper uses: select/eq/maybeSingle and insert.
function fakeBrandsDb(rows: { id: string; name_key: string }[], insertError: string | null = null) {
  const inserts: unknown[] = [];
  const db = {
    from(table: string) {
      assert.equal(table, 'brands');
      return {
        select() {
          return {
            eq(_col: string, key: string) {
              return { maybeSingle: async () => ({ data: rows.find((r) => r.name_key === key) ?? null, error: null }) };
            },
          };
        },
        insert: async (row: { id: string; name_key: string }) => {
          inserts.push(row);
          if (insertError) return { error: { message: insertError } };
          rows.push({ id: row.id, name_key: row.name_key });
          return { error: null };
        },
      };
    },
  };
  return { db: db as any, inserts };
}

test('a series brand name links to the existing brand row, ignoring case and spacing', async () => {
  const { db, inserts } = fakeBrandsDb([{ id: 'b-bl', name_key: 'brownies & lemonade' }]);
  assert.equal(await findOrCreateBrandId(db, '  Brownies   &  Lemonade '), 'b-bl');
  assert.equal(inserts.length, 0);
});

test('a series brand name with no brand row creates one with its key', async () => {
  const { db, inserts } = fakeBrandsDb([]);
  const id = await findOrCreateBrandId(db, 'Brownies & Lemonade');
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(inserts, [{ id, name: 'Brownies & Lemonade', name_key: 'brownies & lemonade' }]);
});

test('a brand row created by another save in the meantime is reused, not an error', async () => {
  // The first lookup misses; the insert fails because another save wrote the row; the second lookup finds it.
  let lookups = 0;
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: ++lookups > 1 ? { id: 'b-day' } : null, error: null }) }),
      }),
      insert: async () => ({ error: { message: 'duplicate key value' } }),
    }),
  };
  assert.equal(await findOrCreateBrandId(db as any, 'Day Trip'), 'b-day');
});

test('a failed brand insert with no matching row throws instead of linking nothing', async () => {
  const { db } = fakeBrandsDb([], 'permission denied');
  await assert.rejects(() => findOrCreateBrandId(db, 'Outloud Music Festival'), /permission denied/);
});
