// Every text and fill pair in the design refresh tokens must reach 4.5:1 in all
// 10 themes (5 accents x dark and light). The test reads src/index.css itself,
// so a token edit that drops a pair under AA fails the build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ACCENTS, type Accent } from '../src/services/theme.ts';

const css = readFileSync(path.join(import.meta.dirname, '..', 'src', 'index.css'), 'utf8');

type Rgb = [number, number, number]; // linear-light sRGB, 0..1
type Decls = Record<string, string>;

// The declarations of the first rule whose selector matches exactly and which declares `mustHave`.
function block(selector: string, mustHave: string): Decls {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(';').pop()!.trim().replace(/\s+/g, ' ');
    if (sel !== selector || !m[2].includes(mustHave)) continue;
    const out: Decls = {};
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
    return out;
  }
  throw new Error(`No rule "${selector}" declaring ${mustHave} in src/index.css`);
}

const accentScale = (a: Accent): Decls =>
  a === 'violet' ? block(":root, [data-accent='violet']", '--accent-500') : block(`[data-accent='${a}']`, '--accent-500');

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const clamp = (v: number) => Math.min(1, Math.max(0, v));

function hex(h: string): Rgb {
  const s = h.replace('#', '');
  const full = s.length === 3 ? [...s].map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => toLinear(parseInt(full.slice(i, i + 2), 16) / 255)) as Rgb;
}

// OKLab <-> linear sRGB (Björn Ottosson's matrices).
function oklabToRgb([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}
function rgbToOklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function resolve(value: string, vars: Decls, depth = 0): Rgb {
  if (depth > 10) throw new Error(`Token loop at ${value}`);
  const v = value.trim();
  if (v.startsWith('#')) return hex(v);
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) {
    const next = vars[ref[1]];
    if (!next) throw new Error(`Unknown token ${ref[1]}`);
    return resolve(next, vars, depth + 1);
  }
  const ok = /^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+|none)\)$/.exec(v);
  if (ok) {
    const L = Number(ok[1]) / 100;
    const C = Number(ok[2]);
    const h = ok[3] === 'none' ? 0 : (Number(ok[3]) * Math.PI) / 180;
    return oklabToRgb([L, C * Math.cos(h), C * Math.sin(h)]);
  }
  const mix = /^color-mix\(in oklab,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/.exec(v);
  if (mix) {
    const p = Number(mix[2]) / 100;
    const a = rgbToOklab(resolve(mix[1], vars, depth + 1));
    const b = rgbToOklab(resolve(mix[3], vars, depth + 1));
    return oklabToRgb([0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p)) as Rgb);
  }
  throw new Error(`Token value the contrast test cannot read: ${v}`);
}

const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const dark = block(':root', '--la-page');
const light = block(":root[data-theme='light']", '--la-page');
const deepFill = block(":root[data-theme='light'][data-accent='teal'], :root[data-theme='light'][data-accent='orange']", '--la-accent-fill');

function tokens(accent: Accent, mode: 'dark' | 'light'): Decls {
  const vars = { ...accentScale(accent), ...dark };
  if (mode === 'light') Object.assign(vars, light, accent === 'teal' || accent === 'orange' ? deepFill : {});
  return vars;
}

// [text token, background tokens it must read on]
const PAIRS: Array<[string, string[]]> = [
  ['--la-text', ['--la-page', '--la-surface-1', '--la-surface-2', '--la-surface-3', '--la-sunken', '--la-accent-tint', '--la-row-hover']],
  ['--la-text-muted', ['--la-page', '--la-surface-1', '--la-surface-2', '--la-surface-3', '--la-sunken', '--la-accent-tint', '--la-row-hover']],
  // Faint text is not paired with --la-row-hover: a hovered row lifts it to muted (index.css, `.row-hover`).
  ['--la-text-faint', ['--la-page', '--la-surface-1', '--la-surface-2', '--la-sunken']],
  ['--la-accent', ['--la-page', '--la-surface-1', '--la-surface-2', '--la-surface-3', '--la-accent-tint', '--la-row-hover']],
  ['--la-on-accent', ['--la-accent-fill']],
  ['--la-good', ['--la-page', '--la-surface-1', '--la-surface-2']],
  ['--la-warn', ['--la-page', '--la-surface-1', '--la-surface-2']],
  ['--la-bad', ['--la-page', '--la-surface-1', '--la-surface-2']],
];

test('the contrast check itself: white on black is 21:1 and the accent scales parse', () => {
  assert.equal(Math.round(contrast(hex('#ffffff'), hex('#000000'))), 21);
  for (const a of ACCENTS) assert.ok(accentScale(a)['--accent-400'], a);
});

for (const mode of ['dark', 'light'] as const) {
  for (const accent of ACCENTS) {
    test(`${mode} ${accent}: every text and fill pair reaches 4.5:1`, () => {
      const vars = tokens(accent, mode);
      const fails: string[] = [];
      for (const [fg, bgs] of PAIRS) {
        for (const bg of bgs) {
          const ratio = contrast(resolve(`var(${fg})`, vars), resolve(`var(${bg})`, vars));
          if (ratio < 4.5) fails.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
        }
      }
      assert.deepEqual(fails, []);
    });
  }
}

test('the phone bar uses the page color in both modes', async () => {
  const { BAR_COLORS } = await import('../src/services/theme.ts');
  assert.equal(BAR_COLORS.dark, dark['--la-page']);
  assert.equal(BAR_COLORS.light, light['--la-page']);
});
