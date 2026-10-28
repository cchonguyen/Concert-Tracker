import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STREAM_A_QUERY, STREAM_B_QUERY, queriesSince } from '../src/queries.ts';

test('Stream A names all 24 seller domains', () => {
  const domains = STREAM_A_QUERY.match(/[a-z0-9.-]+\.[a-z]{2,}/g) ?? [];
  // 24 sellers. Seetickets is listed under both its .us and .com domains, so 25 strings.
  assert.equal(new Set(domains).size, 25);
});

test('Stream B exclusions wrap the pkpass clause', () => {
  // Negated terms come first, and the pkpass clause sits inside the same group.
  assert.ok(STREAM_B_QUERY.startsWith('-cinema -movie -fandango -airline -flight -"boarding pass" ('));
  assert.ok(STREAM_B_QUERY.endsWith('OR filename:pkpass)'));
  assert.equal(parenBalance(STREAM_B_QUERY), 0);
});

test('watermarks add an after: clause to both streams', () => {
  const q = queriesSince('2026-10-20T00:00:00Z');
  assert.ok(q.streamA.endsWith('after:2026/10/20'));
  assert.ok(q.streamB.endsWith('after:2026/10/20'));
});

function parenBalance(q: string): number {
  return [...q].reduce((n, c) => n + (c === '(' ? 1 : c === ')' ? -1 : 0), 0);
}
