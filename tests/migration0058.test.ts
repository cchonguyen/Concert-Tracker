import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync('supabase/migrations/0058_series_levels.sql', 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

test('0058 only adds nullable columns and an index: no row or column is changed or dropped', () => {
  assert.doesNotMatch(sql, /\b(drop|update|default)\b|(?<!is )\bnot null\b|(?<!on )\bdelete\b/i);
  for (const [table, column] of [
    ['event_series', 'qualifier'],
    ['event_editions', 'subtitle'],
    ['logged_events', 'series_slug'],
  ]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} add column if not exists ${column} text`, 'i'), `${table}.${column}`);
  }
});

test('0058 links an event to its shared series and lets the series go without losing the event', () => {
  assert.match(sql, /series_slug text\s+references public\.event_series\(slug\) on delete set null/i);
  assert.match(sql, /create index if not exists logged_events_series_slug_idx/i);
});
