import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { NewEditionInference } from '../src/server/lineup/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';

const fresh = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'inf-')));
const inf = (over: Partial<NewEditionInference> = {}): NewEditionInference => ({
  editionId: 'e1', field: 'city', value: 'Austin', reason: 'the venue is in Austin', rule: 'venueCity',
  inputs: [{ kind: 'record', table: 'canonical_venues', id: 'venue:x' }], parents: [], actor: 'system:test', ...over,
});

test('add then list returns the inference as active, newest first', async () => {
  const s = await fresh();
  const a = await s.addEditionInference(inf());
  assert.equal(a.status, 'active');
  assert.ok(a.id);
  assert.ok(a.createdAt);
  await s.addEditionInference(inf({ field: 'country', value: 'US' }));
  const list = await s.listEditionInferences('e1');
  assert.equal(list.length, 2);
  assert.ok(list[0].createdAt >= list[1].createdAt);
});

test('an empty or blank reason is refused', async () => {
  const s = await fresh();
  await assert.rejects(s.addEditionInference(inf({ reason: '' })));
  await assert.rejects(s.addEditionInference(inf({ reason: '   ' })));
  assert.equal((await s.listEditionInferences('e1')).length, 0);
});

test('a second active inference for the same edition and field is refused', async () => {
  const s = await fresh();
  await s.addEditionInference(inf());
  await assert.rejects(s.addEditionInference(inf({ value: 'Dallas' })));
  assert.equal((await s.listEditionInferences('e1')).length, 1);
});

test('after a resolve the same field can take a new active inference', async () => {
  const s = await fresh();
  const a = await s.addEditionInference(inf());
  await s.resolveEditionInference(a.id, { status: 'replaced', by: 'owner:1', reason: 'typed value' });
  const b = await s.addEditionInference(inf({ value: 'Dallas' }));
  assert.equal(b.status, 'active');
});

test('resolve sets status and resolved fields, and returns null for a non-active row', async () => {
  const s = await fresh();
  const a = await s.addEditionInference(inf());
  const r = await s.resolveEditionInference(a.id, { status: 'confirmed', by: 'owner:1', reason: 'matches' });
  assert.ok(r);
  assert.equal(r.status, 'confirmed');
  assert.ok(r.resolvedAt);
  assert.equal(r.resolvedBy, 'owner:1');
  assert.equal(r.resolvedReason, 'matches');
  assert.equal(await s.resolveEditionInference(a.id, { status: 'rejected', by: 'owner:1', reason: 'again' }), null);
  assert.equal(await s.resolveEditionInference('missing-id', { status: 'rejected', by: 'owner:1', reason: 'x' }), null);
});

test('listInferenceChildren finds rows by parent', async () => {
  const s = await fresh();
  const parent = await s.addEditionInference(inf());
  const child = await s.addEditionInference(inf({ field: 'region', value: 'TX', parents: [parent.id], rule: 'cityRegion' }));
  await s.addEditionInference(inf({ field: 'country', value: 'US', parents: [] }));
  const kids = await s.listInferenceChildren(parent.id);
  assert.deepEqual(kids.map((k) => k.id), [child.id]);
  assert.deepEqual(await s.listInferenceChildren(child.id), []);
});

test('a row for one edition does not appear for another', async () => {
  const s = await fresh();
  await s.addEditionInference(inf({ editionId: 'e1' }));
  assert.equal((await s.listEditionInferences('e2')).length, 0);
  await s.addEditionInference(inf({ editionId: 'e2' }));
  assert.equal((await s.listEditionInferences('e1')).length, 1);
  assert.equal((await s.listEditionInferences('e2')).length, 1);
});

test('the migration holds the checks, the partial unique index and row level security', () => {
  const sql = readFileSync(new URL('../supabase/migrations/0055_edition_inferences.sql', import.meta.url), 'utf8');
  assert.match(sql, /field text not null check \(field in \('startDate', 'endDate', 'venue', 'city', 'region', 'country'\)\)/);
  assert.match(sql, /check \(length\(btrim\(reason\)\) > 0\)/);
  assert.match(sql, /check \(status in \('active', 'confirmed', 'replaced', 'rejected'\)\)/);
  assert.match(sql, /create unique index if not exists edition_inferences_active_uidx\s+on public\.edition_inferences \(edition_id, field\) where status = 'active'/);
  assert.match(sql, /alter table public\.edition_inferences enable row level security/);
  assert.match(sql, /create policy "owner_read" on public\.edition_inferences for select to authenticated/);
});
