import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editionKeyFor, htmlToText, isVerbatim, normalizeName, seriesSlugFor } from '../src/server/lineup/text.ts';

test('normalizeName folds case, accents and punctuation', () => {
  assert.equal(normalizeName('Tiësto'), 'tiesto');
  assert.equal(normalizeName('Fred again..'), 'fred again');
  assert.equal(normalizeName('Above & Beyond'), 'above and beyond');
});

test('edition keys drop the year from the series slug', () => {
  assert.equal(seriesSlugFor('EDC Las Vegas 2025'), 'edc-las-vegas');
  assert.equal(editionKeyFor('EDC Las Vegas 2025', 2025), 'edc-las-vegas/2025');
});

test('isVerbatim requires the quote in the source and the name in the quote', () => {
  const source = normalizeName('FRIDAY\nKaskade\nDom Dolla b2b John Summit\nMain Stage');
  assert.equal(isVerbatim('Kaskade', 'Kaskade', source), true);
  assert.equal(isVerbatim('Dom Dolla', 'Dom Dolla b2b John Summit', source), true);
  assert.equal(isVerbatim('Skrillex', 'Skrillex', source), false); // hallucinated
  assert.equal(isVerbatim('Kaskade', 'Dom Dolla', source), false); // quote does not contain name
  assert.equal(isVerbatim('Dom', 'Dom Dolla', source), true);
  assert.equal(isVerbatim('Dolla b', 'Dom Dolla b2b', source), false); // partial words do not count
});

test('htmlToText keeps visible text and embedded JSON strings', () => {
  const html = `<html><head><style>.x{}</style><script>var a=1</script>
    <script id="__NEXT_DATA__" type="application/json">{"props":{"artists":[{"name":"Peggy Gou"}]}}</script></head>
    <body><h2>Lineup</h2><ul><li>Kaskade</li><li>Rüfüs Du Sol &amp; friends</li></ul></body></html>`;
  const text = htmlToText(html);
  assert.match(text, /Kaskade/);
  assert.match(text, /Rüfüs Du Sol & friends/);
  assert.match(text, /Peggy Gou/);
  assert.doesNotMatch(text, /var a=1/);
});

test('server-side fetching refuses private and local addresses', async () => {
  const { assertPublicHttpUrl } = await import('../src/server/lineup/http.ts');
  for (const bad of ['http://localhost:3000', 'http://169.254.169.254/latest', 'http://10.0.0.5/', 'http://metadata.google.internal/', 'file:///etc/passwd', 'http://[::1]/', 'http://2130706433/']) {
    assert.throws(() => assertPublicHttpUrl(bad), bad);
  }
  assert.equal(assertPublicHttpUrl('https://lasvegas.electricdaisycarnival.com/lineup').hostname, 'lasvegas.electricdaisycarnival.com');
});
