import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Row level security against a real Postgres. Skipped unless RLS_PG names a
// server where a scratch database may be made, as psql environment settings,
// e.g. RLS_PG="PGHOST=/tmp/pgt PGPORT=5544 PGUSER=pgtest". It builds the
// database `concert_rls_test` from tests/rls/stub.sql (a minimal Supabase) and
// the migrations in order, then queries as the `authenticated` role with a
// member's id in the JWT claims, the way a member's request reaches Postgres.

const pg = process.env.RLS_PG;
const env = pg ? { ...process.env, ...Object.fromEntries(pg.split(/\s+/).map((kv) => kv.split('='))) } : process.env;
const migration = (name: string) => path.resolve('supabase/migrations', name);
const psql = (db: string, args: string[], input?: string) => execFileSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', db, ...args], { env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

const OWNER = '00000000-0000-0000-0000-000000000001';
const ANN = '00000000-0000-0000-0000-000000000002';
const BOB = '00000000-0000-0000-0000-000000000003';

// Runs sql as `authenticated` with this member's claims; returns output, or the error text.
function as(user: string, sql: string): string {
  try {
    return psql('concert_rls_test', [], `set role authenticated; set request.jwt.claim.sub = '${user}'; ${sql}`).trim();
  } catch (err: any) {
    return `ERROR ${String(err.stderr ?? err.message)}`;
  }
}

test('row level security: members see and change only their own rows', { skip: !pg && 'set RLS_PG to run' }, () => {
  psql('postgres', ['-c', 'drop database if exists concert_rls_test', '-c', 'create database concert_rls_test']);
  const db = (file: string) => psql('concert_rls_test', ['-f', file]);
  db(path.resolve('tests/rls/stub.sql'));
  for (const m of ['0002_source_first_lineups.sql', '0003_event_log.sql', '0004_email_imports.sql', '0006_app_settings.sql', '0015_share_links.sql', '0017_members_and_user_id.sql']) db(migration(m));
  psql('concert_rls_test', [], `
    insert into auth.users(id, email) values ('${OWNER}','owner@x'), ('${ANN}','ann@x'), ('${BOB}','bob@x');
    insert into members(email, user_id, role) values ('owner@x','${OWNER}','owner'), ('ann@x','${ANN}','member'), ('bob@x','${BOB}','member');
    insert into logged_events(id, name) values ('before', 'Written before multi-user');
    insert into email_imports(id, key, status, data) values ('imp-old', 'k-old', 'new', '{}');`);
  // 0017 defaults old and single-owner rows to the owner.
  assert.equal(psql('concert_rls_test', [], `select user_id from logged_events where id = 'before'`).trim(), OWNER);
  db(migration('0018_user_id_backfill.sql'));

  const row = (id: string, user: string) => `insert into logged_events(id, name, user_id) values ('${id}', '${id}', '${user}');`;
  assert.ok(!as(ANN, row('a1', ANN)).startsWith('ERROR'));
  assert.ok(!as(BOB, row('b1', BOB)).startsWith('ERROR'));
  // Own rows only; the owner's old row and the other member's are invisible.
  assert.equal(as(ANN, `select string_agg(id, ',' order by id) from logged_events;`), 'a1');
  assert.equal(as(BOB, `select string_agg(id, ',' order by id) from logged_events;`), 'b1');
  assert.equal(as(OWNER, `select string_agg(id, ',' order by id) from logged_events;`), 'before');
  // A forged user_id, a takeover of someone else's row, and a delete of it do nothing or fail.
  assert.match(as(ANN, row('forged', BOB)), /row-level security/);
  assert.equal(as(ANN, `update logged_events set name = 'hijack' where id = 'b1'; select count(*) from logged_events where name = 'hijack';`), '0');
  assert.match(as(ANN, `insert into logged_events(id, name, user_id) values ('b1', 'steal', '${ANN}') on conflict (id) do update set user_id = excluded.user_id, name = excluded.name;`), /row-level security/);
  as(ANN, `delete from logged_events where id = 'b1';`);
  assert.equal(psql('concert_rls_test', [], `select name from logged_events where id = 'b1'`).trim(), 'b1');
  // The same email-import key for two members is allowed (unique per member), but not twice for one.
  const imp = (id: string, user: string) => `insert into email_imports(id, key, status, data, user_id) values ('${id}', 'same-key', 'new', '{}', '${user}');`;
  assert.ok(!as(ANN, imp('i-ann', ANN)).startsWith('ERROR'));
  assert.ok(!as(BOB, imp('i-bob', BOB)).startsWith('ERROR'));
  assert.match(as(ANN, imp('i-ann2', ANN)), /duplicate key/);
  assert.equal(as(ANN, `select id from email_imports;`), 'i-ann');
  // Jobs, share links and settings follow the same rule.
  assert.ok(!as(ANN, `insert into share_links(id, code_hash, settings, user_id) values ('s-ann', 'h-ann', '{}', '${ANN}');`).startsWith('ERROR'));
  assert.equal(as(BOB, `select count(*) from share_links;`), '0');
  assert.ok(!as(ANN, `insert into user_settings(user_id, key, data) values ('${ANN}', 'displayName', '"Ann"');`).startsWith('ERROR'));
  assert.equal(as(BOB, `select count(*) from user_settings;`), '0');
  assert.match(as(BOB, `insert into user_settings(user_id, key, data) values ('${ANN}', 'x', '1');`), /row-level security/);
  // The invite list is invisible to every member, the owner included.
  assert.equal(as(ANN, `select count(*) from members;`), '0');
  assert.equal(as(OWNER, `select count(*) from members;`), '0');
  // Without a user id in the token nothing is visible.
  assert.equal(as('', `select count(*) from logged_events;`), '0');
  // 0018 left user_id required.
  assert.match(as(OWNER, `insert into logged_events(id, name, user_id) values ('n', 'n', null);`), /null value|row-level security/);
});
