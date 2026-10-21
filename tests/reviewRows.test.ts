import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterOptions, startRows } from '../src/services/reviewRows.ts';

const src = (name: string) => ({ sourceType: 'clashfinder' as const, sourceUrl: 'https://clashfinder.com/s/x/', quotedSpan: name, evidence: 'crowd' as const, extractor: 'cf' });
const cand = (name: string, extra: any = {}) => ({ key: name.toLowerCase(), name, days: [], stages: [], confidence: 0.9, flagged: false, status: 'billed', sources: [src(name)], ...extra }) as any;

test('reopening a confirmed lineup starts from what was saved', () => {
  const performers = [cand('Kaskade', { days: ['2025-05-16'], stages: ['kineticFIELD'] }), cand('Zed', { flagged: true }), cand('Junk'), cand('Gone')];
  const edition = {
    performances: [
      { artistKey: 'kaskade', name: 'Kaskade', days: ['2025-05-16'], stages: ['kineticFIELD'], status: 'performed', billing: 'headliner', confidence: 1, sources: [src('Kaskade')] },
      { artistKey: 'zedd', name: 'Zedd', days: [], stages: [], status: 'billed', confidence: 1, sources: [src('Zed')] }, // renamed
      { artistKey: 'gone', name: 'Gone', days: [], stages: [], status: 'cancelled', confidence: 1, sources: [src('Gone')] },
      { artistKey: 'by hand', name: 'By Hand', days: [], stages: [], status: 'billed', confidence: 1, sources: [] },
    ],
  } as any;
  const rows = startRows(performers, edition);
  assert.deepEqual(rows.map((r) => [r.name, r.accepted, r.cancelled]), [
    ['Kaskade', true, false],
    ['Zedd', true, false],
    ['Junk', false, false], // rejected last time
    ['Gone', false, true],
    ['By Hand', true, false],
  ]);
  assert.equal(rows[0].billing, 'headliner');
  assert.equal(rows[1].seenKey, 'zedd');
  // A first review keeps the candidate as found.
  assert.deepEqual(startRows(performers).map((r) => r.accepted), [true, false, true, true]);
});

test('day and stage filters list what the rows have', () => {
  assert.deepEqual(filterOptions([{ days: ['2025-05-17'], stages: ['b'] }, { days: ['2025-05-16', '2025-05-17'], stages: ['A'] }]), {
    days: ['2025-05-16', '2025-05-17'],
    stages: ['A', 'b'],
  });
});
