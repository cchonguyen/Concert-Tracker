import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newEvent } from '../src/server/events/service.ts';
import { applyLinkedPatch, resolveEvent } from '../src/server/events/inherit.ts';
import { eventTitle, seriesOffers, sharedSeriesName } from '../src/services/series.ts';
import type { EditionHeader } from '../src/server/lineup/types.ts';
import type { LoggedEvent } from '../src/server/events/types.ts';

const NOW = new Date('2026-11-26T00:00:00.000Z');

const edition: EditionHeader = {
  id: 'ed-1',
  key: 'head-in-the-clouds/2024',
  seriesSlug: 'head-in-the-clouds-los-angeles',
  seriesName: 'Head in the Clouds Los Angeles',
  seriesBrand: 'Head in the Clouds',
  seriesKind: 'festival',
  year: 2024,
  name: 'Head In The Clouds 2024',
  startDate: '2024-08-03',
  city: 'Pasadena, CA',
  status: 'verified',
  updatedAt: NOW.toISOString(),
};
const built = { ...edition, seriesName: 'Dreamstate SoCal', seriesBrand: 'Dreamstate', seriesQualifier: 'SoCal' };

const linked = (extra: Partial<LoggedEvent> = {}): LoggedEvent => ({
  ...newEvent('Head In The Clouds 2024, Pasadena', NOW),
  editionId: 'ed-1',
  series: 'HITC',
  ...extra,
});

test('the shared series name is built from brand and qualifier, else the stored name', () => {
  assert.equal(sharedSeriesName(built), 'Dreamstate SoCal');
  assert.equal(sharedSeriesName({ ...built, seriesQualifier: undefined }), 'Dreamstate');
  assert.equal(sharedSeriesName({ ...edition, seriesBrand: undefined }), 'Head in the Clouds Los Angeles');
  assert.equal(sharedSeriesName({ ...edition, seriesSlug: undefined }), undefined);
  assert.equal(sharedSeriesName(null), undefined);
});

test('a linked event shows the shared series name unless you set your own', () => {
  assert.equal(resolveEvent(linked(), built).series, 'Dreamstate SoCal');
  assert.equal(resolveEvent(linked({ overrides: { series: 'My Dreamstate' } }), built).series, 'My Dreamstate');
});

test('typing the shared name back clears your own wording', () => {
  const mine = linked({ overrides: { series: 'My Dreamstate' } });
  const { event } = applyLinkedPatch(mine, built, { series: 'Dreamstate SoCal' }, NOW);
  assert.equal('series' in (event.overrides ?? {}), false);
});

test('a shared series name gets no town added; your own wording still does', () => {
  const brandOnly = { ...edition, seriesName: 'Head in the Clouds', seriesBrand: 'Head in the Clouds' };
  const shown = resolveEvent(linked(), brandOnly);
  assert.equal(eventTitle(shown), 'Head in the Clouds 2024');
  const own = resolveEvent(linked({ overrides: { series: 'Head in the Clouds' } }), brandOnly);
  assert.equal(eventTitle(own), 'Head in the Clouds Pasadena 2024');
});

test('the Series field offers the shared series first', () => {
  const e = { ...linked(), series: undefined };
  assert.equal(seriesOffers(e, [], 'Dreamstate SoCal')[0], 'Dreamstate SoCal');
});
