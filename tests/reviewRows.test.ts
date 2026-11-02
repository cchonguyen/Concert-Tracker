import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterOptions, groupReviewSlots, startRows } from '../src/services/reviewRows.ts';

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

test('startRows keeps multiple candidate performances for the same artist (solo and B2B)', () => {
  const soloCand = cand('John Summit', { slotId: 'slot-solo', days: ['2024-05-17'], stages: ['Circuit Grounds'] });
  const b2bJohn = cand('John Summit', { slotId: 'slot-b2b', b2b: ['dom dolla'], days: ['2024-05-19'], stages: ['Kinetic Field'] });
  const b2bDom = cand('Dom Dolla', { slotId: 'slot-b2b', b2b: ['john summit'], days: ['2024-05-19'], stages: ['Kinetic Field'] });
  const performers = [soloCand, b2bJohn, b2bDom];

  // Initial review without saved edition:
  const initialRows = startRows(performers);
  assert.equal(initialRows.length, 3);
  assert.equal(initialRows[0].name, 'John Summit');
  assert.equal(initialRows[0].slotId, 'slot-solo');
  assert.equal(initialRows[0].b2b, undefined);
  assert.equal(initialRows[1].name, 'John Summit');
  assert.equal(initialRows[1].slotId, 'slot-b2b');
  assert.deepEqual(initialRows[1].b2b, ['dom dolla']);
  assert.equal(initialRows[2].name, 'Dom Dolla');
  assert.equal(initialRows[2].slotId, 'slot-b2b');
  assert.deepEqual(initialRows[2].b2b, ['john summit']);

  // Reopening saved edition:
  const edition = {
    performances: [
      { artistKey: 'john summit', slotId: 'slot-solo', name: 'John Summit (Solo)', days: ['2024-05-17'], stages: ['Circuit Grounds'], status: 'performed', confidence: 1, sources: [src('John Summit')] },
      { artistKey: 'john summit', slotId: 'slot-b2b', b2b: ['dom dolla'], name: 'John Summit', days: ['2024-05-19'], stages: ['Kinetic Field'], status: 'performed', confidence: 1, sources: [src('John Summit')] },
      { artistKey: 'dom dolla', slotId: 'slot-b2b', b2b: ['john summit'], name: 'Dom Dolla', days: ['2024-05-19'], stages: ['Kinetic Field'], status: 'performed', confidence: 1, sources: [src('Dom Dolla')] },
    ],
  } as any;
  const savedRows = startRows(performers, edition);
  assert.equal(savedRows.length, 3);
  assert.equal(savedRows[0].name, 'John Summit (Solo)');
  assert.equal(savedRows[0].slotId, 'slot-solo');
  assert.equal(savedRows[1].name, 'John Summit');
  assert.equal(savedRows[1].slotId, 'slot-b2b');
  assert.equal(savedRows[2].name, 'Dom Dolla');
  assert.equal(savedRows[2].slotId, 'slot-b2b');
});

test('B2B slot grouping links the performers', () => {
  // 1. Grouping by reciprocal b2b
  const aTrak = { key: 'a trak', name: 'A-Trak', b2b: ['craze'], days: ['2024-05-18'], stages: ['Basspod'], confidence: 0.95 };
  const craze = { key: 'craze', name: 'Craze', b2b: ['a trak'], days: ['2024-05-18'], stages: ['Basspod'], confidence: 0.9 };
  const b2bSlots = groupReviewSlots([aTrak, craze]);
  assert.equal(b2bSlots.length, 1);
  assert.equal(b2bSlots[0].name, 'A-Trak b2b Craze');
  assert.equal(b2bSlots[0].isB2b, true);
  assert.deepEqual(b2bSlots[0].days, ['2024-05-18']);
  assert.deepEqual(b2bSlots[0].stages, ['Basspod']);
  assert.equal(b2bSlots[0].items.length, 2);

  // 2. Solo set alongside B2B set for the same artist
  const soloSummit = { key: 'john summit', name: 'John Summit', days: ['2024-05-17'], stages: ['Circuit Grounds'], confidence: 0.9 };
  const b2bSummit = { key: 'john summit', name: 'John Summit', b2b: ['dom dolla'], days: ['2024-05-19'], stages: ['Kinetic Field'], confidence: 0.95 };
  const b2bDolla = { key: 'dom dolla', name: 'Dom Dolla', b2b: ['john summit'], days: ['2024-05-19'], stages: ['Kinetic Field'], confidence: 0.95 };

  const mixedSlots = groupReviewSlots([soloSummit, b2bSummit, b2bDolla]);
  assert.equal(mixedSlots.length, 2);
  assert.equal(mixedSlots[0].name, 'John Summit');
  assert.equal(mixedSlots[0].isB2b, false);
  assert.deepEqual(mixedSlots[0].days, ['2024-05-17']);
  assert.deepEqual(mixedSlots[0].stages, ['Circuit Grounds']);

  assert.equal(mixedSlots[1].name, 'John Summit b2b Dom Dolla');
  assert.equal(mixedSlots[1].isB2b, true);
  assert.deepEqual(mixedSlots[1].days, ['2024-05-19']);
  assert.deepEqual(mixedSlots[1].stages, ['Kinetic Field']);
  assert.equal(mixedSlots[1].items.length, 2);
});

test('startRows automatically unpacks legacy unparsed B2B performances from edition', () => {
  const edition = {
    performances: [
      {
        artistKey: 'armin van buuren x adam beyer',
        name: 'Armin van Buuren x Adam Beyer',
        days: ['2026-04-10', '2026-04-11'],
        stages: ['Quasar', 'Yuma'],
        status: 'performed',
        confidence: 0.99,
        sources: [src('Armin van Buuren x Adam Beyer')],
      },
    ],
  } as any;

  const rows = startRows([], edition);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Armin van Buuren');
  assert.equal(rows[0].seenKey, 'armin van buuren');
  assert.ok(rows[0].slotId);
  assert.deepEqual(rows[0].b2b, ['adam beyer']);
  assert.deepEqual(rows[0].days, ['2026-04-10', '2026-04-11']);
  assert.deepEqual(rows[0].stages, ['Quasar', 'Yuma']);

  assert.equal(rows[1].name, 'Adam Beyer');
  assert.equal(rows[1].seenKey, 'adam beyer');
  assert.equal(rows[1].slotId, rows[0].slotId);
  assert.deepEqual(rows[1].b2b, ['armin van buuren']);
  assert.deepEqual(rows[1].days, ['2026-04-10', '2026-04-11']);

  const slots = groupReviewSlots(rows);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].name, 'Armin van Buuren b2b Adam Beyer');
  assert.equal(slots[0].isB2b, true);
  assert.equal(slots[0].items.length, 2);
});

test('groupReviewSlots formats slot name with alias when present, and supports 3-artist B3B slots', () => {
  const p1 = { key: 'john summit', name: 'John Summit', slotId: 'slot-subjohnics', b2b: ['subtronics'], alias: 'Subjohnics' };
  const p2 = { key: 'subtronics', name: 'Subtronics', slotId: 'slot-subjohnics', b2b: ['john summit'], alias: 'Subjohnics' };
  const slots = groupReviewSlots([p1, p2]);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].alias, 'Subjohnics');
  assert.equal(slots[0].name, 'Subjohnics (John Summit b2b Subtronics)');
  assert.equal(slots[0].isB2b, true);

  // 3-artist B3B with alias
  const b3b1 = { key: 'skrillex', name: 'Skrillex', slotId: 'slot-pang', b2b: ['four tet', 'fred again..'], alias: 'OMG TBA' };
  const b3b2 = { key: 'four tet', name: 'Four Tet', slotId: 'slot-pang', b2b: ['skrillex', 'fred again..'], alias: 'OMG TBA' };
  const b3b3 = { key: 'fred again..', name: 'Fred again..', slotId: 'slot-pang', b2b: ['skrillex', 'four tet'], alias: 'OMG TBA' };
  const b3bSlots = groupReviewSlots([b3b1, b3b2, b3b3]);
  assert.equal(b3bSlots.length, 1);
  assert.equal(b3bSlots[0].alias, 'OMG TBA');
  assert.equal(b3bSlots[0].name, 'OMG TBA (Skrillex b2b Four Tet b2b Fred again..)');
  assert.equal(b3bSlots[0].items.length, 3);
});

test('reopening B2B performances does not swap partners via sameSource', () => {
  const b2bSource = { sourceType: 'clashfinder' as const, sourceUrl: 'https://clashfinder.com/s/x/', quotedSpan: 'Henri Bergmann b2b Layla Benitez', evidence: 'crowd' as const, extractor: 'cf' };

  // Two candidate performers sharing the exact same B2B source
  const candHenri = {
    key: 'henri bergmann',
    name: 'Henri Bergmann',
    slotId: 'new-slot-id-1',
    b2b: ['layla benitez'],
    days: [],
    stages: [],
    confidence: 1,
    flagged: false,
    status: 'billed',
    sources: [b2bSource],
  } as any;
  const candLayla = {
    key: 'layla benitez',
    name: 'Layla Benitez',
    slotId: 'new-slot-id-1',
    b2b: ['henri bergmann'],
    days: [],
    stages: [],
    confidence: 1,
    flagged: false,
    status: 'billed',
    sources: [b2bSource],
  } as any;

  // Saved edition where performances appear in reverse order or have different slotIds
  const edition = {
    performances: [
      { artistKey: 'layla benitez', name: 'Layla Benitez', slotId: 'old-slot-id', b2b: ['henri bergmann'], days: [], stages: [], status: 'billed', confidence: 1, sources: [b2bSource] },
      { artistKey: 'henri bergmann', name: 'Henri Bergmann', slotId: 'old-slot-id', b2b: ['layla benitez'], days: [], stages: [], status: 'billed', confidence: 1, sources: [b2bSource] },
    ],
  } as any;

  const rows = startRows([candHenri, candLayla], edition);
  assert.equal(rows.length, 2);
  // candHenri should match Henri Bergmann, NOT Layla Benitez
  assert.equal(rows[0].name, 'Henri Bergmann');
  assert.equal(rows[0].candidate?.name, 'Henri Bergmann');
  assert.equal(rows[0].seenKey, 'henri bergmann');

  // candLayla should match Layla Benitez, NOT Henri Bergmann
  assert.equal(rows[1].name, 'Layla Benitez');
  assert.equal(rows[1].candidate?.name, 'Layla Benitez');
  assert.equal(rows[1].seenKey, 'layla benitez');
});
