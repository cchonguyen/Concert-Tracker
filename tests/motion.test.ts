import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { prefersReducedMotion, scrollBehavior } from '../src/services/motion.ts';

const media = (reduce: boolean) => (q: string) => ({ matches: reduce && q === '(prefers-reduced-motion: reduce)' });

test('scrolling jumps instead of gliding when reduced motion is on', () => {
  assert.equal(scrollBehavior(media(true)), 'auto');
  assert.equal(scrollBehavior(media(false)), 'smooth');
});

test('without a browser, motion counts as allowed', () => {
  assert.equal(prefersReducedMotion(undefined), false);
});

test('index.css stops animations and transitions under reduced motion', () => {
  const css = readFileSync(path.join(import.meta.dirname, '..', 'src', 'index.css'), 'utf8');
  const rule = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  for (const prop of ['animation-duration', 'animation-iteration-count', 'transition-duration', 'scroll-behavior']) {
    assert.ok(rule.includes(prop), `missing ${prop}`);
  }
});

test('no component asks for a smooth scroll directly', () => {
  const root = path.join(import.meta.dirname, '..', 'src', 'components');
  const files = ['ui/BackToTop.tsx', 'timeline/AgendaView.tsx', 'ArtistsView.tsx', 'EventDetail.tsx'];
  for (const f of files) assert.ok(!readFileSync(path.join(root, f), 'utf8').includes("behavior: 'smooth'"), f);
});
