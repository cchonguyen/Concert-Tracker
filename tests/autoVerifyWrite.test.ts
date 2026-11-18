import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { autoVerifyAct, undoEditionChange } from '../src/server/canon/editions.ts';
import type { ActEvidence } from '../src/server/canon/autoVerify.ts';
import type { Edition, EditionPerformance } from '../src/server/lineup/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';

const fresh = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'avw-')));
const act = (over: Partial<EditionPerformance> = {}): EditionPerformance => ({
  artistKey: 'above-beyond',
  name: 'Above & Beyond',
  days: [],
  stages: [],
  status: 'billed',
  confidence: 0.5,
  sources: [{ sourceType: 'promoter', sourceUrl: 'https://example.test/line', quotedSpan: 'Above & Beyond', evidence: 'billed', extractor: 'test' }],
  verification: 'candidate',
  ...over,
});
const edition = (performances: EditionPerformance[]): Edition => ({
  id: 'e1',
  key: 'ultra/2026',
  seriesSlug: 'ultra',
  year: 2026,
  name: 'Ultra 2026',
  status: 'verified',
  updatedAt: '2026-01-01T00:00:00.000Z',
  performances,
});
const expected = { editionKey: 'ultra/2026', name: 'Above & Beyond', date: '2026-03-27' };
const ev = (sourceId: string, over: Partial<ActEvidence> = {}): ActEvidence => ({
  sourceId,
  kind: 'fetched_page',
  trusted: false,
  editionKey: 'ultra/2026',
  name: 'Above & Beyond',
  date: '2026-03-27',
  ...over,
});

test('auto-verify write: two fetched sources flip a candidate act to verified and record it', async () => {
  const s = await fresh();
  await s.upsertEdition(edition([act()]));
  const r = await autoVerifyAct(s, { editionId: 'e1', artistKey: 'above-beyond', evidence: [ev('a'), ev('b')], expected, actor: 'system:lookup', reason: 'two sources' });
  assert.equal(r.ok && r.changed, true);
  const got = await s.getEdition('e1');
  assert.equal(got?.performances[0].verification, 'verified');
  const change = (await s.listEditionChanges('e1'))[0];
  assert.equal(change.actor, 'system:lookup');
});

test('auto-verify write: one untrusted source changes nothing', async () => {
  const s = await fresh();
  await s.upsertEdition(edition([act()]));
  const r = await autoVerifyAct(s, { editionId: 'e1', artistKey: 'above-beyond', evidence: [ev('a')], expected, actor: 'system:lookup', reason: 'one' });
  assert.equal(r.ok && r.changed, false);
  assert.equal((await s.getEdition('e1'))?.performances[0].verification, 'candidate');
});

test('auto-verify write: a member tick plus another tick never verifies', async () => {
  const s = await fresh();
  await s.upsertEdition(edition([act()]));
  const ticks = [ev('t1', { kind: 'member_entry' }), ev('t2', { kind: 'member_entry' })];
  const r = await autoVerifyAct(s, { editionId: 'e1', artistKey: 'above-beyond', evidence: ticks, expected, actor: 'system:lookup', reason: 'ticks' });
  assert.equal(r.ok && r.changed, false);
});

test('auto-verify write: undo puts the act back to candidate, and a second undo is refused', async () => {
  const s = await fresh();
  await s.upsertEdition(edition([act()]));
  const r = await autoVerifyAct(s, { editionId: 'e1', artistKey: 'above-beyond', evidence: [ev('a'), ev('b')], expected, actor: 'system:lookup', reason: 'two' });
  assert.ok(r.ok && r.changeId);
  const first = await undoEditionChange(s, 'e1', r.ok ? r.changeId! : '', 'owner');
  assert.equal(first.ok, true);
  assert.equal((await s.getEdition('e1'))?.performances[0].verification, 'candidate');
  const second = await undoEditionChange(s, 'e1', r.ok ? r.changeId! : '', 'owner');
  assert.equal(second.ok, false);
});

test('auto-verify write: an act already verified is left alone', async () => {
  const s = await fresh();
  await s.upsertEdition(edition([act({ verification: 'verified' })]));
  const r = await autoVerifyAct(s, { editionId: 'e1', artistKey: 'above-beyond', evidence: [ev('a'), ev('b')], expected, actor: 'system:lookup', reason: 'again' });
  assert.equal(r.ok && r.changed, false);
});
