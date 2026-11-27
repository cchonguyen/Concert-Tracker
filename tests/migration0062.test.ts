import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const raw = readFileSync('supabase/migrations/0062_artist_cleanup_universe_fallback.sql', 'utf8');
const sql = raw
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

function functionBody(name: string): string {
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\(`, 'i'));
  assert.ok(start >= 0, `${name} is defined`);
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('$$', open + 2);
  assert.ok(open > 0 && close > open, `${name} has a body`);
  return sql.slice(start, close + 2);
}

test('0062 canonical_artist_cleanup is security definer, service_role only, with dry-run rollback and universe fallback', () => {
  const body = functionBody('canonical_artist_cleanup');
  assert.match(body, /security definer\s+set search_path = public, pg_temp/i);
  assert.match(body, /create temp table _universe_keys/i);
  assert.match(body, /public\.seen_act_names\(\)/i);
  assert.match(body, /if p_dry_run then\s+raise exception using errcode = 'P0099'/i);
  assert.match(body, /when sqlstate 'P0099' then\s+return v_report/i);
  const sig = 'public\\.canonical_artist_cleanup\\(jsonb, boolean, text, text, uuid\\)';
  assert.match(sql, new RegExp(`revoke all on function ${sig} from public, anon, authenticated`, 'i'));
  assert.match(sql, new RegExp(`grant execute on function ${sig} to service_role`, 'i'));
  assert.doesNotMatch(sql, new RegExp(`grant[^;]*on function ${sig} to[^;]*\\b(anon|authenticated|public)\\b`, 'i'));
});
