import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listCanonicalEditions, summarizeEdition } from '../src/server/entities/canonicalManage.ts';
import type { Edition } from '../src/server/lineup/types.ts';

const AT = '2026-11-03T00:00:00.000Z';
const ed = (over: Partial<Edition> = {}): Edition => ({
  id: 'e',
  key: 'x/2024',
  seriesSlug: 'x',
  year: 2024,
  name: 'X 2024',
  status: 'confirmed',
  performances: [],
  updatedAt: AT,
  ...over,
});

test('summary carries only shared edition facts', () => {
  const s = summarizeEdition(ed({ startDate: '2024-09-28', venue: 'Pier 80', city: 'San Francisco, CA' }));
  assert.deepEqual(Object.keys(s).sort(), [
    'city', 'endDate', 'hasSetTimes', 'id', 'key', 'name', 'performanceCount', 'seriesSlug', 'startDate', 'status', 'venue', 'year',
  ]);
  assert.equal(s.endDate, null);
  assert.equal(s.venue, 'Pier 80');
});

test('set times are reported only where a source gave days or stages', () => {
  const perf = { artistKey: 'a', name: 'A', days: [], stages: [], status: 'billed' as const, confidence: 1, sources: [] } as any;
  assert.equal(summarizeEdition(ed({ performances: [perf] })).hasSetTimes, false);
  assert.equal(summarizeEdition(ed({ performances: [{ ...perf, stages: ['Main'] }] })).hasSetTimes, true);
});

test('status filter shows only confirmed or only drafts when asked', () => {
  const list = [ed({ id: 'c', status: 'confirmed' }), ed({ id: 'd', status: 'draft', name: 'D 2024' })];
  assert.deepEqual(listCanonicalEditions(list, { status: 'confirmed' }).map((e) => e.id), ['c']);
  assert.deepEqual(listCanonicalEditions(list, { status: 'draft' }).map((e) => e.id), ['d']);
  assert.equal(listCanonicalEditions(list).length, 2);
});

test('query matches name, series or venue, ignoring case', () => {
  const list = [ed({ id: 'a', name: 'Portola 2024', venue: 'Pier 80' }), ed({ id: 'b', name: 'EDC 2024', seriesSlug: 'edc' })];
  assert.deepEqual(listCanonicalEditions(list, { query: 'pier' }).map((e) => e.id), ['a']);
  assert.deepEqual(listCanonicalEditions(list, { query: 'EDC' }).map((e) => e.id), ['b']);
});

test('newest year first, then name', () => {
  const list = [ed({ id: 'old', year: 2023, name: 'A' }), ed({ id: 'b', year: 2024, name: 'B' }), ed({ id: 'a', year: 2024, name: 'A' })];
  assert.deepEqual(listCanonicalEditions(list).map((e) => e.id), ['a', 'b', 'old']);
});
