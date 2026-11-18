import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Edition, EditionPerformance } from '../src/server/lineup/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';

const fresh = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'pverif-')));
const act = (over: Partial<EditionPerformance> = {}): EditionPerformance => ({
  artistKey: 'above-beyond',
  name: 'Above & Beyond',
  days: [],
  stages: [],
  status: 'billed',
  confidence: 0.9,
  sources: [{ sourceType: 'promoter', sourceUrl: 'https://example.test/line', quotedSpan: 'Above & Beyond', evidence: 'billed', extractor: 'test' }],
  ...over,
});
const ed = (performances: EditionPerformance[]): Edition => ({
  id: 'e1',
  key: 'ultra/2026',
  seriesSlug: 'ultra',
  year: 2026,
  name: 'Ultra 2026',
  status: 'verified',
  updatedAt: '2026-01-01T00:00:00.000Z',
  performances,
});

test('performance verification: a candidate act round-trips through the store', async () => {
  const s = await fresh();
  await s.upsertEdition(ed([act({ verification: 'candidate' })]));
  const got = await s.getEdition('e1');
  assert.equal(got?.performances[0].verification, 'candidate');
});
