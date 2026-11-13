import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Edition, EditionStatus, ReviewQueueKind, CapturedFields, LoggedEventInheritance } from '../src/server/lineup/types.ts';

const m41 = readFileSync('supabase/migrations/0041_shared_occurrences.sql', 'utf8');
const m42 = readFileSync('supabase/migrations/0042_merge_editions.sql', 'utf8');
const code = (sql: string) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const c41 = code(m41);
const c42 = code(m42);

const SHARED = ['canonical_venues', 'venue_aliases', 'edition_external_ids', 'edition_changes', 'review_queue'];
const PERSONAL = ['companions', 'notes', 'rating', 'ticket_price', 'price', 'attendance', 'days_attended'];

function createBody(table: string): string {
  const m = c41.match(new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`));
  assert.ok(m, `create table for ${table}`);
  return m[1];
}

test('0041 creates each shared table with row level security', () => {
  for (const t of SHARED) {
    createBody(t);
    assert.match(c41, new RegExp(`alter table public\\.${t} enable row level security`), t);
  }
});

test('shared tables hold no personal field names', () => {
  for (const t of SHARED) {
    const body = createBody(t);
    for (const f of PERSONAL) assert.doesNotMatch(body, new RegExp(`\\b${f}\\b`), `${t} has ${f}`);
  }
  // The new edition columns and the captured backfill are free of them too.
  const editionCols = c41.split('\n').filter((l) => /alter table public\.event_editions add column/.test(l)).join('\n');
  for (const f of PERSONAL) assert.doesNotMatch(editionCols, new RegExp(`\\b${f}\\b`), `event_editions column ${f}`);
  const backfill = c41.match(/set captured = jsonb_build_object\(([\s\S]*?)\)\nwhere captured is null/);
  assert.ok(backfill, 'captured backfill');
  for (const f of PERSONAL) assert.doesNotMatch(backfill[1], new RegExp(`\\b${f}\\b`), `captured has ${f}`);
});

test('edition status accepts all four values and converts nothing', () => {
  assert.match(c41, /check \(status in \('draft', 'provisional', 'verified', 'confirmed'\)\)/);
  assert.doesNotMatch(c41, /update public\.event_editions set status/);
  // The conversion exists only as a commented-out later step.
  assert.match(m41, /--\s+update public\.event_editions set status = 'verified' where status = 'confirmed'/);
});

test('new edition columns and the partial occurrence index', () => {
  for (const col of ['venue_id text references public.canonical_venues', 'subject_key text', 'has_lineup boolean']) {
    assert.ok(c41.includes(`add column if not exists ${col}`), col);
  }
  assert.match(c41, /create unique index if not exists event_editions_occurrence_uidx[\s\S]*?\(start_date, venue_id, subject_key\)[\s\S]*?where start_date is not null and venue_id is not null and subject_key is not null/);
});

test('external ids, review kinds and the append-only history', () => {
  assert.match(createBody('edition_external_ids'), /unique \(source, external_id\)/);
  for (const k of ['override', 'merge_suggestion', 'provisional', 'formatting', 'failed_lookup']) {
    assert.ok(createBody('review_queue').includes(`'${k}'`), k);
  }
  assert.match(createBody('review_queue'), /status text not null default 'open'/);
  const history = createBody('edition_changes');
  for (const col of ['edition_id', 'at', 'actor', 'reason', 'before jsonb', 'after jsonb', 'undone_at']) assert.ok(history.includes(col), col);
  assert.match(c41, /raise exception 'edition_changes is append-only: rows are never deleted'/);
  assert.match(c41, /grant update \(undone_at\) on public\.edition_changes to service_role/);
  assert.doesNotMatch(c41, /grant[^;]*delete[^;]*on public\.edition_changes/);
});

test('logged_events captured is backfilled once and never overwritten; overrides default empty', () => {
  assert.match(c41, /add column if not exists captured jsonb;/);
  assert.match(c41, /add column if not exists overrides jsonb not null default '\{\}'::jsonb/);
  assert.match(c41, /where captured is null;/);
  assert.match(c41, /if old\.captured is not null then\s+new\.captured := old\.captured;/);
});

test('access: members read the catalog, owner reads history and queue, service key writes', () => {
  assert.match(c41, /'canonical_venues','venue_aliases','edition_external_ids'[\s\S]*?"members_read"[\s\S]*?for select to authenticated using \(true\)/);
  assert.match(c41, /'edition_changes','review_queue'[\s\S]*?"owner_read"[\s\S]*?auth\.uid\(\) = owner_user_id\(\)/);
  assert.doesNotMatch(c41, /create policy[^;]*for (insert|update|delete|all)/);
});

test('both migrations carry a check query and a rollback', () => {
  for (const m of [m41, m42]) {
    assert.match(m, /-- Check \(/);
    assert.match(m, /-- Rollback/);
  }
});

test('0042 merge_editions is atomic, guarded and service-role only', () => {
  assert.match(c42, /create or replace function public\.merge_editions\(\s*keep_id text,\s*drop_id text/);
  assert.match(c42, /security definer\s+set search_path = public, pg_temp/);
  assert.match(c42, /keep_id = drop_id/);
  assert.match(c42, /edition % not found/);
  for (const t of ['logged_events', 'attendance', 'performances', 'edition_external_ids', 'lookup_jobs', 'review_queue']) {
    assert.match(c42, new RegExp(`update public\\.${t} set edition_id = keep_id where edition_id = drop_id`), t);
  }
  assert.match(c42, /insert into public\.edition_changes/);
  assert.ok(c42.indexOf('insert into public.edition_changes') < c42.indexOf('delete from public.event_editions where id = drop_id'));
  assert.match(c42, /revoke all on function public\.merge_editions\(text, text, text, text\) from public, anon, authenticated/);
  assert.match(c42, /grant execute on function public\.merge_editions\(text, text, text, text\) to service_role/);
  // The legacy 0002 attendance table is only repointed by edition_id; no personal column is read or copied.
  const c42NoLegacy = c42.replace(/public\.attendance|n_attendance|attendance_moved/g, '');
  for (const f of PERSONAL) assert.doesNotMatch(c42NoLegacy, new RegExp(`\\b${f}\\b`), f);
});

test('types accept the new states and keep old callers compiling', () => {
  const statuses: EditionStatus[] = ['draft', 'provisional', 'verified'];
  const kinds: ReviewQueueKind[] = ['override', 'merge_suggestion', 'provisional', 'formatting', 'failed_lookup'];
  const old: Pick<Edition, 'status'> = { status: 'confirmed' };
  const captured: CapturedFields = { name: 'X', city: null };
  const inh: LoggedEventInheritance = { captured, overrides: { city: 'Y' } };
  assert.equal(statuses.length + kinds.length, 8);
  assert.equal(old.status, 'confirmed');
  assert.equal(inh.overrides?.city, 'Y');
});
