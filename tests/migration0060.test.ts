import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const raw = readFileSync('supabase/migrations/0060_genre_vocabulary.sql', 'utf8');
// Comments stripped, whole-line and trailing (no string literal in this file holds "--").
const sql = raw
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

const TABLES = ['genres', 'genre_aliases', 'genre_umbrellas', 'genre_changes'] as const;

function functionBody(name: string): string {
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\(`, 'i'));
  assert.ok(start >= 0, `${name} is defined`);
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('$$', open + 2);
  assert.ok(open > 0 && close > open, `${name} has a body`);
  return sql.slice(start, close + 2);
}

function tableBody(name: string): string {
  const m = sql.match(new RegExp(`create table if not exists public\\.${name} \\(([\\s\\S]*?)\\n\\);`, 'i'));
  assert.ok(m, `${name} is created`);
  return m[1];
}

test('0060 creates the four vocabulary tables, safe to run twice', () => {
  for (const t of TABLES) tableBody(t);
  assert.doesNotMatch(sql, /create table (?!if not exists)/i);
  assert.doesNotMatch(sql, /create index (?!if not exists)/i);
  assert.match(sql, /drop trigger if exists genre_changes_append_only on public\.genre_changes/i);
});

test('0060 keeps the operation names in step with GenreVocabOperation', () => {
  const ops = ['rename', 'alias-add', 'alias-remove', 'merge', 'parent', 'umbrella-add', 'umbrella-remove', 'spelling', 'create', 'undo'];
  const types = readFileSync('src/server/events/genreTypes.ts', 'utf8');
  const union = types.match(/export type GenreVocabOperation =([^;]*);/);
  assert.ok(union);
  const unionOps = [...union[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const op of ops) assert.ok(unionOps.includes(op), `GenreVocabOperation keeps ${op}`);
  const check = tableBody('genre_changes').match(/operation in \(([^)]*)\)/i);
  assert.ok(check);
  assert.deepEqual([...check[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(), [...ops].sort());
  assert.match(tableBody('genre_changes'), /actor text not null check \(actor = 'owner' or actor like 'system:%'\)/i);
});

test('0060 RLS is on for every table, with no policies and no anon or member access', () => {
  for (const t of TABLES) {
    assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security`, 'i'));
  }
  assert.doesNotMatch(sql, /create policy/i);
  assert.match(sql, /revoke all on public\.genres, public\.genre_aliases, public\.genre_umbrellas, public\.genre_changes from anon, authenticated/i);
  assert.doesNotMatch(sql, /grant[^;]*on (table )?public\.genre[^;]*to[^;]*\b(anon|authenticated|public)\b/i);
});

test('0060 change log is append-only: a trigger refuses delete and any update but setting undone_at once', () => {
  assert.match(sql, /create trigger genre_changes_append_only before update or delete on public\.genre_changes/i);
  const body = functionBody('genre_changes_append_only');
  assert.match(body, /tg_op = 'DELETE'[\s\S]*raise exception/i);
  assert.match(body, /old\.undone_at is not null or new\.undone_at is null/i);
});

for (const [name, args] of [
  ['genre_vocabulary_write', 'jsonb, text, text, text, text'],
  ['genre_vocabulary_images', 'text\\[\\]'],
] as const) {
  test(`0060 ${name} is server only`, () => {
    const sig = `public\\.${name}\\(${args}\\)`;
    assert.match(sql, new RegExp(`revoke all on function ${sig} from public, anon, authenticated`, 'i'));
    assert.match(sql, new RegExp(`grant execute on function ${sig} to service_role`, 'i'));
    assert.doesNotMatch(sql, new RegExp(`grant[^;]*on function ${sig} to[^;]*\\b(anon|authenticated|public)\\b`, 'i'));
  });
}

test('0060 genre_vocabulary_write is security definer and returns one change row', () => {
  const body = functionBody('genre_vocabulary_write');
  assert.match(body, /returns public\.genre_changes\s/i);
  assert.match(body, /security definer set search_path = public, pg_temp/i);
  assert.match(body, /for update/i, 'before images are read under a lock');
  assert.match(body, /insert into public\.genre_changes \(actor, operation, reason, summary, before, after\)/i);
});

test('0060 genre_vocabulary_write refuses alias keys that collide with a genre key or another alias', () => {
  const body = functionBody('genre_vocabulary_write');
  assert.match(body, /exists \(select 1 from public\.genres g where g\.key = v_alias_key\)\s*then\s*raise exception/i);
  assert.match(body, /exists \(select 1 from public\.genre_aliases ga where ga\.alias_key = v_alias_key\)\s*then\s*raise exception/i);
  assert.match(body, /exists \(select 1 from public\.genre_aliases ga where ga\.alias_key = v_key\)\s*then\s*raise exception/i, 'a new genre key that is already an alias');
});

test('0060 genre_vocabulary_write refuses umbrella loops, self links and missing umbrellas', () => {
  const body = functionBody('genre_vocabulary_write');
  assert.match(body, /with recursive up\(k\)[\s\S]*select 1 from up where up\.k = v_key\s*\)\s*then\s*raise exception[^;]*umbrella loop/i);
  assert.match(body, /v_umbrella = v_key then\s*raise exception/i);
  assert.match(body, /not exists \(select 1 from public\.genres g where g\.key = v_umbrella\) then\s*raise exception/i);
  assert.match(tableBody('genre_umbrellas'), /check \(genre_key <> umbrella_key\)/i);
});

test('0060 holds no personal or per-member columns', () => {
  const banned = /\b(user_id|event_id|member_id|owner_id|artist_key|companions?|notes?|rating|price|attendance|seen|logged_events)\b/i;
  for (const t of TABLES) {
    const cols = tableBody(t)
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((c) => c && !/^(primary|check|foreign|unique)$/i.test(c));
    for (const c of cols) assert.doesNotMatch(c, banned, `${t}.${c}`);
  }
  assert.doesNotMatch(sql, /user_id|event_id|logged_events|artist_genres/i);
});

test('0060 ends with a check query and a rollback', () => {
  assert.match(raw, /^-- Check \(run after applying/m);
  assert.match(raw, /^-- Rollback/m);
  assert.match(raw, /^--\s+drop function if exists public\.genre_vocabulary_write\(jsonb, text, text, text, text\);/m);
  for (const t of TABLES) assert.match(raw, new RegExp(`^--\\s+drop table if exists public\\.${t};`, 'm'));
});
