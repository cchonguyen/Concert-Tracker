import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { confirmLookup, findWholeCandidate } from '../src/server/lineup/learning.ts';
import { startRows } from '../src/services/reviewRows.ts';

const sets = [{ day: '2026-11-21', stage: 'Vision', start: '2026-11-21 20:00', end: '2026-11-21 21:00' }];
const listing = {
  key: 'allen watts talla 2xlc',
  name: 'Allen Watts + Talla 2XLC',
  days: ['2026-11-21'],
  stages: ['Vision'],
  confidence: 0.9,
  flagged: false,
  status: 'billed',
  sources: [{ sourceType: 'clashfinder', sourceUrl: 'https://clashfinder.com/s/ds26/', quotedSpan: 'Allen Watts + Talla 2XLC', evidence: 'crowd', extractor: 'clashfinder', sets }],
} as any;

test('findWholeCandidate matches a listing made of exactly the act and its partners', () => {
  assert.equal(findWholeCandidate([listing], { key: 'allen watts', b2b: ['talla 2xlc'] }), listing);
  assert.equal(findWholeCandidate([listing], { key: 'talla 2xlc', b2b: ['allen watts'] }), listing);
  assert.equal(findWholeCandidate([listing], { key: 'allen watts', b2b: ['someone else'] }), undefined);
  assert.equal(findWholeCandidate([listing], { key: 'allen watts', b2b: [] }), undefined); // a solo act is not split from it
  assert.equal(findWholeCandidate([listing], { key: 'watts', b2b: ['talla 2xlc'] }), undefined); // leftover words
});

test('a B2B split from one listing keeps its sources and set times on confirm', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'split-')));
  const job: any = {
    id: 'job-1', kind: 'lineup', editionKey: 'dreamstate-2026', status: 'needs_review', stage: 'done', attempts: 0,
    input: { eventName: 'Dreamstate', year: 2026, startDate: '2026-11-20', endDate: '2026-11-22' },
    pendingExtraction: [], discoveryDone: true, facts: {}, log: [], createdAt: '', updatedAt: '',
    candidate: { editionKey: 'dreamstate-2026', performers: [listing], droppedCount: 0 },
  };
  await store.createJob(job);
  const result = await confirmLookup(store, job, {
    performers: [
      { key: 'allen watts', name: 'Allen Watts', slotId: 's1', b2b: ['talla 2xlc'], accepted: true, seen: false },
      // Reopened from the saved edition, an act with no candidate row carries no key.
      { name: 'Talla 2XLC', slotId: 's1', b2b: ['allen watts'], accepted: true, seen: false },
    ],
  });
  const perfs = result.edition.performances;
  assert.deepEqual(perfs.map((p) => [p.name, p.slotId, p.b2b]), [
    ['Allen Watts', 's1', ['talla 2xlc']],
    ['Talla 2XLC', 's1', ['allen watts']],
  ]);
  for (const p of perfs) {
    assert.equal(p.sources[0].sourceType, 'clashfinder');
    assert.deepEqual(p.sources[0].sets, sets);
  }
  assert.equal(perfs[1].artistKey, 'talla 2xlc'); // the act sent without a key, matched by its name
  // Not treated as a rename or an act added by hand.
  assert.deepEqual(await store.getAliases(), {});
});

test('reopening keeps the saved slot and unticks an act stored twice', () => {
  const user = (name: string) => [{ sourceType: 'user', sourceUrl: '', quotedSpan: name, evidence: 'billed', extractor: 'user' }];
  const perf = (name: string, partner: string, slotId: string) =>
    ({ artistKey: name.toLowerCase(), name, b2b: [partner.toLowerCase()], slotId, days: [], stages: [], status: 'billed', confidence: 1, sources: user(name) });
  const edition = {
    performances: [perf('Allen Watts', 'Talla 2XLC', 'a'), perf('Talla 2XLC', 'Allen Watts', 'a'), perf('Allen Watts', 'Talla 2XLC', 'b'), perf('Talla 2XLC', 'Allen Watts', 'b')],
  } as any;
  const rows = startRows([], edition);
  assert.deepEqual(rows.map((r) => [r.name, r.slotId, r.accepted]), [
    ['Allen Watts', 'a', true],
    ['Talla 2XLC', 'a', true],
    ['Allen Watts', 'b', false],
    ['Talla 2XLC', 'b', false],
  ]);
});
