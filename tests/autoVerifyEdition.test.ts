import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { autoVerifyEdition, undoEditionChange } from '../src/server/canon/editions.ts';
import type { EditionFieldFacts } from '../src/server/canon/autoVerify.ts';
import type { Edition } from '../src/server/lineup/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';

const fresh = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'aved-')));
const edition = (over: Partial<Edition> = {}): Edition => ({
  id: 'e1',
  key: 'ultra/2026',
  seriesSlug: 'ultra',
  year: 2026,
  name: 'Ultra 2026',
  status: 'provisional',
  updatedAt: '2026-01-01T00:00:00.000Z',
  performances: [],
  ...over,
});
const full: EditionFieldFacts = {
  name: { value: 'Ultra 2026', verified: true },
  act: { value: 'Above & Beyond', verified: true },
  location: { value: 'Miami', verified: true },
  venue: { value: 'Bayfront Park', verified: true },
  date: { value: '2026-03-27', verified: true },
};

test('auto-verify edition: a provisional edition with all five verified fields becomes verified and is recorded', async () => {
  const s = await fresh();
  await s.upsertEdition(edition());
  const r = await autoVerifyEdition(s, { editionId: 'e1', facts: full, actor: 'system:lookup', reason: 'complete' });
  assert.equal(r.ok && r.changed, true);
  assert.equal((await s.getEdition('e1'))?.status, 'verified');
  assert.equal((await s.listEditionChanges('e1'))[0].actor, 'system:lookup');
});

test('auto-verify edition: one unverified field keeps it provisional', async () => {
  const s = await fresh();
  await s.upsertEdition(edition());
  const r = await autoVerifyEdition(s, { editionId: 'e1', facts: { ...full, venue: { value: 'Bayfront Park', verified: false } }, actor: 'system:lookup', reason: 'partial' });
  assert.equal(r.ok && r.changed, false);
  assert.equal((await s.getEdition('e1'))?.status, 'provisional');
});

test('auto-verify edition: a missing field keeps it provisional', async () => {
  const s = await fresh();
  await s.upsertEdition(edition());
  const { venue: _venue, ...partial } = full;
  const r = await autoVerifyEdition(s, { editionId: 'e1', facts: partial, actor: 'system:lookup', reason: 'missing' });
  assert.equal(r.ok && r.changed, false);
});

test('auto-verify edition: a draft is never auto-verified', async () => {
  const s = await fresh();
  await s.upsertEdition(edition({ status: 'draft' }));
  const r = await autoVerifyEdition(s, { editionId: 'e1', facts: full, actor: 'system:lookup', reason: 'draft' });
  assert.equal(r.ok && r.changed, false);
  assert.equal((await s.getEdition('e1'))?.status, 'draft');
});

test('auto-verify edition: undo puts it back to provisional, and a second undo is refused', async () => {
  const s = await fresh();
  await s.upsertEdition(edition());
  const r = await autoVerifyEdition(s, { editionId: 'e1', facts: full, actor: 'system:lookup', reason: 'complete' });
  assert.ok(r.ok && r.changeId);
  const id = r.ok ? r.changeId! : '';
  assert.equal((await undoEditionChange(s, 'e1', id, 'owner')).ok, true);
  assert.equal((await s.getEdition('e1'))?.status, 'provisional');
  assert.equal((await undoEditionChange(s, 'e1', id, 'owner')).ok, false);
});
