import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Edition } from '../src/server/lineup/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { PersonalFieldError } from '../src/server/lineup/store/types.ts';
import { undoEditionChange, writeEdition } from '../src/server/canon/editions.ts';

const fresh = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'edch-')));
const ed = (over: Partial<Edition> = {}): Edition => ({
  id: 'e1', key: 's/2026', seriesSlug: 's', year: 2026, name: 'Fest', status: 'provisional', updatedAt: '2026-01-01T00:00:00.000Z', performances: [], ...over,
});

test('a write records before and after for changed fields only', async () => {
  const s = await fresh();
  await writeEdition(s, { edition: ed(), actor: 'system:test', reason: 'first' });
  const r = await writeEdition(s, { edition: ed({ city: 'Austin', name: 'Fest 2' }), actor: 'owner:1', reason: 'fix' });
  assert.equal(r.changed, true);
  assert.deepEqual(r.change!.before, { name: 'Fest', city: null });
  assert.deepEqual(r.change!.after, { name: 'Fest 2', city: 'Austin' });
  assert.equal(r.change!.actor, 'owner:1');
  assert.equal((await s.listEditionChanges('e1')).length, 2);
});

test('a write that changes nothing records nothing', async () => {
  const s = await fresh();
  await writeEdition(s, { edition: ed(), actor: 'a', reason: 'r' });
  const r = await writeEdition(s, { edition: ed({ updatedAt: '2027-01-01T00:00:00.000Z' }), actor: 'a', reason: 'r' });
  assert.equal(r.changed, false);
  assert.equal((await s.listEditionChanges('e1')).length, 1);
});

test('undo restores the old value and marks the change undone', async () => {
  const s = await fresh();
  await writeEdition(s, { edition: ed({ city: 'Austin' }), actor: 'a', reason: 'r' });
  const w = await writeEdition(s, { edition: ed({ city: 'Dallas' }), actor: 'a', reason: 'r' });
  const u = await undoEditionChange(s, 'e1', w.change!.id, 'owner:1');
  assert.equal(u.ok, true);
  assert.equal((await s.getEdition('e1'))!.city, 'Austin');
  const list = await s.listEditionChanges('e1');
  assert.ok(list.find((c) => c.id === w.change!.id)!.undoneAt);
  assert.ok(list.some((c) => c.reason === `undo of ${w.change!.id}`));
  const again = await undoEditionChange(s, 'e1', w.change!.id, 'owner:1');
  assert.deepEqual(again, { ok: false, reason: 'already_undone' });
});

test('undo refuses when a later change touched the same field', async () => {
  const s = await fresh();
  await writeEdition(s, { edition: ed({ city: 'Austin' }), actor: 'a', reason: 'r' });
  const w1 = await writeEdition(s, { edition: ed({ city: 'Dallas' }), actor: 'a', reason: 'r' });
  await writeEdition(s, { edition: ed({ city: 'Houston' }), actor: 'a', reason: 'r' });
  assert.deepEqual(await undoEditionChange(s, 'e1', w1.change!.id, 'x'), { ok: false, reason: 'stale' });
  assert.equal((await s.getEdition('e1'))!.city, 'Houston');
});

test('a personal field in a change payload is rejected', async () => {
  const s = await fresh();
  await assert.rejects(s.recordEditionChange({ editionId: 'e1', actor: 'a', after: { rating: 5 } }), PersonalFieldError);
});

test('nothing outside editions.ts and the stores calls store.upsertEdition', async () => {
  const root = path.resolve('src');
  const bad: string[] = [];
  const walk = async (dir: string) => {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) await walk(p);
      else if (/\.tsx?$/.test(d.name) && !p.includes(`${path.sep}lineup${path.sep}store${path.sep}`) && !p.endsWith(path.join('canon', 'editions.ts'))) {
        if (/\.upsertEdition\(/.test(await readFile(p, 'utf8'))) bad.push(p);
      }
    }
  };
  await walk(root);
  assert.deepEqual(bad, []);
});
