import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRowId } from '../src/components/TableView.tsx';

const EVENTS = [
  { id: 'ev-1' },
  { id: 'ev-2' },
  { id: 'ev-3' },
  { id: 'ev-4' },
];

test('nextRowId returns next event id on ArrowDown', () => {
  assert.equal(nextRowId(EVENTS, 'ev-1', 'ArrowDown'), 'ev-2');
  assert.equal(nextRowId(EVENTS, 'ev-2', 'ArrowDown'), 'ev-3');
  assert.equal(nextRowId(EVENTS, 'ev-3', 'ArrowDown'), 'ev-4');
});

test('nextRowId clamps at end on ArrowDown', () => {
  assert.equal(nextRowId(EVENTS, 'ev-4', 'ArrowDown'), 'ev-4');
});

test('nextRowId returns previous event id on ArrowUp', () => {
  assert.equal(nextRowId(EVENTS, 'ev-4', 'ArrowUp'), 'ev-3');
  assert.equal(nextRowId(EVENTS, 'ev-3', 'ArrowUp'), 'ev-2');
  assert.equal(nextRowId(EVENTS, 'ev-2', 'ArrowUp'), 'ev-1');
});

test('nextRowId clamps at 0 on ArrowUp', () => {
  assert.equal(nextRowId(EVENTS, 'ev-1', 'ArrowUp'), 'ev-1');
});

test('nextRowId returns first event id on Home', () => {
  assert.equal(nextRowId(EVENTS, 'ev-3', 'Home'), 'ev-1');
  assert.equal(nextRowId(EVENTS, 'ev-4', 'Home'), 'ev-1');
  assert.equal(nextRowId(EVENTS, 'ev-1', 'Home'), 'ev-1');
});

test('nextRowId returns last event id on End', () => {
  assert.equal(nextRowId(EVENTS, 'ev-1', 'End'), 'ev-4');
  assert.equal(nextRowId(EVENTS, 'ev-2', 'End'), 'ev-4');
  assert.equal(nextRowId(EVENTS, 'ev-4', 'End'), 'ev-4');
});

test('nextRowId returns null for empty events array', () => {
  assert.equal(nextRowId([], 'ev-1', 'ArrowDown'), null);
  assert.equal(nextRowId([], 'ev-1', 'ArrowUp'), null);
  assert.equal(nextRowId([], 'ev-1', 'Home'), null);
  assert.equal(nextRowId([], 'ev-1', 'End'), null);
});

test('nextRowId returns null if currentId is not found', () => {
  assert.equal(nextRowId(EVENTS, 'not-exist', 'ArrowDown'), null);
  assert.equal(nextRowId(EVENTS, 'not-exist', 'ArrowUp'), null);
  assert.equal(nextRowId(EVENTS, 'not-exist', 'Home'), null);
  assert.equal(nextRowId(EVENTS, 'not-exist', 'End'), null);
});

test('nextRowId handles single event list', () => {
  const single = [{ id: 'only-one' }];
  assert.equal(nextRowId(single, 'only-one', 'ArrowDown'), 'only-one');
  assert.equal(nextRowId(single, 'only-one', 'ArrowUp'), 'only-one');
  assert.equal(nextRowId(single, 'only-one', 'Home'), 'only-one');
  assert.equal(nextRowId(single, 'only-one', 'End'), 'only-one');
});
