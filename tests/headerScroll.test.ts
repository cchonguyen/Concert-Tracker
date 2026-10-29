import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextHeaderScroll } from '../src/components/headerScroll.ts';

const START = { visible: true, lastY: 0 };

test('the bar always shows near the top of the page', () => {
  const hidden = { visible: false, lastY: 400 };
  assert.equal(nextHeaderScroll(hidden, 30, false).visible, true);
});

test('scrolling down past the top hides the bar', () => {
  const next = nextHeaderScroll(START, 300, false);
  assert.equal(next.visible, false);
  assert.equal(next.lastY, 300);
});

test('scrolling back up shows the bar again', () => {
  const hidden = { visible: false, lastY: 300 };
  assert.equal(nextHeaderScroll(hidden, 240, false).visible, true);
});

test('small jitters do not flip the bar', () => {
  const shown = { visible: true, lastY: 300 };
  assert.deepEqual(nextHeaderScroll(shown, 305, false), shown);
  const hidden = { visible: false, lastY: 300 };
  assert.deepEqual(nextHeaderScroll(hidden, 296, false), hidden);
});

test('an open menu keeps the bar shown while scrolling down', () => {
  assert.equal(nextHeaderScroll(START, 900, true).visible, true);
});
