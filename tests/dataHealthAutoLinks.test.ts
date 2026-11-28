import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentAutoLinks } from '../src/services/dataHealth.ts';

test('Data health lists automatic links from the last 30 days, newest first', () => {
  const now = new Date('2026-11-28T00:00:00.000Z');
  const at = (iso?: string) => ({ details: iso ? { autoLinked: { editionId: 'x', at: iso } } : {} });
  const events = [
    { id: 'old', ...at('2026-10-01T00:00:00.000Z') },
    { id: 'a', ...at('2026-11-20T00:00:00.000Z') },
    { id: 'tap', ...at() },
    { id: 'b', ...at('2026-11-27T02:00:00.000Z') },
  ];
  assert.deepEqual(recentAutoLinks(events, now).map((e) => e.id), ['b', 'a']);
});
