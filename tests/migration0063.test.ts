import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const raw = readFileSync('supabase/migrations/0063_genre_taxonomy.sql', 'utf8');
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

test('0063 is safe to run twice', () => {
  assert.doesNotMatch(sql, /create table (?!if not exists)/i);
  assert.doesNotMatch(sql, /create index (?!if not exists)/i);
  assert.doesNotMatch(sql, /add column (?!if not exists)/i);
  for (const m of sql.matchAll(/add constraint (\w+)/gi)) {
    assert.match(sql, new RegExp(`drop constraint if exists ${m[1]}`, 'i'), `${m[1]} is dropped first`);
  }
});

test('0063 gives genres a level, one primary parent, a tier and separate key spaces', () => {
  assert.match(sql, /add column if not exists level text not null default 'genre'/i);
  assert.match(sql, /check \(level in \('genre','family','macro'\)\)/i);
  assert.match(sql, /primary_parent_key text\s+references public\.genres \(key\) on update cascade on delete set null/i);
  assert.match(sql, /specificity_tier in \('specific','umbrella_fallback'\)/i);
  assert.match(sql, /level = 'genre' and position\(':' in key\) = 0/i);
  assert.match(sql, /level = 'family' and key like 'family:%'/i);
  assert.match(sql, /level = 'macro' and key like 'macro:%'/i);
});

test('0063 genre_relations: three types, three origins, weight in (0, 1], server only', () => {
  const m = sql.match(/create table if not exists public\.genre_relations \(([\s\S]*?)\n\);/i);
  assert.ok(m);
  const body = m[1];
  assert.match(body, /type in \('secondary_parent','adjacent','derived_from'\)/i);
  assert.match(body, /origin in \('curated','artist_cooccur','lineup_cooccur'\)/i);
  assert.match(body, /weight > 0 and weight <= 1/i);
  assert.match(body, /primary key \(source_key, target_key, type\)/i);
  assert.match(body, /check \(source_key <> target_key\)/i);
  assert.doesNotMatch(body, /user_id|member|companion|event/i);
  assert.match(sql, /alter table public\.genre_relations enable row level security/i);
  assert.match(sql, /revoke all on public\.genre_relations from anon, authenticated/i);
  assert.doesNotMatch(sql, /create policy/i);
  assert.doesNotMatch(sql, /grant[^;]*on (table )?public\.genre[^;]*to[^;]*\b(anon|authenticated|public)\b/i);
});

test('0063 keeps every 0060 operation and adds the taxonomy ones, in the table and the write', () => {
  const ops = ['rename', 'alias-add', 'alias-remove', 'merge', 'parent', 'umbrella-add', 'umbrella-remove', 'spelling',
    'create', 'undo', 'taxonomy-import', 'relations-import', 'relation-add', 'relation-remove', 'relation-weight', 'family'];
  const check = sql.match(/genre_changes_operation_check check \(operation in \(([^)]*)\)\)/i);
  assert.ok(check);
  assert.deepEqual([...check[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort(), [...ops].sort());
  const write = functionBody('genre_vocabulary_write');
  const inWrite = write.match(/p_operation not in \(([^)]*)\)/i);
  assert.ok(inWrite);
  assert.deepEqual([...inWrite[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort(), [...ops].sort());
});

test('0063 images carry level, primary parent, tier and outgoing relations', () => {
  const images = functionBody('genre_vocabulary_images');
  for (const field of ["'level'", "'relations'", "'primaryParent'", "'tier'", "'parent'"]) {
    assert.ok(images.includes(field), `images include ${field}`);
  }
  assert.match(images, /where r\.source_key = g\.key/i);
});

test('0063 write enforces the level and relation rules and the curated guard', () => {
  const write = functionBody('genre_vocabulary_write');
  assert.match(write, /security definer/i);
  assert.match(write, /c\.level = 'genre' and p\.level = 'family'\) or \(c\.level = 'family' and p\.level = 'macro'/i);
  assert.match(write, /gr\.type = 'secondary_parent' and s\.level = 'genre' and t\.level = 'family'/i);
  assert.match(write, /gr\.type in \('adjacent','derived_from'\) and s\.level = 'genre' and t\.level = 'genre'/i);
  assert.match(write, /an adjacent pair is stored once/i);
  assert.match(write, /makes a loop/i);
  assert.match(write, /p_actor like 'system:%' and \(/i);
  assert.match(write, /a system job never changes a curated relation/i);
  assert.match(write, /insert into public\.genre_changes/i);
});

test('0063 write leaves taxonomy alone for a pre-0063 image (an undo of an older change)', () => {
  const write = functionBody('genre_vocabulary_write');
  assert.match(write, /\(x->'image'\) \? 'level'/i);
  assert.match(write, /delete from public\.genre_relations where source_key = any\(v_full\)/i);
  assert.match(write, /continue when not \(v_image \? 'level'\)/i);
});

test('0063 functions are server only', () => {
  for (const fn of ['genre_vocabulary_images(text[])', 'genre_vocabulary_write(jsonb, text, text, text, text)', 'genre_relations_list()']) {
    const name = fn.replace(/[()[\]]/g, (c) => `\\${c}`);
    assert.match(sql, new RegExp(`revoke all on function public\\.${name} from public, anon, authenticated`, 'i'));
    assert.match(sql, new RegExp(`grant execute on function public\\.${name} to service_role`, 'i'));
  }
});

test('0063 never touches stored artist genres', () => {
  assert.doesNotMatch(sql, /\b(artist_genres|user_artist_genres|logged_events)\b/i);
});
