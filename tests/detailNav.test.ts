import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventParam, neighbours, nextWithGap, withEventParam } from '../src/services/detailNav.ts';

const IDS = ['a', 'b', 'c', 'd', 'e'];

test('neighbours give the rows above and below, and nothing past either end', () => {
  assert.deepEqual(neighbours(IDS, 'c'), { prev: 'b', next: 'd' });
  assert.deepEqual(neighbours(IDS, 'a'), { prev: null, next: 'b' });
  assert.deepEqual(neighbours(IDS, 'e'), { prev: 'd', next: null });
});

test('an event not in the list has no neighbours', () => {
  assert.deepEqual(neighbours(IDS, 'zz'), { prev: null, next: null });
  assert.deepEqual(neighbours([], 'a'), { prev: null, next: null });
});

test('next with gaps is the first event below the open one that has one', () => {
  const gappy = new Set(['b', 'd']);
  assert.equal(nextWithGap(IDS, 'a', (id) => gappy.has(id)), 'b');
  assert.equal(nextWithGap(IDS, 'b', (id) => gappy.has(id)), 'd');
});

test('next with gaps never looks above, and returns null when nothing below has a gap', () => {
  const gappy = new Set(['a']);
  assert.equal(nextWithGap(IDS, 'c', (id) => gappy.has(id)), null);
  assert.equal(nextWithGap(IDS, 'zz', () => true), null);
});

test('the event parameter is read from the address, and empty means none', () => {
  assert.equal(eventParam('?view=table&event=abc'), 'abc');
  assert.equal(eventParam('?view=table'), null);
  assert.equal(eventParam('?event='), null);
  assert.equal(eventParam(''), null);
});

test('setting the event parameter keeps the other parameters', () => {
  assert.equal(withEventParam('?view=table&sort=date', 'abc'), '?view=table&sort=date&event=abc');
  assert.equal(withEventParam('?view=table&event=old', 'new'), '?view=table&event=new');
});

test('clearing the event parameter removes it and leaves the rest', () => {
  assert.equal(withEventParam('?view=table&event=abc', null), '?view=table');
  assert.equal(withEventParam('?event=abc', null), '');
  assert.equal(withEventParam('', null), '');
});
