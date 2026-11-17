import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BrandError,
  cleanAliases,
  normalizeBrandName,
  planMerge,
  planOrganization,
  planRename,
  planUndo,
  type BrandRow,
} from '../src/server/brands/plan.ts';

const AT = '2026-11-17T21:00:00.000Z';
const insomniac: BrandRow = { id: 'b-ins', name: 'Insomniac', aliases: [], organizationId: 'org-1' };
const edc: BrandRow = { id: 'b-edc', name: 'EDC', aliases: ['Electric Daisy'], organizationId: null };
const goldenvoice: BrandRow = { id: 'b-gv', name: 'Goldenvoice', aliases: [], organizationId: 'org-2' };

test('normalizeBrandName trims, collapses spaces and rejects blanks', () => {
  assert.equal(normalizeBrandName('  Electric   Daisy  '), 'Electric Daisy');
  assert.throws(() => normalizeBrandName('   '), BrandError);
  assert.throws(() => normalizeBrandName(42), BrandError);
  assert.throws(() => normalizeBrandName('x'.repeat(81)), BrandError);
});

test('cleanAliases drops duplicates, blanks and the brand name itself', () => {
  assert.deepEqual(cleanAliases('EDC', ['edc', ' Electric Daisy ', '', 'Electric Daisy', 'EDC Festival']), [
    'Electric Daisy',
    'EDC Festival',
  ]);
});

test('rename keeps the old name searchable as an alias', () => {
  const change = planRename(edc, 'Electric Daisy Carnival', [insomniac, goldenvoice], AT);
  assert.equal(change.after.name, 'Electric Daisy Carnival');
  assert.deepEqual(change.after.aliases, ['Electric Daisy', 'EDC']);
  assert.equal(change.operation, 'rename');
  assert.deepEqual(change.seriesMoved, []);
});

test('rename to a name another brand uses is refused and points to merge', () => {
  assert.throws(
    () => planRename(edc, 'insomniac', [insomniac, edc], AT),
    (err: unknown) => err instanceof BrandError && err.status === 409 && /Merge/.test(err.message),
  );
});

test('rename to the same name only changes case and keeps the record', () => {
  const change = planRename(insomniac, 'INSOMNIAC', [insomniac], AT);
  assert.equal(change.after.name, 'INSOMNIAC');
  assert.deepEqual(change.after.aliases, []);
});

test('organization change attaches and detaches', () => {
  assert.equal(planOrganization(edc, 'org-9', AT).after.organizationId, 'org-9');
  assert.equal(planOrganization(insomniac, null, AT).after.organizationId, null);
});

test('merge moves the source series, unions aliases and keeps the target organization', () => {
  const series = [
    { slug: 'edc-las-vegas', brandId: 'b-edc' },
    { slug: 'edc-orlando', brandId: 'b-edc' },
    { slug: 'coachella', brandId: 'b-gv' },
  ];
  const change = planMerge(edc, insomniac, series, AT);
  assert.equal(change.brandId, 'b-ins');
  assert.equal(change.mergedFromId, 'b-edc');
  assert.deepEqual(change.after.aliases, ['EDC', 'Electric Daisy']);
  assert.equal(change.after.organizationId, 'org-1');
  assert.deepEqual(change.seriesMoved.map((s) => s.slug), ['edc-las-vegas', 'edc-orlando']);
  assert.equal(change.removedBrand?.id, 'b-edc');
});

test('merge takes the source organization only when the target has none', () => {
  const change = planMerge(insomniac, edc, [], AT);
  assert.equal(change.after.organizationId, 'org-1');
});

test('merge of a brand into itself is refused', () => {
  assert.throws(() => planMerge(edc, edc, [], AT), BrandError);
});

test('undo of a merge restores the source and relinks only series still on the target', () => {
  const change = planMerge(edc, insomniac, [
    { slug: 'edc-las-vegas', brandId: 'b-edc' },
    { slug: 'edc-orlando', brandId: 'b-edc' },
  ], AT);
  // After the merge, the target row matches the change's result.
  const current: BrandRow = { ...insomniac, name: change.after.name, aliases: change.after.aliases, organizationId: change.after.organizationId };
  const undo = planUndo(change, current, [
    { slug: 'edc-las-vegas', brandId: 'b-ins' },
    { slug: 'edc-orlando', brandId: 'b-gv' }, // moved again since the merge: left alone
  ], false);
  assert.equal(undo.restoreTarget.name, 'Insomniac');
  assert.equal(undo.restoreBrand?.id, 'b-edc');
  assert.deepEqual(undo.relinkSeries, [{ slug: 'edc-las-vegas', brandId: 'b-edc' }]);
  assert.deepEqual(undo.skippedSeries, ['edc-orlando']);
});

test('undo is refused when the target changed after the change', () => {
  const change = planRename(edc, 'Electric Daisy Carnival', [], AT);
  const edited: BrandRow = { ...edc, name: 'Something else' };
  assert.throws(() => planUndo(change, edited, [], false), (err: unknown) => err instanceof BrandError && err.status === 409);
});

test('undo is refused once already undone, and when the brand is gone', () => {
  const change = planRename(edc, 'Electric Daisy Carnival', [], AT);
  const current: BrandRow = { ...edc, name: change.after.name, aliases: change.after.aliases };
  assert.throws(() => planUndo(change, current, [], true), BrandError);
  assert.throws(() => planUndo(change, null, [], false), BrandError);
});

test('undo of a rename restores the name and aliases', () => {
  const change = planRename(edc, 'Electric Daisy Carnival', [], AT);
  const current: BrandRow = { ...edc, name: change.after.name, aliases: change.after.aliases };
  const undo = planUndo(change, current, [], false);
  assert.equal(undo.restoreTarget.name, 'EDC');
  assert.deepEqual(undo.restoreTarget.aliases, ['Electric Daisy']);
  assert.equal(undo.restoreBrand, null);
});
