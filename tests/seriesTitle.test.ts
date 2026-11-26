import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editionTitle, seriesDisplayName } from '../src/services/series.ts';

test('a series name is built from its brand and qualifier', () => {
  assert.equal(seriesDisplayName({ name: 'x', brand: 'Dreamstate', qualifier: 'SoCal', kind: 'festival' }), 'Dreamstate SoCal');
  assert.equal(seriesDisplayName({ name: 'x', brand: 'Andrew Bayer', qualifier: 'Duality Tour', kind: 'tour' }), 'Andrew Bayer: Duality Tour');
  assert.equal(seriesDisplayName({ name: 'Andrew Bayer Tour', brand: 'Andrew Bayer', kind: 'tour' }), 'Andrew Bayer');
  assert.equal(seriesDisplayName({ name: 'Head in the Clouds', brand: ' Head in the Clouds ', qualifier: ' ' }), 'Head in the Clouds');
});

test('a series without a brand keeps its qualifier or its stored name', () => {
  assert.equal(seriesDisplayName({ name: 'Tension Tour', kind: 'tour' }), 'Tension Tour');
  assert.equal(seriesDisplayName({ name: 'old', qualifier: 'Vertigo', kind: 'tour' }), 'Vertigo');
});

test('an edition title adds the year for a festival, never for a tour stop, then subtitle and weekend', () => {
  const asot = { name: 'ASOT 1000 Los Angeles 2025', year: 2025, seriesSlug: 'asot-la', seriesName: 'A State of Trance Los Angeles', seriesBrand: 'A State of Trance', seriesQualifier: 'Los Angeles', seriesKind: 'festival' as const };
  assert.equal(editionTitle(asot), 'A State of Trance Los Angeles 2025');
  assert.equal(editionTitle({ ...asot, subtitle: '1000' }), 'A State of Trance Los Angeles 2025 · 1000');
  assert.equal(editionTitle({ name: 'Coachella 2024 Weekend 1', year: 2024, seriesSlug: 'coachella', seriesName: 'Coachella', seriesBrand: 'Coachella' }, 1), 'Coachella 2024 · Weekend 1');
  assert.equal(
    editionTitle({ name: 'Andrew Bayer Duality Tour LA', year: 2024, seriesSlug: 'ab-duality', seriesName: 'x', seriesBrand: 'Andrew Bayer', seriesQualifier: 'Duality Tour', seriesKind: 'tour' }),
    'Andrew Bayer: Duality Tour',
  );
});

test('an edition with no series keeps its captured name', () => {
  assert.equal(editionTitle({ name: 'Some Show 2024', year: 2024 }), 'Some Show 2024');
  assert.equal(editionTitle({ name: 'Some Show', year: 2024, subtitle: 'Late set' }), 'Some Show · Late set');
});
