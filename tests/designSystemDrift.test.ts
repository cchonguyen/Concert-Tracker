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
