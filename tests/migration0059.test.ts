import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const raw = readFileSync('supabase/migrations/0059_canonical_genres.sql', 'utf8');
// Comments stripped, whole-line and trailing (no string literal in this file holds "--").
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

test('0059 copies the owner\'s you rows to owner before deleting the you rows', () => {
  const copy = sql.search(/insert into public\.artist_genres\s*\([^)]*\)\s*select[^;]*'owner'[^;]*from public\.artist_genres where source = 'you'/i);
  const remove = sql.search(/delete from public\.artist_genres where source = 'you'/i);
  assert.ok(copy >= 0, 'copy of you rows to owner');
  assert.ok(remove >= 0, 'delete of you rows');
  assert.ok(copy < remove, 'copy comes before delete');
  const logged = sql.search(/insert into public\.artist_genre_changes[^;]*'you'[^;]*from public\.artist_genres g where g\.source = 'you'/i);
  assert.ok(logged >= 0 && logged < remove, 'each removed you row is logged before the delete');
});

test('0059 allows the owner source', () => {
  assert.match(sql, /add constraint artist_genres_source_check\s+check \(source in \([^)]*'owner'[^)]*\)\)/i);
});

test('0059 change log is append-only: a trigger refuses delete and any update but setting undone_at once', () => {
  assert.match(sql, /create table if not exists public\.artist_genre_changes/i);
  assert.match(sql, /create trigger artist_genre_changes_append_only before update or delete on public\.artist_genre_changes/i);
  const body = functionBody('artist_genre_changes_append_only');
  assert.match(body, /tg_op = 'DELETE'[\s\S]*raise exception/i);
  assert.match(body, /old\.undone_at is not null or new\.undone_at is null/i);
  assert.match(sql, /alter table public\.artist_genre_changes enable row level security/i);
  assert.match(sql, /revoke all on public\.artist_genre_changes from anon, authenticated/i);
});

for (const [name, args] of [
  ['artist_genres_write', 'jsonb, text, text, text'],
  ['seen_act_names', ''],
] as const) {
  test(`0059 ${name} is security definer, server only`, () => {
    const body = functionBody(name);
    assert.match(body, /security definer set search_path = public, pg_temp/i);
    const sig = `public\\.${name}\\(${args}\\)`;
    assert.match(sql, new RegExp(`revoke all on function ${sig} from public, anon, authenticated`, 'i'));
    assert.match(sql, new RegExp(`grant execute on function ${sig} to service_role`, 'i'));
    assert.doesNotMatch(sql, new RegExp(`grant[^;]*on function ${sig} to[^;]*\\b(anon|authenticated|public)\\b`, 'i'));
  });
}

test('0059 seen_act_names returns a key and a name only and never reads a user id', () => {
  const body = functionBody('seen_act_names');
  assert.match(body, /returns table\(artist_key text, name text\)/i);
  assert.doesNotMatch(body, /user_id/i);
  assert.match(body, /deleted_at is null/i);
  assert.match(body, /not like 'v1:%'/i);
});

test('0059 does not touch user_artist_genres outside comments', () => {
  assert.doesNotMatch(sql, /user_artist_genres/i);
  assert.match(raw, /user_artist_genres/, 'the comment saying it is untouched is still there');
});
