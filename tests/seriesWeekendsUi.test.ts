import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shortDateRange,
  weekendLabel,
  suggestionWhenLabel,
  suggestionPlaceLabel,
} from '../src/services/format.ts';
import { needsOf } from '../src/services/table.ts';
import {
  hasDistinctEditionDates,
  editionDateSummary,
  differingMergeFields,
} from '../src/components/MergeEditionModal.tsx';
import type { Edition } from '../src/server/lineup/types.ts';
import type { EditionSuggestion } from '../src/services/lineupApi.ts';
import type { LoggedEvent } from '../src/server/events/types.ts';

test('shortDateRange and weekendLabel format single-day and multi-day weekends cleanly', () => {
  assert.equal(shortDateRange('2026-04-10', '2026-04-12'), 'Apr 10–12');
  assert.equal(shortDateRange('2026-04-29', '2026-05-02'), 'Apr 29–May 2');
  assert.equal(shortDateRange('2026-04-10'), 'Apr 10');
  assert.equal(weekendLabel({ weekend: 1, startDate: '2026-04-10', endDate: '2026-04-12' }), 'Weekend 1 · Apr 10–12');
  assert.equal(weekendLabel({ weekend: 2, startDate: '2026-04-17', endDate: '2026-04-19' }, 'WK'), 'WK2 · Apr 17–19');
});

test('suggestionWhenLabel shows matched weekend or multi-weekend summary', () => {
  const multi: EditionSuggestion = {
    id: 'ed-1',
    name: 'Coachella 2026',
    year: 2026,
    startDate: '2026-04-10',
    endDate: '2026-04-19',
    city: 'Indio',
    region: 'CA',
    country: 'US',
    actCount: 150,
    weekends: [
      { weekend: 1, startDate: '2026-04-10', endDate: '2026-04-12' },
      { weekend: 2, startDate: '2026-04-17', endDate: '2026-04-19' },
    ],
  };

  assert.equal(suggestionWhenLabel(multi), '2 weekends · 2026');
  assert.equal(suggestionWhenLabel(multi, 2), 'Weekend 2 · Apr 17–19');
  assert.equal(suggestionPlaceLabel(multi), 'Indio, CA, US');
});

test('needsOf returns pick when canonical candidates are waiting', () => {
  const event = {
    year: 2026,
    details: { status: 'candidates', candidates: [{ id: 'c1', editionId: 'ed-1', name: 'Coachella', sources: [] }], notes: [] },
    seen: [],
  } as unknown as LoggedEvent;
  assert.equal(needsOf(event), 'pick');
});

test('MergeEditionModal helpers detect distinct dates and differing facts', () => {
  const edA = {
    id: 'ed-a',
    name: 'Coachella 2026 W1',
    year: 2026,
    startDate: '2026-04-10',
    endDate: '2026-04-12',
    venue: 'Empire Polo Club',
    city: 'Indio',
    region: 'CA',
    country: 'US',
    seriesSlug: 'coachella',
    status: 'verified',
    performances: [],
    sources: [],
    createdAt: '',
    updatedAt: '',
  } as unknown as Edition;
  const edB = {
    ...edA,
    id: 'ed-b',
    name: 'Coachella 2026 W2',
    startDate: '2026-04-17',
    endDate: '2026-04-19',
  } as unknown as Edition;

  assert.equal(hasDistinctEditionDates([edA, edB]), true);
  assert.equal(hasDistinctEditionDates([edA, { ...edB, startDate: '2026-04-10', endDate: '2026-04-12' }]), false);
  assert.equal(editionDateSummary(edA), '2026-04-10 to 2026-04-12');

  const diff = differingMergeFields([edA, edB], false).map((f) => f.field);
  assert.deepEqual(diff, ['name', 'startDate', 'endDate']);
  const diffCombined = differingMergeFields([edA, edB], true).map((f) => f.field);
  assert.deepEqual(diffCombined, ['name']);
});
