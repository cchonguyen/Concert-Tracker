import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkedLabel, checkRows } from '../src/services/checkDetails.ts';
import type { DetailCandidate } from '../src/server/events/types.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-29T12:00:00Z');
const on = () => true;
const cand = (...types: string[]): DetailCandidate =>
  ({ id: 'c', name: 'x', sources: types.map((t) => ({ sourceType: t, sourceUrl: 'https://e.test', fields: [] })) }) as unknown as DetailCandidate;

test('every row says checking while a check runs', () => {
  const rows = checkRows({ busy: true, status: 'none', candidates: [], enabled: on });
  assert.deepEqual(rows.map((r) => r.state), ['checking', 'checking', 'checking']);
});

test('a found row needs a candidate from that source; the others say no listing', () => {
  const rows = checkRows({ busy: false, checkedAt: NOW.toString(), status: 'choose', candidates: [cand('ticketmaster')], enabled: on });
  assert.deepEqual(rows.map((r) => [r.label, r.state]), [
    ['Ticketmaster', 'found'],
    ['setlist.fm', 'none'],
    ['Clashfinder', 'none'],
  ]);
});

test('a source switched off says not set up, whatever the reply', () => {
  const rows = checkRows({ busy: false, checkedAt: 'x', status: 'none', candidates: [], enabled: (t) => t !== 'clashfinder' });
  assert.equal(rows[2].state, 'off');
  assert.equal(rows[0].state, 'none');
});

test('no rows before a check, or when the check needed a date first', () => {
  assert.deepEqual(checkRows({ busy: false, status: 'none', candidates: [], enabled: on }), []);
  assert.deepEqual(checkRows({ busy: false, checkedAt: 'x', status: 'needs_date', candidates: [], enabled: on }), []);
});

test('the last check reads in days', () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString();
  assert.equal(checkedLabel(undefined, NOW), null);
  assert.equal(checkedLabel('not a date', NOW), null);
  assert.equal(checkedLabel(at(3 * 3600_000), NOW), 'Checked today');
  assert.equal(checkedLabel(at(DAY), NOW), 'Checked 1 day ago');
  assert.equal(checkedLabel(at(3 * DAY), NOW), 'Checked 3 days ago');
});
