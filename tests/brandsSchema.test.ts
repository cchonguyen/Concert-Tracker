import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Slice 1 of Global Editions: the brands table and series link (migration 0047).
const sql = readFileSync('supabase/migrations/0047_brands.sql', 'utf8');
const code = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

const PERSONAL = ['companions', 'notes', 'rating', 'ticket_price', 'price', 'attendance', 'days_attended'];

test('0047 creates brands with row level security and no personal columns', () => {
  const m = code.match(/create table if not exists public\.brands \(([\s\S]*?)\n\);/);
  assert.ok(m, 'create table for brands');
  assert.match(code, /alter table public\.brands enable row level security/);
  for (const word of PERSONAL) {
    assert.doesNotMatch(m[1], new RegExp(`\\b${word}\\b`), word);
  }
});

test('0047 keeps one brand per name, case-insensitively', () => {
  assert.match(code, /name_key text not null/);
  assert.match(code, /constraint brands_name_key_unique unique \(name_key\)/);
});

test('0047 links series to a brand and leaves the text column in place', () => {
  assert.match(code, /add column if not exists brand_id uuid\s+references public\.brands\(id\) on delete set null/);
  assert.doesNotMatch(code, /drop column/i);
});

test('0047 organization link points at the existing entities table', () => {
  assert.match(code, /organization_id uuid references public\.entities\(id\) on delete set null/);
});

test('0047 backfill is idempotent (deterministic ids and on conflict do nothing)', () => {
  assert.match(code, /on conflict \(name_key\) do nothing/);
  assert.match(code, /md5\('brand:' \|\| lower\(btrim\(s\.brand\)\)\)/);
  assert.match(code, /where s\.brand_id is null/);
});
