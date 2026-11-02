import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mergeLineup } from '../src/server/lineup/merge.ts';
import { confirmLookup, mergeSeen } from '../src/server/lineup/learning.ts';
import { candidateFromEdition } from '../src/server/lineup/pipeline.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { LookupJob, PerformerClaim } from '../src/server/lineup/types.ts';
import { newEvent } from '../src/server/events/service.ts';

const claim = (name: string, extra: Partial<PerformerClaim> = {}): PerformerClaim => ({
  id: name,
  jobId: 'j',
  documentId: 'd',
  sourceType: 'clashfinder',
  sourceUrl: 'https://clashfinder.com/s/edc/',
  name,
  quotedSpan: name,
  evidence: 'billed',
  extractor: 'cf',
  extractorVersion: '1',
  createdAt: '2024-05-01',
  ...extra,
});

const baseMerge = {
  input: { eventName: 'EDC Las Vegas', year: 2024 },
  editionKey: 'edc-las-vegas/2024',
  seriesSlug: 'edc-las-vegas',
  facts: {},
  aliases: {},
  blocklist: [],
  stats: [],
};

test('an artist playing both solo and B2B produces 2 separate candidates in mergeLineup', () => {
  const claims = [
    claim('John Summit', { day: '2024-05-17', stage: 'circuitGROUNDS' }),
    claim('John Summit b2b Dom Dolla', { day: '2024-05-19', stage: 'kineticFIELD' }),
  ];

  const lineup = mergeLineup({
    ...baseMerge,
    claims,
  });

  assert.equal(lineup.performers.length, 3);

  const summits = lineup.performers.filter((p) => p.name === 'John Summit');
  assert.equal(summits.length, 2);

  const soloSummit = summits.find((p) => !p.b2b?.length);
  assert.ok(soloSummit);
  assert.equal(soloSummit.key, 'john summit');
  assert.equal(soloSummit.slotId, undefined);
  assert.deepEqual(soloSummit.stages, ['circuitGROUNDS']);
  assert.deepEqual(soloSummit.days, ['2024-05-17']);

  const b2bSummit = summits.find((p) => p.b2b?.includes('dom dolla'));
  assert.ok(b2bSummit);
  assert.equal(b2bSummit.key, 'john summit');
  assert.ok(b2bSummit.slotId);
  assert.deepEqual(b2bSummit.stages, ['kineticFIELD']);
  assert.deepEqual(b2bSummit.days, ['2024-05-19']);

  const dom = lineup.performers.find((p) => p.name === 'Dom Dolla');
  assert.ok(dom);
  assert.equal(dom.key, 'dom dolla');
  assert.deepEqual(dom.b2b, ['john summit']);
  assert.equal(dom.slotId, b2bSummit.slotId);
  assert.deepEqual(dom.stages, ['kineticFIELD']);
  assert.deepEqual(dom.days, ['2024-05-19']);
});

test('multi-artist B2Bs (A b2b B b2b C) produce 3 candidates each linked to the other two with the same slotId', () => {
  const claims = [claim('Dom Dolla b2b John Summit b2b Mau P', { day: '2024-05-19', stage: 'kineticFIELD' })];

  const lineup = mergeLineup({
    ...baseMerge,
    claims,
  });

  assert.equal(lineup.performers.length, 3);
  const byName = Object.fromEntries(lineup.performers.map((p) => [p.name, p]));

  const dom = byName['Dom Dolla'];
  const john = byName['John Summit'];
  const mau = byName['Mau P'];

  assert.ok(dom && john && mau);
  assert.ok(dom.slotId);
  assert.equal(john.slotId, dom.slotId);
  assert.equal(mau.slotId, dom.slotId);

  assert.deepEqual(dom.b2b?.sort(), ['john summit', 'mau p']);
  assert.deepEqual(john.b2b?.sort(), ['dom dolla', 'mau p']);
  assert.deepEqual(mau.b2b?.sort(), ['dom dolla', 'john summit']);
});

test('vs and vs. variations produce B2B candidates with mutual b2b and slotId', () => {
  const claims = [claim('Cirez D vs Adam Beyer')];

  const lineup = mergeLineup({
    ...baseMerge,
    claims,
  });

  assert.equal(lineup.performers.length, 2);
  const cirez = lineup.performers.find((p) => p.name === 'Cirez D');
  const adam = lineup.performers.find((p) => p.name === 'Adam Beyer');

  assert.ok(cirez && adam);
  assert.ok(cirez.slotId);
  assert.equal(adam.slotId, cirez.slotId);
  assert.deepEqual(cirez.b2b, ['adam beyer']);
  assert.deepEqual(adam.b2b, ['cirez d']);
});

test('confirmLookup preserves b2b and slotId on EditionPerformance and saves multiple seen entries for the same artist in LoggedEvent.seen', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'b2b-confirm-'));
  try {
    const store = new FileLineupStore(dir);
    const event = { ...newEvent('EDC Las Vegas 2024', new Date('2024-05-20')), seen: [] };
    await store.putEvent(event);

    const slotId = 'shared-b2b-slot-id';
    const candSoloSummit = {
      key: 'john summit',
      name: 'John Summit',
      days: ['2024-05-17'],
      stages: ['circuitGROUNDS'],
      status: 'billed' as const,
      confidence: 1,
      flagged: false,
      sources: [],
    };
    const candB2bSummit = {
      key: 'john summit',
      slotId,
      name: 'John Summit',
      days: ['2024-05-19'],
      stages: ['kineticFIELD'],
      status: 'billed' as const,
      b2b: ['dom dolla'],
      confidence: 1,
      flagged: false,
      sources: [],
    };
    const candB2bDom = {
      key: 'dom dolla',
      slotId,
      name: 'Dom Dolla',
      days: ['2024-05-19'],
      stages: ['kineticFIELD'],
      status: 'billed' as const,
      b2b: ['john summit'],
      confidence: 1,
      flagged: false,
      sources: [],
    };

    const job: LookupJob = {
      id: 'job-1',
      kind: 'lineup',
      input: { eventName: 'EDC Las Vegas', year: 2024 },
      editionKey: 'edc-las-vegas/2024',
      status: 'needs_review',
      stage: 'done',
      attempts: 1,
      pendingExtraction: [],
      discoveryDone: true,
      facts: {},
      candidate: {
        editionKey: 'edc-las-vegas/2024',
        cached: false,
        facts: { sources: {} },
        performers: [candSoloSummit, candB2bSummit, candB2bDom],
        droppedCount: 0,
      },
      eventId: event.id,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.createJob(job);

    const result = await confirmLookup(store, job, {
      facts: { name: 'EDC Las Vegas 2024' },
      performers: [
        { key: 'john summit', name: 'John Summit', accepted: true, seen: true },
        { key: 'john summit', slotId, b2b: ['dom dolla'], name: 'John Summit', accepted: true, seen: true },
        { key: 'dom dolla', slotId, b2b: ['john summit'], name: 'Dom Dolla', accepted: true, seen: true },
      ],
    });

    // 1. Check edition performances: does NOT collapse solo and B2B
    assert.equal(result.edition.performances.length, 3);
    const soloPerf = result.edition.performances.find((p) => p.artistKey === 'john summit' && !p.b2b?.length);
    assert.ok(soloPerf);
    assert.equal(soloPerf.slotId, undefined);
    assert.deepEqual(soloPerf.stages, ['circuitGROUNDS']);

    const b2bSummitPerf = result.edition.performances.find((p) => p.artistKey === 'john summit' && p.b2b?.includes('dom dolla'));
    assert.ok(b2bSummitPerf);
    assert.equal(b2bSummitPerf.slotId, slotId);
    assert.deepEqual(b2bSummitPerf.b2b, ['dom dolla']);
    assert.deepEqual(b2bSummitPerf.stages, ['kineticFIELD']);

    const b2bDomPerf = result.edition.performances.find((p) => p.artistKey === 'dom dolla');
    assert.ok(b2bDomPerf);
    assert.equal(b2bDomPerf.slotId, slotId);
    assert.deepEqual(b2bDomPerf.b2b, ['john summit']);

    // 2. Check candidateFromEdition preserves slotId and b2b
    const regenerated = candidateFromEdition(result.edition);
    assert.equal(regenerated.performers.length, 3);
    const regB2bSummit = regenerated.performers.find((p) => p.key === 'john summit' && p.b2b?.includes('dom dolla'));
    assert.ok(regB2bSummit);
    assert.equal(regB2bSummit.slotId, slotId);
    assert.deepEqual(regB2bSummit.b2b, ['dom dolla']);

    // 3. Check event.seen: multiple seen acts for John Summit
    assert.ok(result.event);
    assert.equal(result.event.seen.length, 3);
    const seenSummits = result.event.seen.filter((s) => s.key === 'john summit');
    assert.equal(seenSummits.length, 2);
    // Ensure distinct IDs
    assert.ok(seenSummits[0].id);
    assert.ok(seenSummits[1].id);
    assert.notEqual(seenSummits[0].id, seenSummits[1].id);

    const soloSeen = seenSummits.find((s) => !s.b2b?.length);
    assert.ok(soloSeen);
    assert.equal(soloSeen.slotId, undefined);

    const b2bSeen = seenSummits.find((s) => s.b2b?.includes('dom dolla'));
    assert.ok(b2bSeen);
    assert.equal(b2bSeen.slotId, slotId);
    assert.deepEqual(b2bSeen.b2b, ['dom dolla']);

    const domSeen = result.event.seen.find((s) => s.key === 'dom dolla');
    assert.ok(domSeen);
    assert.equal(domSeen.slotId, slotId);
    assert.deepEqual(domSeen.b2b, ['john summit']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mergeSeen does not collapse multiple seen acts for the same artist and assigns unique IDs', () => {
  const ticked = [
    { key: 'john summit', name: 'John Summit', from: 'lineup' as const },
    { key: 'john summit', name: 'John Summit', from: 'lineup' as const, b2b: ['dom dolla'], slotId: 'slot-1' },
    { key: 'dom dolla', name: 'Dom Dolla', from: 'lineup' as const, b2b: ['john summit'], slotId: 'slot-1' },
  ];

  const merged = mergeSeen([], ticked, new Set(['john summit', 'dom dolla']));
  assert.equal(merged.length, 3);

  const summits = merged.filter((s) => s.key === 'john summit');
  assert.equal(summits.length, 2);
  assert.ok(summits[0].id);
  assert.ok(summits[1].id);
  assert.notEqual(summits[0].id, summits[1].id);

  const solo = summits.find((s) => !s.b2b?.length);
  assert.ok(solo);

  const b2b = summits.find((s) => s.b2b?.includes('dom dolla'));
  assert.ok(b2b);
  assert.equal(b2b.slotId, 'slot-1');
});

test('mergeLineup resolves collaboration aliases (e.g. Subjohnics) into B2B candidates with alias preserved', () => {
  const claims = [claim('Subjohnics', { day: '2024-05-19', stage: 'kineticFIELD' })];
  const lineup = mergeLineup({
    ...baseMerge,
    aliases: { subjohnics: 'John Summit b2b Subtronics' },
    claims,
  });

  assert.equal(lineup.performers.length, 2);
  const summit = lineup.performers.find((p) => p.name === 'John Summit');
  const subtronics = lineup.performers.find((p) => p.name === 'Subtronics');

  assert.ok(summit && subtronics);
  assert.equal(summit.alias, 'Subjohnics');
  assert.equal(subtronics.alias, 'Subjohnics');
  assert.equal(summit.slotId, subtronics.slotId);
  assert.deepEqual(summit.b2b, ['subtronics']);
  assert.deepEqual(subtronics.b2b, ['john summit']);
});
