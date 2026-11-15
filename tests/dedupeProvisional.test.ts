import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Edition, EditionPerformance } from '../src/server/lineup/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { writeEdition } from '../src/server/canon/editions.ts';
import { dedupeProvisionalEditions } from '../src/server/canon/dedupeProvisional.ts';

const fresh = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'dd-')));

const perf = (name: string): EditionPerformance => ({
  artistKey: name.toLowerCase(),
  name,
  days: [],
  stages: [],
  status: 'billed',
  confidence: 1,
  sources: [],
});

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

test('Pass 2: auto-merges 0-lineup provisional edition into populated verified edition', async () => {
  const s = await fresh();
  await seed(s, ed('p1', { name: 'Artist A', venue: 'The Hall', city: 'Austin', performances: [] }));
  await seed(s, ed('v1', { name: 'Artist A', venue: 'The Hall', city: 'Austin', status: 'verified', performances: [perf('Artist A')] }));
  const r = await dedupeProvisionalEditions(s);
  assert.deepEqual(r, { groups: 1, merged: 1 });
  const remaining = await s.listEditions(10);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, 'v1');
  assert.equal(remaining[0].status, 'verified');
  assert.equal(remaining[0].performances.length, 1);
  assert.equal(remaining[0].hasLineup, true);
});

test('Pass 2: auto-merges 0-lineup verified into populated operator-recheck verified, preserving canonical key', async () => {
  const s = await fresh();
  // v_canon is verified, empty lineup, canonical key, has venue text but no venueId
  await seed(s, ed('v_canon', {
    key: 'artist-a/2024',
    name: 'Artist A',
    venue: 'The Hall',
    city: 'Austin',
    status: 'verified',
    performances: [],
  }));
  // v_recheck is operator-recheck/, has venueId and populated lineup
  const v = await s.upsertVenue({ name: 'The Hall', city: 'Austin' });
  await seed(s, ed('v_recheck', {
    key: 'operator-recheck/artist-a-2024',
    name: 'Artist A',
    venue: 'The Hall',
    venueId: v.id,
    city: 'Austin',
    status: 'verified',
    performances: [perf('Artist A'), perf('Support B')],
  }));
  const r = await dedupeProvisionalEditions(s);
  assert.deepEqual(r, { groups: 1, merged: 1 });
  const remaining = await s.listEditions(10);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, 'v_canon');
  assert.equal(remaining[0].key, 'artist-a/2024');
  assert.equal(remaining[0].status, 'verified');
  assert.equal(remaining[0].performances.length, 2);
  assert.equal(remaining[0].hasLineup, true);
});

test('Pass 2: refuses to auto-merge when both matching editions have populated lineups', async () => {
  const s = await fresh();
  await seed(s, ed('v1', { status: 'verified', performances: [perf('Artist A')] }));
  await seed(s, ed('v2', { status: 'verified', performances: [perf('Artist B')] }));
  const r = await dedupeProvisionalEditions(s);
  assert.equal(r, null);
  assert.equal((await s.listEditions(10)).length, 2);
});

test('Pass 2: refuses to auto-merge when the populated edition is provisional (not verified)', async () => {
  const s = await fresh();
  // p1 is populated but provisional
  await seed(s, ed('p1', { status: 'provisional', venue: 'Venue A', performances: [perf('Artist A')] }));
  // p2 has 0 lineup and different venue so Pass 1 doesn't group them
  await seed(s, ed('p2', { status: 'provisional', venue: 'Venue B', performances: [] }));
  const r = await dedupeProvisionalEditions(s);
  assert.equal(r, null);
  assert.equal((await s.listEditions(10)).length, 2);
});

test('Pass 2: refuses to auto-merge when venues/cities/dates do not match', async () => {
  const s = await fresh();
  await seed(s, ed('v1', { status: 'verified', venue: 'Venue X', city: 'Austin', performances: [perf('Artist A')] }));
  await seed(s, ed('v2', { status: 'verified', venue: 'Venue Y', city: 'Austin', performances: [] }));
  const r = await dedupeProvisionalEditions(s);
  assert.equal(r, null);
  assert.equal((await s.listEditions(10)).length, 2);
});
