import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Edition, EditionInference, EditionPerformance } from '../src/server/lineup/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { undoEditionChange, writeEdition } from '../src/server/canon/editions.ts';
import { inferredFieldsFor } from '../src/server/canon/inferences.ts';
import { billingInferencesFor, BILLING_INFER_RULE, inferBillingRoles, inferredBillingFor } from '../src/server/canon/inferredBilling.ts';
import type { LoggedEvent } from '../src/server/events/types.ts';

const fresh = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'billing-')));

const act = (name: string, over: Partial<EditionPerformance> = {}): EditionPerformance => ({
  artistKey: name.toLowerCase().replace(/\s+/g, '-'),
  name,
  days: [],
  stages: [],
  status: 'billed',
  confidence: 1,
  sources: [{ sourceType: 'promoter', url: 'https://example.test/lineup', quote: name } as unknown as EditionPerformance['sources'][number]],
  ...over,
} as EditionPerformance);

const concert = (over: Partial<Edition> = {}): Edition => ({
  id: 'e1',
  key: 's/2026',
  seriesSlug: 's',
  year: 2026,
  name: 'Radiohead',
  status: 'provisional',
  startDate: '2026-06-01',
  endDate: '2026-06-01',
  updatedAt: '2026-01-01T00:00:00.000Z',
  performances: [act('Radiohead'), act('Foo Fighters'), act('Bar Band')],
  ...over,
} as Edition);

async function setup(edition: Edition = concert()) {
  const s = await fresh();
  await writeEdition(s, { edition, actor: 'system:test', reason: 'created' });
  const current = async () => (await s.getEdition('e1'))!;
  return { s, current };
}

const byField = (rows: EditionInference[], subject: string) => rows.find((r) => r.field === 'billing' && r.subject === subject)!;

test('a concert named after one act infers that act as headliner and the others as support', () => {
  const out = billingInferencesFor(concert());
  assert.deepEqual(out.map((x) => [x.subject, x.role]), [['radiohead', 'headliner'], ['foo-fighters', 'support'], ['bar-band', 'support']]);
  assert.equal(out[0].reason, 'The event is named after Radiohead and the lineup lists 2 other act(s).');
});

test('a festival infers nothing: several days, too many acts, Clashfinder, or a festival series', () => {
  assert.deepEqual(billingInferencesFor(concert({ endDate: '2026-06-03' })), []);
  const six = [act('Radiohead'), ...['A', 'B', 'C', 'D', 'E'].map((n) => act(n))];
  assert.deepEqual(billingInferencesFor(concert({ performances: six })), []);
  const clash = concert({ performances: [act('Radiohead'), act('Foo', { sources: [{ sourceType: 'clashfinder' } as unknown as EditionPerformance['sources'][number]] })] });
  assert.deepEqual(billingInferencesFor(clash), []);
  assert.deepEqual(billingInferencesFor(concert({ seriesKind: 'festival' })), []);
});

test('nothing is inferred when the name matches no act, or two acts', () => {
  assert.deepEqual(billingInferencesFor(concert({ name: 'Summer Nights' })), []);
  assert.deepEqual(billingInferencesFor(concert({ performances: [act('Radiohead'), act('Radiohead', { artistKey: 'radiohead-2' }), act('Foo')] })), []);
});

test('nothing is inferred when any act has a stated billing, or the named act is cancelled', () => {
  assert.deepEqual(billingInferencesFor(concert({ performances: [act('Radiohead', { billing: 'support' }), act('Foo')] })), []);
  assert.deepEqual(billingInferencesFor(concert({ performances: [act('Radiohead'), act('Foo', { billing: 'headliner' })] })), []);
  assert.deepEqual(billingInferencesFor(concert({ performances: [act('Radiohead', { status: 'cancelled' }), act('Foo')] })), []);
});

test('a cancelled act does not count toward the two acts', () => {
  assert.deepEqual(billingInferencesFor(concert({ performances: [act('Radiohead'), act('Foo', { status: 'cancelled' })] })), []);
});

test('inferBillingRoles stores one row per act with its subject and records each in edition_changes', async () => {
  const { s, current } = await setup();
  const r = await inferBillingRoles(s, await current());
  assert.equal(r.added.length, 3);
  assert.deepEqual(r.resolved, []);
  const rows = await s.listEditionInferences('e1');
  assert.equal(rows.length, 3);
  assert.equal(byField(rows, 'radiohead').value, 'headliner');
  assert.equal(byField(rows, 'foo-fighters').value, 'support');
  assert.equal(byField(rows, 'radiohead').rule, BILLING_INFER_RULE);
  assert.equal(byField(rows, 'radiohead').actor, 'system:billing-infer');
  assert.deepEqual(byField(rows, 'radiohead').inputs, [{ kind: 'record', table: 'event_editions', id: 'e1' }]);
  const changes = await s.listEditionChanges('e1');
  for (const row of rows) {
    const change = changes.find((c) => c.after?.inferenceAdded === row.id);
    assert.ok(change, 'a change row names each billing inference');
    assert.equal(change!.after!.field, 'billing');
    assert.equal(change!.after!.subject, row.subject);
    assert.equal(change!.after!.value, row.value);
  }
  assert.equal((await current()).performances[0].billing, undefined, 'the performance itself is not changed');
});

test('running it twice does not duplicate the inferences', async () => {
  const { s, current } = await setup();
  await inferBillingRoles(s, await current());
  const again = await inferBillingRoles(s, await current());
  assert.deepEqual(again.added, []);
  assert.equal((await s.listEditionInferences('e1')).length, 3);
});

test('a stated billing that matches confirms the inference, one that differs replaces it, and the rest are replaced', async () => {
  const { s, current } = await setup();
  await inferBillingRoles(s, await current());
  await writeEdition(s, {
    edition: concert({ performances: [act('Radiohead', { billing: 'headliner' }), act('Foo Fighters'), act('Bar Band')] }),
    actor: 'owner:1',
    reason: 'typed',
  });
  const r = await inferBillingRoles(s, await current());
  const rows = await s.listEditionInferences('e1');
  assert.equal(byField(rows, 'radiohead').status, 'confirmed');
  assert.equal(byField(rows, 'foo-fighters').status, 'replaced');
  assert.equal(byField(rows, 'foo-fighters').resolvedReason, 'the lineup no longer fits the rule');
  assert.equal(r.resolved.length, 3, 'the confirmed one and the two that no longer fit the rule');
  assert.deepEqual(r.added, []);
});

test('a stated billing on the inferred act that differs replaces that inference', async () => {
  const { s, current } = await setup();
  await inferBillingRoles(s, await current());
  await writeEdition(s, {
    edition: concert({ performances: [act('Radiohead', { billing: 'support' }), act('Foo Fighters'), act('Bar Band')] }),
    actor: 'owner:1',
    reason: 'typed',
  });
  await inferBillingRoles(s, await current());
  const rows = await s.listEditionInferences('e1');
  assert.equal(byField(rows, 'radiohead').status, 'replaced');
  assert.equal(byField(rows, 'radiohead').resolvedReason, 'a stated billing arrived');
});

test('an act that leaves the lineup replaces its inference', async () => {
  const { s, current } = await setup();
  await inferBillingRoles(s, await current());
  await writeEdition(s, {
    edition: concert({ performances: [act('Radiohead', { status: 'cancelled' }), act('Foo Fighters'), act('Bar Band')] }),
    actor: 'owner:1',
    reason: 'typed',
  });
  await inferBillingRoles(s, await current());
  assert.equal(byField(await s.listEditionInferences('e1'), 'radiohead').resolvedReason, 'the act is no longer on the lineup');
});

test('undo of a billing inference rejects it, and a later run does not argue it back', async () => {
  const { s, current } = await setup();
  await inferBillingRoles(s, await current());
  const rows = await s.listEditionInferences('e1');
  const change = (await s.listEditionChanges('e1')).find((c) => c.after?.inferenceAdded === byField(rows, 'radiohead').id)!;
  const u = await undoEditionChange(s, 'e1', change.id, 'owner:1');
  assert.equal(u.ok, true);
  assert.equal(byField(await s.listEditionInferences('e1'), 'radiohead').status, 'rejected');
  const again = await inferBillingRoles(s, await current());
  assert.deepEqual(again.added, []);
});

test('inferredFieldsFor ignores billing rows and never offers billing on an event', () => {
  const billing: EditionInference = {
    id: 'b1', editionId: 'e1', field: 'billing', subject: 'radiohead', value: 'headliner', reason: 'The event is named after Radiohead and the lineup lists 2 other act(s).',
    rule: BILLING_INFER_RULE, inputs: [], parents: [], status: 'active', actor: 'system:billing-infer', createdAt: '2026-01-01T00:00:00.000Z',
  };
  const event = { id: 'ev1', input: 'Radiohead', sources: {}, details: {}, seen: [] } as unknown as LoggedEvent;
  assert.deepEqual(inferredFieldsFor(event, [billing]), {});
  assert.equal('billing' in inferredFieldsFor(event, [billing]), false);
});

test('inferredBillingFor lists only active billing rows by act', () => {
  const row = (over: Partial<EditionInference>): EditionInference => ({
    id: 'b', editionId: 'e1', field: 'billing', subject: 'radiohead', value: 'headliner', reason: 'named after', rule: BILLING_INFER_RULE,
    inputs: [], parents: [], status: 'active', actor: 'system:billing-infer', createdAt: '2026-01-01T00:00:00.000Z', ...over,
  });
  const out = inferredBillingFor([row({ id: 'b1' }), row({ id: 'b2', subject: 'foo', value: 'support', status: 'replaced' }), row({ id: 'b3', subject: 'bar', value: 'support' })]);
  assert.deepEqual(out, {
    radiohead: { role: 'headliner', reason: 'named after', inferenceId: 'b1' },
    bar: { role: 'support', reason: 'named after', inferenceId: 'b3' },
  });
});
