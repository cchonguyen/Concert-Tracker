import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineConfidence, mergeLineup, sourceReliability } from '../src/server/lineup/merge.ts';
import { PerformerClaim } from '../src/server/lineup/types.ts';

let n = 0;
function claim(partial: Partial<PerformerClaim>): PerformerClaim {
  return {
    id: String(++n),
    jobId: 'j',
    documentId: 'd',
    sourceType: 'clashfinder',
    sourceUrl: 'https://clashfinder.com/s/edc25/',
    name: 'Kaskade',
    quotedSpan: 'Kaskade',
    evidence: 'crowd',
    extractor: 'clashfinder',
    extractorVersion: '1',
    createdAt: '2025-01-01',
    ...partial,
  };
}

const base = {
  input: { eventName: 'EDC Las Vegas', year: 2025 },
  editionKey: 'edc-las-vegas/2025',
  seriesSlug: 'edc-las-vegas',
  facts: {},
  aliases: {},
  blocklist: [],
  stats: [],
};

test('agreeing sources raise confidence', () => {
  const one = combineConfidence([0.85]);
  const two = combineConfidence([0.85, 0.9]);
  assert.ok(two > one);
});

test('review history moves source reliability', () => {
  const prior = sourceReliability('clashfinder', 'edc-las-vegas', []);
  const bad = sourceReliability('clashfinder', 'edc-las-vegas', [
    { sourceType: 'clashfinder', scope: 'edc-las-vegas', accepted: 0, rejected: 20 },
  ]);
  assert.ok(bad < prior);
});

test('merges spelling variants and marks setlist.fm evidence as performed', () => {
  const lineup = mergeLineup({
    ...base,
    claims: [
      claim({ name: 'Fred again..' }),
      claim({ name: 'Fred Again', sourceType: 'promoter', sourceUrl: 'https://lasvegas.electricdaisycarnival.com/lineup', evidence: 'billed' }),
      claim({ name: 'Fred again..', sourceType: 'setlistfm', evidence: 'performed', mbid: 'abc' }),
    ],
  });
  assert.equal(lineup.performers.length, 1);
  const p = lineup.performers[0];
  assert.equal(p.name, 'Fred Again'); // promoter wins display name by default priority
  assert.equal(p.status, 'performed');
  assert.equal(p.mbid, 'abc');
  assert.equal(p.sources.length, 3);
});

test('aliases and the blocklist apply before review', () => {
  const lineup = mergeLineup({
    ...base,
    aliases: { tiesto: 'Tiësto' },
    blocklist: [{ domain: 'clashfinder.com', normalized: 'main stage', rejections: 2 }],
    claims: [claim({ name: 'Tiesto' }), claim({ name: 'Main Stage' })],
  });
  assert.deepEqual(lineup.performers.map((p) => p.name), ['Tiësto']);
  assert.equal(lineup.droppedCount, 1);
});

test('a lone low-trust source is flagged', () => {
  const lineup = mergeLineup({
    ...base,
    stats: [{ sourceType: 'discovered', scope: '*', accepted: 0, rejected: 30 }],
    claims: [claim({ name: 'Somebody', sourceType: 'discovered', sourceUrl: 'https://blog.example.com/x' })],
  });
  assert.equal(lineup.performers[0].flagged, true);
});
