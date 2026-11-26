import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLegalPage } from '../src/services/legalPage.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the Privacy panel reads the title, date line and every section of the public page, without its links or footer', () => {
  const page = parseLegalPage(read('public/privacy.html'));
  assert.ok(page);
  assert.equal(page.title, 'Privacy');
  assert.match(page.updated ?? '', /^Last updated \d{4}-\d{2}-\d{2}\./);
  const headings = page.sections.map((s) => s.heading);
  assert.deepEqual(headings.slice(0, 2), ['What LiveArchive stores', 'Signing in']);
  assert.equal(headings.at(-1), 'Changes');
  const all = page.sections.map((s) => s.html).join('\n');
  assert.ok(all.includes('"Deep search with AI"'));
  assert.ok(!all.includes('<footer'));
  assert.ok(!all.includes('© 2026'));
  assert.ok(!all.includes('class="muted"'));
});

test('the Terms panel reads the public page the same way', () => {
  const page = parseLegalPage(read('public/terms.html'));
  assert.ok(page);
  assert.equal(page.title, 'Terms');
  assert.deepEqual(
    page.sections.map((s) => s.heading),
    ['Who can use it', 'Your data', 'Lineups and sources', 'No warranty', 'Leaving', 'Changes'],
  );
  assert.ok(page.sections[0].html.startsWith('<p>LiveArchive is invite only.'));
});

test('a page that is not one of ours (the app shell, an error page) gives no panel content', () => {
  assert.equal(parseLegalPage('<!doctype html><div id="root"></div>'), null);
  assert.equal(parseLegalPage('<main><h1>Not found</h1><p>Nothing here.</p></main>'), null);
});
