import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DetailCandidate } from '../src/server/events/types.ts';
import { buildPickerView, cityChips, monthChips, monthOf, NO_CITY_LABEL, NO_MONTH_LABEL } from '../src/services/pickerGroups.ts';

function cand(id: string, o: Partial<DetailCandidate> = {}): DetailCandidate {
  return { id, name: `Show ${id}`, sources: [{ sourceType: 'ticketmaster', sourceUrl: `https://x/${id}`, fields: [] }], ...o };
}

const many = [
  cand('a', { city: 'Austin', region: 'TX', startDate: '2026-03-05' }),
  cand('b', { city: 'Denver', startDate: '2026-03-20', venue: 'Red Rocks' }),
  cand('c', { startDate: '2026-01-02' }),
  cand('d', { city: 'austin', region: 'tx', startDate: '2026-05-01' }),
  cand('e', { city: 'Denver' }),
  cand('f', { startDate: '2026' }),
];

test('5 or fewer choices pass through unchanged', () => {
  const five = many.slice(0, 5);
  const v = buildPickerView(five, { city: 'denver', search: 'zzz' });
  assert.equal(v.grouped, false);
  assert.deepEqual(v.groups[0].items, five);
  assert.equal(v.cityChips.length, 0);
  assert.equal(v.monthChips.length, 0);
});

test('groups by city with a plain no-city group last', () => {
  const v = buildPickerView(many);
  assert.equal(v.grouped, true);
  assert.deepEqual(v.groups.map((g) => [g.label, g.items.length]), [['Austin, TX', 2], ['Denver', 2], [NO_CITY_LABEL, 2]]);
  assert.deepEqual(v.groups[2].items.map((c) => c.id), ['c', 'f']);
});

test('month chips come from the date only; undated and year-only go to the not-stated chip', () => {
  assert.equal(monthOf(many[4]), '');
  assert.equal(monthOf(many[5]), '');
  const chips = monthChips(many);
  assert.deepEqual(chips.map((c) => [c.label, c.count]), [['Jan 2026', 1], ['Mar 2026', 2], ['May 2026', 1], [NO_MONTH_LABEL, 2]]);
});

test('city chips count candidates', () => {
  assert.deepEqual(cityChips(many).map((c) => c.count), [2, 2, 2]);
});

test('city and month chips combine', () => {
  const v = buildPickerView(many, { city: 'denver', month: '2026-03' });
  assert.deepEqual(v.groups.flatMap((g) => g.items.map((c) => c.id)), ['b']);
  assert.equal(v.shown, 1);
  assert.equal(v.total, 6);
  assert.equal(v.cityChips.length, 3, 'chips stay whole while filtering');
});

test('no-month chip finds only undated or year-only', () => {
  const v = buildPickerView(many, { month: '' });
  assert.deepEqual(v.groups.flatMap((g) => g.items.map((c) => c.id)), ['e', 'f']);
});

test('search matches shown text, all words, any case', () => {
  assert.deepEqual(buildPickerView(many, { search: 'red rocks' }).groups.flatMap((g) => g.items.map((c) => c.id)), ['b']);
  assert.equal(buildPickerView(many, { search: 'show nothing' }).shown, 0);
  assert.deepEqual(buildPickerView(many, { search: 'SHOW', city: 'austin, tx' }).groups.flatMap((g) => g.items.map((c) => c.id)), ['a', 'd']);
});

test('search uses extra row text such as source names', () => {
  const v = buildPickerView(many, { search: 'setlist' }, (c) => (c.id === 'c' ? 'setlist.fm' : ''));
  assert.deepEqual(v.groups.flatMap((g) => g.items.map((c) => c.id)), ['c']);
});

test('order is stable within a group and across runs', () => {
  const a = buildPickerView(many, { search: 'show' });
  const b = buildPickerView([...many], { search: 'show' });
  assert.deepEqual(a, b);
  assert.deepEqual(a.groups[0].items.map((c) => c.id), ['a', 'd']);
});
