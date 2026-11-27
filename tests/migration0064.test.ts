import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const raw = readFileSync('supabase/migrations/0064_artist_orbits.sql', 'utf8');
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

function tableBody(name: string): string {
  const m = sql.match(new RegExp(`create table if not exists public\\.${name} \\(([\\s\\S]*?)\\n\\);`, 'i'));
  assert.ok(m, `${name} is created`);
  return m[1];
}

test('0064 is safe to run twice', () => {
  assert.doesNotMatch(sql, /create table (?!if not exists)/i);
  assert.doesNotMatch(sql, /create index (?!if not exists)/i);
  assert.doesNotMatch(sql, /add column (?!if not exists)/i);
  for (const m of sql.matchAll(/add constraint (\w+)/gi)) {
    assert.match(sql, new RegExp(`drop constraint if exists ${m[1]}`, 'i'), `${m[1]} is dropped first`);
  }
});

test('0064 artist_orbits: text id, 2 to 4 anchors, origin set, parent genre references genres', () => {
  const body = tableBody('artist_orbits');
  assert.match(body, /id text primary key/i);
  assert.match(body, /anchor_keys text\[\] not null check \(cardinality\(anchor_keys\) between 2 and 4\)/i);
  assert.match(body, /working_label text,/i);
  assert.match(body, /parent_genre_key text references public\.genres \(key\) on delete set null/i);
  assert.match(body, /origin text not null default 'curated' check \(origin in \('curated','lineup_cluster','hybrid'\)\)/i);
  assert.match(body, /updated_at timestamptz not null default now\(\)/i);
});

test('0064 artist_orbit_members: cascade from the orbit, centrality in 1.0, 0.5, 0.25, key pair primary', () => {
  const body = tableBody('artist_orbit_members');
  assert.match(body, /orbit_id text not null references public\.artist_orbits \(id\) on delete cascade/i);
  assert.match(body, /artist_key text not null/i);
  assert.match(body, /centrality numeric not null check \(centrality in \(1\.0, 0\.5, 0\.25\)\)/i);
  assert.match(body, /primary key \(orbit_id, artist_key\)/i);
  assert.match(sql, /create index if not exists artist_orbit_members_artist_idx on public\.artist_orbit_members \(artist_key\)/i);
  assert.doesNotMatch(body, /user_id|member_id|companion|event|note|rating/i);
});

test('0064 artist_orbit_changes: before and after images, actor owner or system, undo fields', () => {
  const body = tableBody('artist_orbit_changes');
  assert.match(body, /id uuid primary key default gen_random_uuid\(\)/i);
  assert.match(body, /old jsonb,/i);
  assert.match(body, /new jsonb,/i);
  assert.match(body, /actor text not null check \(actor = 'owner' or actor like 'system:%'\)/i);
  assert.match(body, /reason text,/i);
  assert.match(body, /at timestamptz not null default now\(\)/i);
  assert.match(body, /undone_at timestamptz,/i);
  assert.match(body, /undone_by text/i);
  assert.doesNotMatch(body, /user_id|companion|rating|price/i);
});

test('0064 RLS is on for all three tables, with no policies and no API grants', () => {
  for (const t of ['artist_orbits', 'artist_orbit_members', 'artist_orbit_changes']) {
    assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security`, 'i'), `${t} has RLS on`);
  }
  assert.match(sql, /revoke all on public\.artist_orbits, public\.artist_orbit_members, public\.artist_orbit_changes from anon, authenticated/i);
  assert.doesNotMatch(sql, /create policy/i);
  assert.doesNotMatch(sql, /grant[^;]*on (table )?public\.artist_orbit[^;]*to[^;]*\b(anon|authenticated|public)\b/i);
});

test('0064 images: each orbit with its members, ordered, null ids means all', () => {
  const images = functionBody('artist_orbits_images');
  assert.match(images, /p_?ids text\[\]|\(ids text\[\]\)/i);
  for (const field of ["'id'", "'anchorKeys'", "'workingLabel'", "'parentGenreKey'", "'origin'", "'members'", "'artistKey'", "'centrality'"]) {
    assert.ok(images.includes(field), `images include ${field}`);
  }
  assert.match(images, /ids is null or o\.id = any\(ids\)/i);
  assert.match(images, /where m\.orbit_id = o\.id/i);
});

test('0064 write: anchors become 1.0 members, a different centrality is refused, one change row is logged', () => {
  const insert = functionBody('artist_orbits_insert');
  assert.match(insert, /centrality\) values \(v_id, v_anchor, 1\.0\)/i);
  assert.match(insert, /must have centrality 1\.0/i);
  assert.match(insert, /listed twice/i);
  assert.match(insert, /cardinality\(v_anchors\)/i);

  const write = functionBody('artist_orbits_write');
  assert.match(write, /next jsonb, replace_ids text\[\], actor text, reason text/i);
  assert.match(write, /returns uuid/i);
  assert.match(write, /security definer/i);
  assert.match(write, /set search_path = public, pg_temp/i);
  assert.match(write, /actor = 'owner' or actor like 'system:%'/i);
  assert.match(write, /coalesce\(replace_ids, '\{\}'\) \|\| v_ids/i);
  assert.match(write, /v_old := public\.artist_orbits_images\(v_touch\)/i);
  assert.match(write, /delete from public\.artist_orbits where id = any\(v_touch\)/i);
  assert.match(write, /perform public\.artist_orbits_insert\(next\)/i);
  assert.match(write, /insert into public\.artist_orbit_changes \(old, new, actor, reason\)/i);
  assert.match(write, /returning id into v_change_id/i);
  assert.match(write, /pg_advisory_xact_lock/i);
});

test('0064 undo: refuses a repeat and a stale change, restores old images, logs a new Undo row', () => {
  const undo = functionBody('artist_orbits_undo');
  assert.match(undo, /undo\(change_id uuid, actor text\)/i);
  assert.match(undo, /returns uuid/i);
  assert.match(undo, /already undone/i);
  assert.match(undo, /is stale/i);
  assert.match(undo, /artist_orbits_images\(v_new_ids\) is distinct from coalesce\(v_change\.new/i);
  assert.match(undo, /perform public\.artist_orbits_insert\(coalesce\(v_change\.old/i);
  assert.match(undo, /undone_at = now\(\), undone_by = v_actor/i);
  assert.match(undo, /values \(v_before, v_after, actor, 'Undo'\)/i);
  assert.match(undo, /for update/i);
});

test('0064 functions: images, write and undo are server only; the insert helper is not granted to any API role', () => {
  for (const fn of ['artist_orbits_images(text[])', 'artist_orbits_write(jsonb, text[], text, text)', 'artist_orbits_undo(uuid, text)', 'artist_orbits_insert(jsonb)']) {
    const name = fn.replace(/[()[\]]/g, (c) => `\\${c}`);
    assert.match(sql, new RegExp(`revoke all on function public\\.${name} from public, anon, authenticated`, 'i'), `${fn} is revoked`);
  }
  for (const fn of ['artist_orbits_images(text[])', 'artist_orbits_write(jsonb, text[], text, text)', 'artist_orbits_undo(uuid, text)']) {
    const name = fn.replace(/[()[\]]/g, (c) => `\\${c}`);
    assert.match(sql, new RegExp(`grant execute on function public\\.${name} to service_role`, 'i'), `${fn} is granted to service_role`);
  }
  assert.doesNotMatch(sql, /grant execute on function public\.artist_orbits_insert/i);
});

test('0064 never touches stored artist genres, the member genres or the log of events', () => {
  assert.doesNotMatch(sql, /\b(artist_genres|user_artist_genres|logged_events|user_id)\b/i);
});
