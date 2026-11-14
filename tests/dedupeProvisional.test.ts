import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Edition } from '../src/server/lineup/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { writeEdition } from '../src/server/canon/editions.ts';
import { dedupeProvisionalEditions } from '../src/server/canon/dedupeProvisional.ts';

const fresh = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'dd-')));

const ed = (id: string, patch: Partial<Edition> = {}): Edition => ({
  id,
  key: `kream-2024-${id}`,
  seriesSlug: 'kream',
  year: 2024,
  name: 'KREAM',
  startDate: '2024-12-21',
  status: 'provisional',
  subjectKey: 'kream',
  performances: [],
  updatedAt: '2026-11-14T00:00:00.000Z',
  ...patch,
});

const seed = async (s: FileLineupStore, edition: Edition) =>
  writeEdition(s, { edition, actor: 'test', reason: 'seed' });

test('duplicate provisional editions fold into one, keeping the lowest id on a tie', async () => {
  const s = await fresh();
  for (const id of ['p3', 'p1', 'p2']) await seed(s, ed(id));
  const r = await dedupeProvisionalEditions(s);
  assert.deepEqual(r, { groups: 1, merged: 2 });
  assert.deepEqual((await s.listEditions(10)).map((e) => e.id).sort(), ['p1']);
});

test('verified, confirmed and draft editions are never read as keys or dropped', async () => {
  const s = await fresh();
  await seed(s, ed('p1'));
  await seed(s, ed('v1', { status: 'verified' }));
  await seed(s, ed('v2', { status: 'verified' }));
  await seed(s, ed('c1', { status: 'confirmed' }));
  await seed(s, ed('d1', { status: 'draft' }));
  const r = await dedupeProvisionalEditions(s);
  assert.equal(r, null);
  assert.deepEqual((await s.listEditions(10)).map((e) => e.id).sort(), ['c1', 'd1', 'p1', 'v1', 'v2']);
});

test('different venues or dates are different keys and are not merged', async () => {
  const s = await fresh();
  await seed(s, ed('p1', { venue: 'Club A' }));
  await seed(s, ed('p2', { venue: 'Club B' }));
  await seed(s, ed('p3', { startDate: '2024-12-22' }));
  const r = await dedupeProvisionalEditions(s);
  assert.equal(r, null);
  assert.equal((await s.listEditions(10)).length, 3);
});

test('the merge limit and the subrequest budget both stop the run early', async () => {
  const s = await fresh();
  for (const id of ['p1', 'p2', 'p3', 'p4']) await seed(s, ed(id));
  const limited = await dedupeProvisionalEditions(s, { limit: 1 });
  assert.deepEqual(limited, { groups: 1, merged: 1 });
  assert.equal((await s.listEditions(10)).length, 3);
  const none = await dedupeProvisionalEditions(s, { budgetLeft: () => 1 });
  assert.deepEqual(none, { groups: 1, merged: 0 });
  assert.equal((await s.listEditions(10)).length, 3);
});
