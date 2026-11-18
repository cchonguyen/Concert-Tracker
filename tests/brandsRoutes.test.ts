import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrandError, type BrandRow } from '../src/server/brands/plan.ts';
import { brandActions, brandErrorStatus } from '../src/server/brands/routes.ts';
import { createMemoryBrandStore } from '../src/server/brands/store.ts';

const ORG = '11111111-2222-4333-8444-555555555555';
const brands: BrandRow[] = [
  { id: 'b-ins', name: 'Insomniac', aliases: [], organizationId: null },
  { id: 'b-edc', name: 'EDC', aliases: [], organizationId: null },
];

function actions() {
  let n = 0;
  const store = createMemoryBrandStore(brands, [{ slug: 'edc-las-vegas', brandId: 'b-edc' }]);
  return { store, a: brandActions(store, () => `h-${++n}`) };
}

test('list returns every brand', async () => {
  const { a } = actions();
  assert.deepEqual((await a.list()).map((b) => b.id).sort(), ['b-edc', 'b-ins']);
});

test('rename, organization and undo work through the actions', async () => {
  const { store, a } = actions();
  await a.rename('b-edc', 'Electric Daisy Carnival');
  assert.equal(store.brands.get('b-edc')?.name, 'Electric Daisy Carnival');
  await a.setOrganization('b-edc', ORG);
  assert.equal(store.brands.get('b-edc')?.organizationId, ORG);
  await a.undo('h-2');
  assert.equal(store.brands.get('b-edc')?.organizationId, null);
});

test('organization accepts null to detach and rejects a non-id string', async () => {
  const { a } = actions();
  await a.setOrganization('b-edc', ORG);
  await a.setOrganization('b-edc', null);
  await assert.rejects(() => a.setOrganization('b-edc', 'Goldenvoice'), BrandError);
});

test('merge moves series and the source is removed', async () => {
  const { store, a } = actions();
  await a.merge('b-edc', 'b-ins');
  assert.equal(store.brands.has('b-edc'), false);
  assert.equal(store.series.get('edc-las-vegas')?.brandId, 'b-ins');
});

test('missing ids are refused before any write', async () => {
  const { store, a } = actions();
  await assert.rejects(() => a.rename('', 'X'), BrandError);
  await assert.rejects(() => a.merge(undefined, 'b-ins'), BrandError);
  assert.equal(store.history.size, 0);
});

test('errors map to HTTP statuses; unknown errors are 500', () => {
  assert.deepEqual(brandErrorStatus(new BrandError('Taken.', 409)), { status: 409, error: 'Taken.' });
  assert.deepEqual(brandErrorStatus(new Error('boom')), { status: 500, error: 'boom' });
});

test('list returns each brand with its series and edition counts', async () => {
  const store = createMemoryBrandStore(
    [{ id: 'b-edc', name: 'EDC', aliases: [], organizationId: null }],
    [{ slug: 'edc-las-vegas', brandId: 'b-edc' }],
    ['edc-las-vegas', 'edc-las-vegas'],
  );
  const rows = await brandActions(store).list();
  assert.deepEqual(
    rows.map((r) => [r.id, r.seriesCount, r.editionCount]),
    [['b-edc', 1, 2]],
  );
});
