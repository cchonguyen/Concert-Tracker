import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shortDateRange,
  weekendLabel,
  suggestionWhenLabel,
  suggestionPlaceLabel,
} from '../src/services/format.ts';
import { buildPastPlaces, cityPickPatch, unanimousPlace } from '../src/services/placeAutofill.ts';
import { seedMultiWeekends, shiftIsoDate } from '../src/services/weekends.ts';
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

test('seedMultiWeekends seeds Weekend 1 (-7d) when Weekend 2 is detected in name', () => {
  const res = seedMultiWeekends({
    name: 'Coachella 2026 Weekend 2',
    startDate: '2026-04-17',
    endDate: '2026-04-19',
  });
  assert.deepEqual(res.weekends, [
    { weekend: 1, startDate: '2026-04-10', endDate: '2026-04-12' },
    { weekend: 2, startDate: '2026-04-17', endDate: '2026-04-19' },
  ]);
  assert.deepEqual(res.draftBadges, { 1: 'Draft (-7d) — confirm' });
});

test('seedMultiWeekends does not treat "Vampire Weekend" as Weekend 1 token', () => {
  const shortRes = seedMultiWeekends({
    name: 'Vampire Weekend',
    startDate: '2026-04-10',
    endDate: '2026-04-12',
  });
  assert.deepEqual(shortRes.weekends, [
    { weekend: 1, startDate: '2026-04-10', endDate: '2026-04-12' },
    { weekend: 2, startDate: '2026-04-17', endDate: '2026-04-19' },
  ]);
  assert.deepEqual(shortRes.draftBadges, { 2: 'Draft (+7d) — confirm' });

  const spanRes = seedMultiWeekends({
    name: 'Vampire Weekend Fest',
    startDate: '2026-04-10',
    endDate: '2026-04-19',
  });
  assert.deepEqual(spanRes.weekends, [
    { weekend: 1, startDate: '2026-04-10', endDate: '2026-04-12' },
    { weekend: 2, startDate: '2026-04-17', endDate: '2026-04-19' },
  ]);
  assert.deepEqual(spanRes.draftBadges, {
    1: 'Draft (split) — confirm',
    2: 'Draft (split) — confirm',
  });
});

test('seedMultiWeekends seeds Weekend 2 (+7d) from Weekend 1 across month/DST boundaries', () => {
  assert.equal(shiftIsoDate('2026-03-07', 7), '2026-03-14');
  assert.equal(shiftIsoDate('2026-04-02', -7), '2026-03-26');

  const res = seedMultiWeekends({
    name: 'Coachella 2026 W1',
    startDate: '2026-04-10',
    endDate: '2026-04-12',
  });
  assert.deepEqual(res.weekends, [
    { weekend: 1, startDate: '2026-04-10', endDate: '2026-04-12' },
    { weekend: 2, startDate: '2026-04-17', endDate: '2026-04-19' },
  ]);
  assert.deepEqual(res.draftBadges, { 2: 'Draft (+7d) — confirm' });
});

test('seedMultiWeekends splits 10-day span and lets confirmedWeekends override drafts', () => {
  const split = seedMultiWeekends({
    name: 'Coachella 2026',
    startDate: '2026-04-10',
    endDate: '2026-04-19',
  });
  assert.deepEqual(split.weekends, [
    { weekend: 1, startDate: '2026-04-10', endDate: '2026-04-12' },
    { weekend: 2, startDate: '2026-04-17', endDate: '2026-04-19' },
  ]);
  assert.deepEqual(split.draftBadges, {
    1: 'Draft (split) — confirm',
    2: 'Draft (split) — confirm',
  });

  const confirmed = seedMultiWeekends({
    name: 'Coachella 2026 Weekend 2',
    startDate: '2026-04-17',
    endDate: '2026-04-19',
    confirmedWeekends: [
      { weekend: 1, startDate: '2026-04-10', endDate: '2026-04-12' },
      { weekend: 2, startDate: '2026-04-17', endDate: '2026-04-19' },
    ],
  });
  assert.deepEqual(confirmed.weekends, [
    { weekend: 1, startDate: '2026-04-10', endDate: '2026-04-12' },
    { weekend: 2, startDate: '2026-04-17', endDate: '2026-04-19' },
  ]);
  assert.deepEqual(confirmed.draftBadges, {});

  const blank = seedMultiWeekends({ name: 'Coachella 2026' });
  assert.deepEqual(blank.weekends, [
    { weekend: 1, startDate: '' },
    { weekend: 2, startDate: '' },
  ]);
  assert.deepEqual(blank.draftBadges, {});
});

test('buildPastPlaces and cityPickPatch sort by frequency and preserve region/country', () => {
  const { places, cities } = buildPastPlaces([
    { city: 'Las Vegas', region: 'Nevada', country: 'United States' },
    { city: 'Indio', region: 'CA', country: 'US' },
    { city: 'Indio', region: 'California', country: 'US' },
    { city: 'Berlin', region: null, country: 'Germany' },
  ]);
  assert.deepEqual(cities, ['Indio, CA', 'Berlin', 'Las Vegas, NV']);
  assert.deepEqual(cityPickPatch('Indio, CA', places), {
    city: 'Indio',
    region: 'CA',
    country: 'US',
  });
  assert.deepEqual(cityPickPatch('Indio, CA', places, 'United States'), {
    city: 'Indio',
    region: 'CA',
  });
  assert.deepEqual(cityPickPatch('Austin, TX', places), {
    city: 'Austin, TX',
    region: null,
  });
});

test('unanimousPlace returns agreed place across items and null on conflicts or empty', () => {
  assert.deepEqual(
    unanimousPlace([
      { city: 'Indio', region: 'CA', country: '' },
      { city: ' indio ', region: 'ca', country: 'US' },
    ]),
    { city: 'Indio', region: 'CA', country: 'US', label: 'Indio, CA, US' },
  );

  assert.equal(
    unanimousPlace([
      { city: 'Indio', region: 'CA', country: 'US' },
      { city: 'Miami', region: 'FL', country: 'US' },
    ]),
    null,
  );

  assert.equal(unanimousPlace([{}, { city: '', region: null }]), null);
  assert.equal(unanimousPlace([]), null);
});
