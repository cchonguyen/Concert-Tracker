import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToLines } from '../src/text.ts';

test('each block or cell becomes one line, with entities decoded', () => {
  const lines = htmlToLines('<table><tr><td>Order #&nbsp;123</td></tr><tr><td>Tom &amp; Jerry</td></tr></table>');
  assert.deepEqual(lines, ['Order # 123', 'Tom & Jerry']);
});

test('scripts and styles are dropped', () => {
  assert.deepEqual(htmlToLines('<style>p{}</style><p>Doors 7 PM</p><script>x()</script>'), ['Doors 7 PM']);
});
