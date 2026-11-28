// Guards against drift between src/components/ui/, src/services/theme.ts, app.html, and docs/design-system/design-system.json.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ACCENT_KEY, BAR_COLORS, MODE_KEY, STUB_STYLE_KEY } from '../src/services/theme.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

test('every component in src/components/ui/ is catalogued in design-system.json', () => {
  const ds = JSON.parse(read('docs/design-system/design-system.json')) as {
    components: Array<{ name: string }>;
    appSpecific: string[];
  };
  const catalogNames = new Set([
    ...ds.components.map((c) => c.name),
    ...ds.appSpecific.map((line) => line.split(/\s+/)[0]),
  ]);
  const uiFiles = readdirSync(path.join(root, 'src', 'components', 'ui'))
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => f.replace(/\.tsx$/, ''));

  const missing = uiFiles.filter((name) => !catalogNames.has(name));
  assert.deepEqual(missing, []);
});

test('BAR_COLORS in theme.ts, app.html, and design-system.json match', () => {
  const ds = JSON.parse(read('docs/design-system/design-system.json')) as {
    color: { browserBar: { dark: string; light: string } };
  };
  const appHtml = read('app.html');
  assert.deepEqual(ds.color.browserBar, BAR_COLORS);
  assert.ok(appHtml.includes(`content="${BAR_COLORS.dark}"`), 'app.html missing dark BAR_COLOR');
  assert.ok(appHtml.includes(`'${BAR_COLORS.light}'`), 'app.html missing light BAR_COLOR');
});

test('theme storage keys in theme.ts match app.html and design-system.json', () => {
  const ds = JSON.parse(read('docs/design-system/design-system.json')) as {
    themes: { storage: { modeKey: string; accentKey: string; stubStyleKey: string } };
  };
  const appHtml = read('app.html');
  for (const [label, key, dsKey] of [
    ['modeKey', MODE_KEY, ds.themes.storage.modeKey],
    ['accentKey', ACCENT_KEY, ds.themes.storage.accentKey],
    ['stubStyleKey', STUB_STYLE_KEY, ds.themes.storage.stubStyleKey],
  ] as const) {
    assert.equal(dsKey, key, `${label} mismatch in design-system.json`);
    assert.ok(appHtml.includes(key), `app.html missing ${key}`);
  }
});

test('src/components/ui/ uses semantic --la-* utilities instead of raw Tailwind palette colors', () => {
  const rawPalette = /\b(?:text|bg|border|ring|outline)-(?:zinc|violet|rose|emerald|amber|sky|fuchsia|cyan)-\d{2,3}\b/;
  const uiDir = path.join(root, 'src', 'components', 'ui');
  const offenders = readdirSync(uiDir)
    .filter((f) => f.endsWith('.tsx'))
    .filter((f) => rawPalette.test(readFileSync(path.join(uiDir, f), 'utf8')));
  assert.deepEqual(offenders, []);
});

// Neon cleanup (docs/specs/neon-cleanup.md): no new "faux neon" (coloured border plus same-colour text).
const walkTsx = (dir: string): string[] =>
  readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkTsx(path.join(dir, e.name)) : e.name.endsWith('.tsx') ? [path.join(dir, e.name)] : [],
  );
const NEON_ALLOW = new Set(['src/components/ui/Ticket.tsx']);
const NEON_COLOURS = ['accent', 'good', 'warn', 'bad', 'second'];

test('no faux neon: one class string never has a coloured border and same-colour text', () => {
  const hits: string[] = [];
  const strings = /(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
  const base = (t: string) => t.slice(t.lastIndexOf(':') + 1).replace(/^!|!$/g, '');
  for (const rel of walkTsx('src')) {
    if (NEON_ALLOW.has(rel.split(path.sep).join('/'))) continue;
    read(rel).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(strings)) {
        const toks = m[2].split(/\s+/).map(base);
        for (const c of NEON_COLOURS) {
          const border = new RegExp(`^border-${c}(-tint-line)?(/\\d+)?$`);
          const text = new RegExp(`^text-${c}(/\\d+)?$`);
          if (toks.some((t) => border.test(t)) && toks.some((t) => text.test(t))) hits.push(`${rel}:${i + 1} (${c})`);
        }
      }
    });
  }
  assert.deepEqual(hits, [], `Faux neon found; use soft solid instead (docs/specs/neon-cleanup.md): ${hits.join(', ')}`);
});

test('Pill and HintPill carry no hairline border', () => {
  for (const rel of ['src/components/ui/Pill.tsx', 'src/components/ui/HintPill.tsx']) {
    assert.ok(!/border/.test(read(rel)), `${rel} mentions "border"; pills are soft solid with no hairlines (docs/specs/neon-cleanup.md)`);
  }
});
