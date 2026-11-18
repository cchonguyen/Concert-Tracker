import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Edition } from '../src/server/lineup/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { addEditionAct, undoEditionChange } from '../src/server/canon/editions.ts';

const fresh = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'edact-')));
const ed = (over: Partial<Edition> = {}): Edition => ({
  id: 'e1', key: 's/2026', seriesSlug: 's', year: 2026, name: 'Tsha at Sound Nightclub', status: 'verified', updatedAt: '2026-01-01T00:00:00.000Z', performances: [], ...over,
});

test('an owner tap adds the act with an edition-name source and records the change', async () => {
  const s = await fresh();
  await s.upsertEdition(ed());
  const r = await addEditionAct(s, { editionId: 'e1', artistKey: 'tsha', artistName: 'Tsha', actor: 'owner', reason: 'edition name' });
  assert.equal(r.ok, true);
  const got = await s.getEdition('e1');
  assert.equal(got!.performances.length, 1);
  assert.equal(got!.performances[0].sources[0].sourceType, 'edition name');
  assert.equal(got!.performances[0].sources[0].quotedSpan, 'Tsha at Sound Nightclub');
  const [change] = await s.listEditionChanges('e1');
  assert.equal(change.reason, 'edition name');
  assert.equal((change.after as Record<string, unknown>).lineupActAdded, 'tsha');
});

test('an act already on the lineup is not added twice', async () => {
  const s = await fresh();
  await s.upsertEdition(ed());
  await addEditionAct(s, { editionId: 'e1', artistKey: 'tsha', artistName: 'Tsha', actor: 'owner', reason: 'edition name' });
  const again = await addEditionAct(s, { editionId: 'e1', artistKey: 'tsha', artistName: 'Tsha', actor: 'owner', reason: 'edition name' });
  assert.deepEqual(again, { ok: false, reason: 'already_listed' });
  assert.equal((await s.getEdition('e1'))!.performances.length, 1);
});

test('undo removes the act added by the tap, and a second undo is refused', async () => {
  const s = await fresh();
  await s.upsertEdition(ed());
  await addEditionAct(s, { editionId: 'e1', artistKey: 'tsha', artistName: 'Tsha', actor: 'owner', reason: 'edition name' });
  const [change] = await s.listEditionChanges('e1');
  const undo = await undoEditionChange(s, 'e1', change.id, 'owner');
  assert.equal(undo.ok, true);
  assert.equal((await s.getEdition('e1'))!.performances.length, 0);
  assert.deepEqual(await undoEditionChange(s, 'e1', change.id, 'owner'), { ok: false, reason: 'already_undone' });
});

test('undo refuses when the act has been edited since it was added', async () => {
  const s = await fresh();
  await s.upsertEdition(ed());
  await addEditionAct(s, { editionId: 'e1', artistKey: 'tsha', artistName: 'Tsha', actor: 'owner', reason: 'edition name' });
  const current = (await s.getEdition('e1'))!;
  current.performances[0].sources.push({ sourceType: 'promoter', sourceUrl: 'https://x', quotedSpan: 'Tsha', evidence: 'billed', extractor: 'x' });
  await s.upsertEdition(current);
  const [change] = await s.listEditionChanges('e1');
  assert.deepEqual(await undoEditionChange(s, 'e1', change.id, 'owner'), { ok: false, reason: 'stale' });
});

test('an unknown edition is refused', async () => {
  const s = await fresh();
  assert.deepEqual(await addEditionAct(s, { editionId: 'nope', artistKey: 'tsha', artistName: 'Tsha', actor: 'owner', reason: 'edition name' }), { ok: false, reason: 'unknown' });
});
