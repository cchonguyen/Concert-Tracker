import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Edition, EditionInference, InferenceInput } from '../src/server/lineup/types.ts';
import type { LineupStore } from '../src/server/lineup/store/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { undoEditionChange, writeEdition } from '../src/server/canon/editions.ts';
import { healEdition, inferEditionField, rejectInference, shownValue } from '../src/server/canon/inferences.ts';

const fresh = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'infr-')));
const ed = (over: Partial<Edition> = {}): Edition => ({
  id: 'e1', key: 's/2026', seriesSlug: 's', year: 2026, name: 'Fest', status: 'provisional', updatedAt: '2026-01-01T00:00:00.000Z', performances: [], ...over,
});
const venueInput: InferenceInput[] = [{ kind: 'record', table: 'canonical_venues', id: 'venue:x' }];

async function setup() {
  const s = await fresh();
  await writeEdition(s, { edition: ed(), actor: 'system:test', reason: 'created' });
  const current = async () => (await s.getEdition('e1'))!;
  return { s, current };
}

async function inferCity(s: LineupStore, edition: Edition, over: { value?: unknown; reason?: string } = {}) {
  return inferEditionField(s, {
    edition,
    field: 'city',
    value: 'Austin',
    reason: 'the venue is in Austin',
    rule: 'venueCity',
    inputs: venueInput,
    actor: 'system:test',
    ...over,
  });
}

function okInference(r: Awaited<ReturnType<typeof inferCity>>): EditionInference {
  assert.equal(r.ok, true);
  return (r as { ok: true; inference: EditionInference }).inference;
}

test('an inference on an empty field is stored and recorded; the edition row is unchanged', async () => {
  const { s, current } = await setup();
  const inf = okInference(await inferCity(s, await current()));
  assert.equal(inf.status, 'active');
  assert.equal(inf.field, 'city');
  assert.equal(inf.value, 'Austin');
  assert.equal((await current()).city, undefined);
  const change = (await s.listEditionChanges('e1')).find((c) => c.after?.inferenceAdded === inf.id);
  assert.ok(change, 'a change row names the inference');
  assert.equal(change!.after!.field, 'city');
  assert.equal(change!.after!.value, 'Austin');
  assert.equal(change!.actor, 'system:test');
  assert.equal(change!.reason, 'inferred city: the venue is in Austin');
});

test('an inference is refused when the edition field already has a value', async () => {
  const { s } = await setup();
  await writeEdition(s, { edition: ed({ city: 'Dallas' }), actor: 'owner:1', reason: 'typed' });
  assert.deepEqual(await inferCity(s, ed({ city: 'Dallas' })), { ok: false, reason: 'field_has_value' });
  assert.equal((await s.listEditionInferences('e1')).length, 0);
});

test('an inference is refused with an empty or blank reason', async () => {
  const { s, current } = await setup();
  assert.deepEqual(await inferCity(s, await current(), { reason: '' }), { ok: false, reason: 'no_reason' });
  assert.deepEqual(await inferCity(s, await current(), { reason: '   ' }), { ok: false, reason: 'no_reason' });
  assert.equal((await s.listEditionInferences('e1')).length, 0);
});

test('an inference is refused with an empty value', async () => {
  const { s, current } = await setup();
  for (const value of ['', null, undefined, '  ']) {
    assert.deepEqual(await inferCity(s, await current(), { value }), { ok: false, reason: 'empty_value' });
  }
  assert.equal((await s.listEditionInferences('e1')).length, 0);
});

test('a second active inference for the same field is refused', async () => {
  const { s, current } = await setup();
  okInference(await inferCity(s, await current()));
  assert.deepEqual(await inferCity(s, await current(), { value: 'Dallas' }), { ok: false, reason: 'already_inferred' });
  assert.equal((await s.listEditionInferences('e1')).length, 1);
});

test('a parent must be an active inference on the same edition', async () => {
  const { s, current } = await setup();
  const parent = okInference(await inferCity(s, await current()));
  const child = { edition: await current(), field: 'region' as const, value: 'TX', reason: 'Austin is in Texas', rule: 'cityRegion', inputs: [], actor: 'system:test' };
  assert.deepEqual(await inferEditionField(s, { ...child, parents: ['no-such-id'] }), { ok: false, reason: 'bad_parent' });
  const other = ed({ id: 'e2', key: 's/2027', year: 2027 });
  const foreign = okInference(await inferEditionField(s, { ...child, edition: other, field: 'city', value: 'Waco', parents: [] }));
  assert.deepEqual(await inferEditionField(s, { ...child, parents: [foreign.id] }), { ok: false, reason: 'bad_parent' });
  const rejected = await rejectInference(s, parent.id, 'e1', 'owner:1', 'not that city');
  assert.equal(rejected.ok, true);
  assert.deepEqual(await inferEditionField(s, { ...child, parents: [parent.id] }), { ok: false, reason: 'bad_parent' });
});

test('a child inference links its parent in parents and inputs', async () => {
  const { s, current } = await setup();
  const parent = okInference(await inferCity(s, await current()));
  const child = okInference(await inferEditionField(s, {
    edition: await current(), field: 'region', value: 'TX', reason: 'Austin is in Texas', rule: 'cityRegion',
    inputs: [{ kind: 'source', url: 'https://example.test/v', quote: 'Austin, TX' }], parents: [parent.id], actor: 'system:test',
  }));
  assert.deepEqual(child.parents, [parent.id]);
  assert.ok(child.inputs.some((i) => i.kind === 'source'));
  assert.ok(child.inputs.some((i) => i.kind === 'inference' && i.id === parent.id));
});

test('a typed value that matches confirms the inference', async () => {
  const { s, current } = await setup();
  const inf = okInference(await inferCity(s, await current()));
  await writeEdition(s, { edition: ed({ city: ' austin ' }), actor: 'owner:1', reason: 'typed' });
  const rows = await s.listEditionInferences('e1');
  assert.equal(rows.find((r) => r.id === inf.id)!.status, 'confirmed');
});

test('a confirmed inference keeps what was built on it active', async () => {
  const { s, current } = await setup();
  const a = okInference(await inferCity(s, await current()));
  const b = okInference(await inferEditionField(s, {
    edition: await current(), field: 'region', value: 'TX', reason: 'Austin is in Texas', rule: 'cityRegion', inputs: [], parents: [a.id], actor: 'system:test',
  }));
  await writeEdition(s, { edition: ed({ city: 'Austin' }), actor: 'owner:1', reason: 'typed' });
  const rows = await s.listEditionInferences('e1');
  assert.equal(rows.find((r) => r.id === a.id)!.status, 'confirmed');
  assert.equal(rows.find((r) => r.id === b.id)!.status, 'active');
});

test('a typed value that differs replaces the inference and every inference built on it', async () => {
  const { s, current } = await setup();
  const a = okInference(await inferCity(s, await current()));
  const b = okInference(await inferEditionField(s, {
    edition: await current(), field: 'region', value: 'TX', reason: 'Austin is in Texas', rule: 'cityRegion', inputs: [], parents: [a.id], actor: 'system:test',
  }));
  const c = okInference(await inferEditionField(s, {
    edition: await current(), field: 'country', value: 'US', reason: 'Texas is in the US', rule: 'regionCountry', inputs: [], parents: [b.id], actor: 'system:test',
  }));
  await writeEdition(s, { edition: ed({ city: 'Dallas' }), actor: 'owner:1', reason: 'typed' });
  const rows = await s.listEditionInferences('e1');
  const byId = (id: string) => rows.find((r) => r.id === id)!;
  assert.equal(byId(a.id).status, 'replaced');
  assert.equal(byId(a.id).resolvedReason, 'a verified or typed value arrived');
  assert.equal(byId(b.id).status, 'replaced');
  assert.equal(byId(b.id).resolvedReason, 'its input was replaced');
  assert.equal(byId(c.id).status, 'replaced');
  assert.equal(byId(c.id).resolvedReason, 'its input was replaced');
});

test('healEdition leaves inferences alone when the field is still empty', async () => {
  const { s, current } = await setup();
  const inf = okInference(await inferCity(s, await current()));
  const resolved = await healEdition(s, 'e1', await current(), 'system:test');
  assert.deepEqual(resolved, []);
  assert.equal((await s.listEditionInferences('e1')).find((r) => r.id === inf.id)!.status, 'active');
});

test('undo of an inference rejects it and replaces what was built on it', async () => {
  const { s, current } = await setup();
  const a = okInference(await inferCity(s, await current()));
  const b = okInference(await inferEditionField(s, {
    edition: await current(), field: 'region', value: 'TX', reason: 'Austin is in Texas', rule: 'cityRegion', inputs: [], parents: [a.id], actor: 'system:test',
  }));
  const change = (await s.listEditionChanges('e1')).find((c) => c.after?.inferenceAdded === a.id)!;
  const u = await undoEditionChange(s, 'e1', change.id, 'owner:1');
  assert.equal(u.ok, true);
  const rows = await s.listEditionInferences('e1');
  assert.equal(rows.find((r) => r.id === a.id)!.status, 'rejected');
  assert.equal(rows.find((r) => r.id === b.id)!.status, 'replaced');
  assert.equal(rows.find((r) => r.id === b.id)!.resolvedReason, 'its input was rejected');
  assert.equal((await current()).city, undefined);
  assert.ok((await s.listEditionChanges('e1')).find((c) => c.id === change.id)!.undoneAt);
  assert.deepEqual(await undoEditionChange(s, 'e1', change.id, 'owner:1'), { ok: false, reason: 'already_undone' });
});

test('undo of an inference that a typed value already replaced is stale', async () => {
  const { s, current } = await setup();
  const a = okInference(await inferCity(s, await current()));
  await writeEdition(s, { edition: ed({ city: 'Dallas' }), actor: 'owner:1', reason: 'typed' });
  const change = (await s.listEditionChanges('e1')).find((c) => c.after?.inferenceAdded === a.id)!;
  assert.deepEqual(await undoEditionChange(s, 'e1', change.id, 'owner:1'), { ok: false, reason: 'stale' });
});

test('shownValue prefers the edition value, then the active inference, then nothing', async () => {
  const { s, current } = await setup();
  const a = okInference(await inferCity(s, await current()));
  const inferences = await s.listEditionInferences('e1');
  assert.deepEqual(shownValue(await current(), 'city', inferences), { value: 'Austin', inferred: true, reason: 'the venue is in Austin', inferenceId: a.id });
  assert.equal(shownValue(await current(), 'region', inferences), null);
  assert.deepEqual(shownValue(ed({ city: 'Dallas' }), 'city', inferences), { value: 'Dallas', inferred: false });
  const rejected = inferences.map((r) => ({ ...r, status: 'rejected' as const }));
  assert.equal(shownValue(await current(), 'city', rejected), null);
});

test('a store whose inference lookup throws does not break a save', async () => {
  const { s } = await setup();
  const broken = new Proxy(s, {
    get(target, prop) {
      if (prop === 'listEditionInferences') return async () => { throw new Error('table missing'); };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as LineupStore;
  const r = await writeEdition(broken, { edition: ed({ city: 'Austin' }), actor: 'owner:1', reason: 'typed' });
  assert.equal(r.changed, true);
  assert.equal((await s.getEdition('e1'))!.city, 'Austin');
});
