import test from 'node:test';
import assert from 'node:assert/strict';
import { showBackToTop } from '../src/components/ui/BackToTop.tsx';

test('back to top: hidden until the page has scrolled past one screen', () => {
  assert.equal(showBackToTop(0, 800), false);
  assert.equal(showBackToTop(800, 800), false);
  assert.equal(showBackToTop(801, 800), true);
});
