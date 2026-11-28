import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCENTS } from '../src/services/theme.ts';
import { isPublicPath } from '../src/server/site/publicPaths.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const css = read('src/styles/landing-look.css');

test('every accent has a second colour in dark and light', () => {
  for (const a of ACCENTS) {
    if (a === 'violet') continue; // the default, set on :root
    assert.match(css, new RegExp(`^\\[data-accent='${a}'\\] \\{ --la-second:`, 'm'), `dark ${a}`);
    assert.match(css, new RegExp(`:root\\[data-theme='light'\\]\\[data-accent='${a}'\\] \\{ --la-second:`), `light ${a}`);
  }
});

test('teal second colour differs from violet in both dark and light', () => {
  const darkViolet = css.match(/:root\s*\{[^}]*--la-second:\s*([^;]+);/)?.[1]?.trim();
  const darkTeal = css.match(/\[data-accent='teal'\]\s*\{\s*--la-second:\s*([^;]+);/)?.[1]?.trim();
  const lightViolet = css.match(/:root\[data-theme='light'\]\s*\{[^}]*--la-second:\s*([^;]+);/)?.[1]?.trim();
  const lightTeal = css.match(/:root\[data-theme='light'\]\[data-accent='teal'\]\s*\{\s*--la-second:\s*([^;]+);/)?.[1]?.trim();
  assert.ok(darkViolet && darkTeal && darkViolet !== darkTeal, 'dark teal second differs from violet');
  assert.ok(lightViolet && lightTeal && lightViolet !== lightTeal, 'light teal second differs from violet');
});

test('every movement in the module stops under reduced motion', () => {
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  for (const cls of [
    '.app-backdrop',
    '.app-backdrop-contour-rot',
    '.app-backdrop-contour',
    '.app-backdrop-dots',
    '.btn-pop',
    '.postit',
    '.postit-icon',
  ]) assert.ok(reduced.includes(cls), cls);
});

test('AppBackdrop pairs the rotating/drifting contour with the sliding dot grid', () => {
  assert.match(css, /--la-backdrop-opacity:\s*0\.05;/);
  assert.match(css, /--la-backdrop-dot-opacity:\s*0\.1;/);
  assert.match(css, /animation:\s*la-backdrop-spin 400s linear infinite;/);
  assert.match(css, /animation:\s*la-drift 50s ease-in-out infinite alternate;/);
  assert.match(css, /background-size:\s*10px 10px;/);
  assert.match(css, /animation:\s*la-dot-slide 14s linear infinite;/);
  const backdropTsx = read('src/components/ui/AppBackdrop.tsx');
  assert.match(backdropTsx, /app-backdrop-contour-rot/);
  assert.match(backdropTsx, /app-backdrop-contour/);
  assert.match(backdropTsx, /app-backdrop-dots/);
});

test('the heartbeat logo is public, animated, and uses primary accent tokens', () => {
  const svg = read('public/logo-heartbeat.svg');
  assert.match(svg, /<animate /);
  assert.ok(!svg.includes('<metadata>'), 'no embedded metadata');
  assert.ok(isPublicPath('/logo-heartbeat.svg'));
  const logoTsx = read('src/components/ui/Logo.tsx');
  assert.match(logoTsx, /var\(--la-accent\)/);
  assert.match(logoTsx, /logo-animated/);
  assert.match(logoTsx, /logo-still/);
});

test('index.css loads the module and exposes its tokens', () => {
  const index = read('src/index.css');
  assert.match(index, /@import "\.\/styles\/landing-look\.css";/);
  assert.match(index, /--font-poster:/);
  assert.match(index, /--color-second: var\(--la-second\);/);
});
