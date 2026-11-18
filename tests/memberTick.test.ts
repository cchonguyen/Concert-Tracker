import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { recordMemberTick, recordWhoISawTicks } from '../src/server/canon/memberTick.ts';
import { undoEditionChange } from '../src/server/canon/editions.ts';
import type { Edition } from '../src/server/lineup/types.ts';

const base = (over: Partial<Edition> = {}): Edition => ({
  id: 'ed-1',
  key: 'ultra/2026',
  year: 2026,
  name: 'Ultra 2026',
  status: 'verified',
  performances: [],
  updatedAt: '2026-11-18T00:00:00.000Z',
  ...over,
} as Edition);

test('member tick: adds a candidate act sourced "your entry" with no personal field', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'mt-')));
  const ed = base();
  await store.upsertEdition(ed);
  const r = await recordMemberTick(store, { editionId: ed.id, artistKey: 'above and beyond', artistName: 'Above & Beyond', actor: 'member:entry', reason: 'Member tick from Who I Saw' });
  assert.equal(r.ok, true);
  const got = await store.getEdition(ed.id);
  const act = got!.performances[0];
  assert.equal(act.verification, 'candidate');
  assert.equal(act.sources[0].extractor, 'your entry');
  assert.equal(act.sources[0].quotedSpan, 'Above & Beyond');
  const json = JSON.stringify(got);
  assert.equal(/userId|eventId|attendance|rating|companion/.test(json), false);
});

test('member tick: a second member tick for the same act is refused and does not demote', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'mt-')));
  const ed = base({
    performances: [{ artistKey: 'abc', name: 'ABC', days: [], stages: [], status: 'billed', confidence: 1, verification: 'verified', sources: [] }],
  });
  await store.upsertEdition(ed);
  const r = await recordMemberTick(store, { editionId: ed.id, artistKey: 'abc', artistName: 'ABC', actor: 'member:entry', reason: 'x' });
  assert.deepEqual(r, { ok: false, reason: 'already_listed' });
  assert.equal((await store.getEdition(ed.id))!.performances[0].verification, 'verified');
});

test('member tick: an unknown edition or empty name writes nothing', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'mt-')));
  assert.deepEqual(await recordMemberTick(store, { editionId: 'nope', artistKey: 'x', artistName: 'X', actor: 'member:entry', reason: 'x' }), { ok: false, reason: 'unknown' });
  assert.deepEqual(await recordMemberTick(store, { editionId: 'nope', artistKey: 'x', artistName: '  ', actor: 'member:entry', reason: 'x' }), { ok: false, reason: 'empty' });
});

test('who I saw: only your own acts not yet listed are ticked', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'mt-')));
  const ed = base();
  await store.upsertEdition(ed);
  const seen = [
    { key: 'one', name: 'One', from: 'you' as const },
    { key: 'two', name: 'Two', from: 'lineup' as const },
  ];
  const added = await recordWhoISawTicks(store, ed, seen);
  assert.deepEqual(added, ['one']);
  const got = await store.getEdition(ed.id);
  assert.deepEqual(got!.performances.map((p) => p.artistKey), ['one']);
});

test('member tick: undo removes the candidate act', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'mt-')));
  const ed = base();
  await store.upsertEdition(ed);
  const r = await recordMemberTick(store, { editionId: ed.id, artistKey: 'zed', artistName: 'Zed', actor: 'member:entry', reason: 'x' });
  assert.equal(r.ok, true);
  const changeId = (r as { changeId: string | null }).changeId!;
  const undone = await undoEditionChange(store, ed.id, changeId, 'owner');
  assert.equal(undone.ok, true);
  assert.equal((await store.getEdition(ed.id))!.performances.length, 0);
});
