import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rawSql = readFileSync('supabase/migrations/0054_db_perf_rls_and_lineup_flag.sql', 'utf8');
const activeSql = rawSql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

test('0054 keeps authenticated EXECUTE on canonical_* and owner_user_id while revoking public/anon', () => {
  for (const fn of [
    'public.owner_user_id()',
    'public.canonical_artist_fingerprint(jsonb, uuid)',
    'public.canonical_apply_artist_change(text, jsonb, uuid)',
    'public.canonical_undo_artist_change(uuid, uuid)',
  ]) {
    assert.ok(activeSql.includes(`revoke all on function ${fn} from public, anon`), `revoke public/anon for ${fn}`);
    assert.ok(activeSql.includes(`grant execute on function ${fn} to authenticated, service_role`), `keep authenticated for ${fn}`);
    assert.doesNotMatch(
      activeSql,
      new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^;]*authenticated`, 'i'),
    );
  }
});

test('0054 drops the 4 open 0001 policies inside to_regclass guards', () => {
  assert.match(activeSql, /to_regclass\('public\.' \|\| rec\.tbl\) is not null/i);
  for (const [tbl, pol] of [
    ['artists', 'Allow all access to artists'],
    ['venues', 'Allow all access to venues'],
    ['events', 'Allow all access to events'],
    ['event_appearances', 'Allow all access to event_appearances'],
  ]) {
    assert.ok(activeSql.includes(`'${tbl}', '${pol}'`), `drop guard for ${tbl}.${pol}`);
  }
});

test('0054 rewrites all 19 RLS policies using (select auth.uid()) and (select public.owner_user_id())', () => {
  const ownRowsTables = [
    'activity_log',
    'email_imports',
    'logged_events',
    'lookup_jobs',
    'share_links',
    'user_artist_genres',
    'user_entities',
    'user_entity_aliases',
    'user_entity_history',
    'user_entity_links',
    'user_settings',
  ];
  for (const table of ownRowsTables) {
    assert.match(
      activeSql,
      new RegExp(
        `create policy own_rows on public\\.${table}[\\s\\S]*?using \\(\\(select auth\\.uid\\(\\)\\) = user_id\\)[\\s\\S]*?with check \\(\\(select auth\\.uid\\(\\)\\) = user_id\\)`,
      ),
      `own_rows initplan on ${table}`,
    );
  }

  assert.match(
    activeSql,
    /create policy "own_attendance" on public\.attendance[\s\S]*?using \(user_id = \(select auth\.uid\(\)\)\)[\s\S]*?with check \(user_id = \(select auth\.uid\(\)\)\)/,
  );
  assert.match(
    activeSql,
    /create policy "own_seen_sets" on public\.seen_sets[\s\S]*?a\.user_id = \(select auth\.uid\(\)\)[\s\S]*?with check[\s\S]*?a\.user_id = \(select auth\.uid\(\)\)/,
  );

  const ownerReadTables = ['ai_calls', 'edition_changes', 'ingest_traces', 'quota_ledger', 'review_queue', 'source_stats'];
  for (const table of ownerReadTables) {
    assert.match(
      activeSql,
      new RegExp(
        `create policy "owner_read" on public\\.${table} for select to authenticated\\s+using \\(\\(select auth\\.uid\\(\\)\\) = \\(select public\\.owner_user_id\\(\\)\\)\\)`,
      ),
      `owner_read initplan on ${table}`,
    );
  }
});

test('0054 creates all 12 covering/partial indexes and 4 guarded composite PKs', () => {
  const expectedIndexes = [
    'idx_attendance_edition_id',
    'idx_event_editions_series_slug',
    'idx_event_editions_venue_id',
    'idx_logged_events_edition_id',
    'idx_performances_artist_key',
    'idx_performer_claims_document_id',
    'idx_review_queue_event_id',
    'idx_seen_sets_artist_key',
    'idx_user_entities_merged_into',
    'idx_user_entity_links_to',
    'idx_venue_aliases_venue_id',
    'idx_logged_events_pending_research',
  ];
  for (const idx of expectedIndexes) {
    assert.match(activeSql, new RegExp(`create index if not exists ${idx}\\b`, 'i'), idx);
  }

  for (const [table, cols] of [
    ['venue_aliases', 'alias_normalized, venue_id'],
    ['edition_external_ids', 'source, external_id'],
    ['entity_aliases', 'kind, alias_normalized'],
    ['user_entity_aliases', 'user_id, kind, companion_token'],
  ]) {
    assert.ok(activeSql.includes(`alter table public.${table} add primary key (${cols})`), `PK on ${table}`);
    assert.ok(activeSql.includes(`conrelid = 'public.${table}'::regclass and contype = 'p'`), `idempotent guard on ${table}`);
  }
});

test('0054 performs only safe idempotent repairs and keeps destructive cleanup commented out', () => {
  assert.match(activeSql, /update public\.event_editions e\s+set has_lineup = true[\s\S]*?from public\.performances p/);
  assert.match(activeSql, /update public\.logged_events\s+set country = 'United States'/);
  assert.match(activeSql, /update public\.event_editions\s+set country = 'United States'/);
  assert.match(activeSql, /where trim\(country\) = 'WA'/);
  assert.match(activeSql, /update public\.email_imports[\s\S]*?where data ->> 'venue' ~\* '\(/);
  assert.match(activeSql, /insert into public\.app_settings \(key, data, updated_at\)[\s\S]*?'refused_hosts'[\s\S]*?on conflict \(key\) do nothing/);

  // Destructive drops/deletes stay commented out for operator review.
  assert.doesNotMatch(activeSql, /\bdrop table\b/i);
  assert.doesNotMatch(activeSql, /\bdelete from public\.app_settings\b/i);
  assert.match(rawSql, /--\s*drop table if exists public\.artists;/i);
  assert.match(rawSql, /--\s*delete from public\.app_settings/i);
});
