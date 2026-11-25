import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Edition, EditionInference } from '../src/server/lineup/types.ts';
import type { LineupStore } from '../src/server/lineup/store/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { undoEditionChange, writeEdition } from '../src/server/canon/editions.ts';
import { inferEditionField } from '../src/server/canon/inferences.ts';
import {
  confirmInference,
  inferenceStanding,
  MEMBER_VERIFY_ACTOR,
  rejectReviewedInference,
  voteInference,
} from '../src/server/canon/inferenceReview.ts';

const fresh = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'infrev-')));
const ed = (over: Partial<Edition> = {}): Edition => ({
  id: 'e1', key: 's/2026', seriesSlug: 's', year: 2026, name: 'Fest', status: 'provisional', updatedAt: '2026-01-01T00:00:00.000Z', performances: [], ...over,
});

async function setup() {
  const s = await fresh();
  await writeEdition(s, { edition: ed(), actor: 'system:test', reason: 'created' });
  const current = async () => (await s.getEdition('e1'))!;
  return { s, current };
}

async function inferCity(s: LineupStore, value = 'Austin'): Promise<EditionInference> {
  const edition = (await s.getEdition('e1'))!;
  const r = await inferEditionField(s, {
    edition,
    field: 'city',
    value,
    reason: 'The venue is listed in Austin on the fetched page.',
    rule: 'test-rule',
    inputs: [{ kind: 'record', table: 'canonical_venues', id: 'venue:x' }],
    actor: 'system:test',
  });
  assert.ok(r.ok);
  return r.inference;
}

test('owner confirm writes the value into the edition field and confirms the inference', async () => {
  const { s, current } = await setup();
  const inf = await inferCity(s);
  const r = await confirmInference(s, inf.id, 'owner');
  assert.ok(r.ok);
  assert.equal((await current()).city, 'Austin');
  const row = (await s.listEditionInferences('e1')).find((i) => i.id === inf.id)!;
  assert.equal(row.status, 'confirmed');
  const changes = await s.listEditionChanges('e1');
  assert.ok(changes.some((c) => c.actor === 'owner' && c.reason === `confirmed inferred city: ${inf.reason}`));
});

test('confirm is refused for billing rows, non-active rows and filled fields', async () => {
  const { s, current } = await setup();
  const billing = await s.addEditionInference({
    editionId: 'e1', field: 'billing', subject: 'act-a', value: 'headliner', reason: 'Named after the act.', rule: 'billing-named-after-act',
    inputs: [], parents: [], actor: 'system:test',
  });
  assert.deepEqual(await confirmInference(s, billing.id, 'owner'), { ok: false, reason: 'billing_not_confirmable' });

  assert.deepEqual(await confirmInference(s, 'missing-id', 'owner'), { ok: false, reason: 'not_active' });

  const rejected = await inferCity(s);
  await rejectReviewedInference(s, rejected.id, 'owner');
  assert.deepEqual(await confirmInference(s, rejected.id, 'owner'), { ok: false, reason: 'not_active' });

  // A field that gained a value without healing (set straight on the row) refuses the confirm.
  const other = await inferEditionField(s, {
    edition: await current(), field: 'region', value: 'TX', reason: 'Austin is in Texas.', rule: 'test-rule',
    inputs: [{ kind: 'record', table: 'canonical_venues', id: 'venue:x' }], actor: 'system:test',
  });
  assert.ok(other.ok);
  await s.upsertEdition({ ...(await current()), region: 'CA', updatedAt: new Date().toISOString() });
  assert.deepEqual(await confirmInference(s, other.inference.id, 'owner'), { ok: false, reason: 'field_has_value' });
});

test('reject replaces what was built on the inference', async () => {
  const { s, current } = await setup();
  const parent = await inferCity(s);
  const child = await inferEditionField(s, {
    edition: await current(), field: 'region', value: 'TX', reason: 'Austin is in Texas.', rule: 'test-rule',
    inputs: [], parents: [parent.id], actor: 'system:test',
  });
  assert.ok(child.ok);
  const r = await rejectReviewedInference(s, parent.id, 'owner');
  assert.ok(r.ok);
  const rows = await s.listEditionInferences('e1');
  assert.equal(rows.find((i) => i.id === parent.id)?.status, 'rejected');
  assert.equal(rows.find((i) => i.id === child.inference.id)?.status, 'replaced');
  assert.equal((await current()).city, undefined);
});

test('one member vote leaves the field empty and the standing candidate', async () => {
  const { s, current } = await setup();
  const inf = await inferCity(s);
  const r = await voteInference(s, inf.id, 'member-1');
  assert.deepEqual(r, { ok: true, votes: 1, verified: false });
  assert.equal((await current()).city, undefined);
  const votes = await s.listInferenceVotes(inf.id);
  assert.equal(inferenceStanding(inf, votes), 'candidate');
  assert.equal(inferenceStanding(inf, []), 'inferred');
});

test('the same member twice counts once', async () => {
  const { s } = await setup();
  const inf = await inferCity(s);
  await voteInference(s, inf.id, 'member-1');
  const again = await voteInference(s, inf.id, 'member-1');
  assert.deepEqual(again, { ok: true, votes: 1, verified: false });
  assert.equal((await s.listInferenceVotes(inf.id)).length, 1);
});

test('two different members write the field as system:member-verify and confirm it', async () => {
  const { s, current } = await setup();
  const inf = await inferCity(s);
  await voteInference(s, inf.id, 'member-1');
  const r = await voteInference(s, inf.id, 'member-2');
  assert.deepEqual(r, { ok: true, votes: 2, verified: true });
  assert.equal((await current()).city, 'Austin');
  const row = (await s.listEditionInferences('e1')).find((i) => i.id === inf.id)!;
  assert.equal(row.status, 'confirmed');
  const change = (await s.listEditionChanges('e1')).find((c) => c.reason === 'two members verified inferred city');
  assert.ok(change);
  assert.equal(change.actor, MEMBER_VERIFY_ACTOR);
});

test('undo of the member-verify write restores the empty field', async () => {
  const { s, current } = await setup();
  const inf = await inferCity(s);
  await voteInference(s, inf.id, 'member-1');
  await voteInference(s, inf.id, 'member-2');
  const change = (await s.listEditionChanges('e1')).find((c) => c.reason === 'two members verified inferred city')!;
  const undone = await undoEditionChange(s, 'e1', change.id, 'owner');
  assert.equal(undone.ok, true);
  assert.equal((await current()).city, undefined);
  // The inference is back to active and both votes stay.
  assert.equal((await s.getEditionInference(inf.id))?.status, 'active');
  assert.equal((await s.listInferenceVotes(inf.id)).length, 2);
});

test('undo of an owner confirm sets the inference back to active', async () => {
  const { s, current } = await setup();
  const inf = await inferCity(s);
  assert.ok((await confirmInference(s, inf.id, 'owner')).ok);
  const change = (await s.listEditionChanges('e1')).find((c) => c.reason === `confirmed inferred city: ${inf.reason}`)!;
  const undone = await undoEditionChange(s, 'e1', change.id, 'owner');
  assert.equal(undone.ok, true);
  assert.equal((await current()).city, undefined);
  assert.equal((await s.getEditionInference(inf.id))?.status, 'active');
  // Back to active, so it can be confirmed again.
  assert.ok((await confirmInference(s, inf.id, 'owner')).ok);
});

test('getEditionInference returns any status by id and null when unknown', async () => {
  const { s } = await setup();
  const inf = await inferCity(s);
  assert.equal((await s.getEditionInference(inf.id))?.status, 'active');
  await rejectReviewedInference(s, inf.id, 'owner');
  assert.equal((await s.getEditionInference(inf.id))?.status, 'rejected');
  assert.equal(await s.getEditionInference('missing-id'), null);
});

test('votes on a rejected inference are refused', async () => {
  const { s } = await setup();
  const inf = await inferCity(s);
  await rejectReviewedInference(s, inf.id, 'owner');
  assert.deepEqual(await voteInference(s, inf.id, 'member-1'), { ok: false, reason: 'not_active' });
  assert.equal((await s.listInferenceVotes(inf.id)).length, 0);
});

test('billing rows cannot be voted on', async () => {
  const { s } = await setup();
  const billing = await s.addEditionInference({
    editionId: 'e1', field: 'billing', subject: 'act-a', value: 'headliner', reason: 'Named after the act.', rule: 'billing-named-after-act',
    inputs: [], parents: [], actor: 'system:test',
  });
  assert.deepEqual(await voteInference(s, billing.id, 'member-1', 'e1'), { ok: false, reason: 'billing_not_votable' });
});
