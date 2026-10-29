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
  for (const m of ['0002_source_first_lineups.sql', '0003_event_log.sql', '0004_email_imports.sql', '0006_app_settings.sql', '0014_entities.sql', '0015_share_links.sql', '0016_entity_labels.sql', '0017_members_and_user_id.sql']) db(migration(m));
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
  // Per-member records (0020): own rows only, forged user_id refused, ids may repeat across members.
  db(migration('0020_per_member_entities.sql'));
  const ent = (id: string, user: string, name: string, kind = 'venue') =>
    `insert into user_entities(user_id, id, kind, name, name_normalized) values ('${user}', '${id}', '${kind}', '${name}', '${name.toLowerCase()}');`;
  const V1 = '10000000-0000-4000-8000-000000000001';
  assert.ok(!as(ANN, ent(V1, ANN, 'Forum')).startsWith('ERROR'));
  assert.ok(!as(BOB, ent(V1, BOB, 'Forum')).startsWith('ERROR')); // same id and name, a different member
  assert.match(as(ANN, ent('10000000-0000-4000-8000-000000000002', BOB, 'Sneaky')), /row-level security/);
  assert.equal(as(BOB, `select count(*) from user_entities;`), '1');
  assert.equal(as(OWNER, `select count(*) from user_entities;`), '0');
  assert.match(as(ANN, ent('10000000-0000-4000-8000-000000000003', ANN, 'Forum')), /duplicate key/); // one live name per kind
  // A person with a vault has an encrypted name and no readable one; a plain name cannot sit beside it.
  const P1 = '20000000-0000-4000-8000-000000000001';
  assert.ok(!as(ANN, `insert into user_entities(user_id, id, kind, name_encrypted) values ('${ANN}', '${P1}', 'person', 'v1:aaa:bbb');`).startsWith('ERROR'));
  assert.match(as(ANN, `insert into user_entities(user_id, id, kind, name, name_normalized, name_encrypted) values ('${ANN}', '20000000-0000-4000-8000-000000000002', 'person', 'Jen', 'jen', 'v1:aaa:bbb');`), /violates check constraint/);
  assert.match(as(ANN, `insert into user_entities(user_id, id, kind, name_encrypted) values ('${ANN}', '20000000-0000-4000-8000-000000000003', 'venue', 'v1:aaa:bbb');`), /violates check constraint/);
  // Alias tokens are per member; another member's record cannot be aliased.
  assert.ok(!as(ANN, `insert into user_entity_aliases(user_id, entity_id, kind, companion_token) values ('${ANN}', '${P1}', 'person', 'tok1');`).startsWith('ERROR'));
  assert.match(as(BOB, `insert into user_entity_aliases(user_id, entity_id, kind, companion_token) values ('${BOB}', '${P1}', 'person', 'tok1');`), /foreign key|violates/);
  assert.equal(as(BOB, `select count(*) from user_entity_aliases;`), '0');
  // Events may point at their own records and people only (the trigger replaces the old foreign keys).
  const evWith = (id: string, user: string, cols: string) => `insert into logged_events(id, name, user_id, ${cols.split('=')[0]}) values ('${id}', '${id}', '${user}', ${cols.split('=')[1]});`;
  assert.ok(!as(ANN, evWith('e-ok', ANN, `venue_id='${V1}'`)).startsWith('ERROR'));
  assert.ok(!as(ANN, evWith('e-p', ANN, `person_ids=array['${P1}']::uuid[]`)).startsWith('ERROR'));
  assert.match(as(BOB, evWith('e-bob-p', BOB, `person_ids=array['${P1}']::uuid[]`)), /not one of this user/);
  assert.match(as(BOB, evWith('e-bad', BOB, `venue_id='99999999-0000-4000-8000-000000000009'`)), /does not exist/);
  // Genres, links and history follow the same rule.
  assert.ok(!as(ANN, `insert into user_artist_genres(user_id, artist_key, name, genres) values ('${ANN}', 'moon garden', 'Moon Garden', '[]');`).startsWith('ERROR'));
  assert.equal(as(BOB, `select count(*) from user_artist_genres;`), '0');
  assert.ok(!as(ANN, `insert into user_entity_history(user_id, id, operation, manifest) values ('${ANN}', '30000000-0000-4000-8000-000000000001', 'rename', '{}');`).startsWith('ERROR'));
  assert.equal(as(BOB, `select count(*) from user_entity_history;`), '0');
  // 0021 copies the owner's old records with the same ids; members' rows are untouched.
  psql('concert_rls_test', [], `
    insert into entities(id, kind, name, name_normalized) values ('${V1}', 'venue', 'Forum', 'forum'), ('40000000-0000-4000-8000-000000000001', 'venue', 'The Wiltern', 'the wiltern');
    insert into entities(id, kind, name, name_normalized, merged_into_id) values ('40000000-0000-4000-8000-000000000002', 'venue', 'Wiltern', 'wiltern', '40000000-0000-4000-8000-000000000001');
    insert into entity_aliases(entity_id, kind, alias_normalized) values ('40000000-0000-4000-8000-000000000001', 'venue', 'wiltern theatre');`);
  db(migration('0021_owner_entities_copy.sql'));
  assert.equal(as(OWNER, `select string_agg(name, ',' order by name) from user_entities;`), 'Forum,The Wiltern,Wiltern');
  assert.equal(as(OWNER, `select merged_into_id from user_entities where name = 'Wiltern';`), '40000000-0000-4000-8000-000000000001');
  assert.equal(as(OWNER, `select companion_token from user_entity_aliases;`), 'wiltern theatre');
  assert.equal(as(ANN, `select count(*) from user_entities;`), '2');
  db(migration('0021_owner_entities_copy.sql')); // safe to run twice
  assert.equal(as(OWNER, `select count(*) from user_entities;`), '3');
  // Without a user id in the token nothing is visible.
  assert.equal(as('', `select count(*) from logged_events;`), '0');
  // 0018 left user_id required.
  assert.match(as(OWNER, `insert into logged_events(id, name, user_id) values ('n', 'n', null);`), /null value|row-level security/);
});
