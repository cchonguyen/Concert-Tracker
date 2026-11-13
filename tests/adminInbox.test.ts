import assert from 'node:assert/strict';
import test from 'node:test';
import { change, editionLine, groupByKind, mergeChoices, traceSummary } from '../src/services/adminInbox.ts';
import type { InboxItem, InboxTrace } from '../src/services/lineupApi.ts';

const item = (id: string, kind: InboxItem['kind'], createdAt: string, payload: Record<string, unknown> = {}, status = 'open'): InboxItem =>
  ({ id, kind, status, editionId: 'e1', payload, createdAt, edition: null });

test('groupByKind orders kinds, sorts newest first, drops closed and empty groups', () => {
  const g = groupByKind([
    item('a', 'provisional', '2026-01-01'),
    item('b', 'override', '2026-01-01'),
    item('c', 'override', '2026-02-01'),
    item('d', 'override', '2026-03-01', {}, 'dismissed'),
  ]);
  assert.deepEqual(g.map((x) => x.kind), ['override', 'provisional']);
  assert.deepEqual(g[0].items.map((i) => i.id), ['c', 'b']);
});

test('change and editionLine speak plainly and show blanks as blank', () => {
  assert.deepEqual(change(item('a', 'override', 'x', { field: 'venue', old: null, new: 'New Park' })), { field: 'Venue', oldValue: 'blank', newValue: 'New Park' });
  assert.equal(change(item('a', 'provisional', 'x')), null);
  assert.equal(editionLine(null), 'An edition that no longer exists');
  assert.equal(editionLine({ id: 'e', name: 'Fest', startDate: '2026-07-01', endDate: '2026-07-03', venue: null, city: null, country: null, status: 'x' }), 'Fest · 2026-07-01 to 2026-07-03 · no venue');
});

test('mergeChoices de-duplicates ids', () => {
  assert.deepEqual(mergeChoices(item('a', 'merge_suggestion', 'x', { editionIds: ['e1', 'e2'] })), ['e1', 'e2']);
});

test('traceSummary counts steps and requests', () => {
  const t: InboxTrace = { id: 't', trigger: 'save', eventId: 'ev', editionId: null, steps: [{ name: 'a', at: 1 }, { name: 'b', at: 2 }], subrequests: 1, createdAt: 'x' };
  assert.deepEqual(traceSummary(t), { title: 'Event saved', target: 'an event', steps: '2 steps: a, b', requests: '1 request' });
  assert.equal(traceSummary({ ...t, steps: [], subrequests: null }).requests, 'Requests not counted');
});
