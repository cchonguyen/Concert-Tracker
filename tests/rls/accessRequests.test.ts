import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Request access (migration 0024) against a real Postgres. Skipped unless RLS_PG
// names a server where a scratch database may be made (see rls.test.ts). The
// functions must answer the server (service_role) and refuse the anon and
// authenticated keys, so nothing a browser holds can approve or ban anyone.

const pg = process.env.RLS_PG;
const env = pg ? { ...process.env, ...Object.fromEntries(pg.split(/\s+/).map((kv) => kv.split('='))) } : process.env;
const migration = (name: string) => path.resolve('supabase/migrations', name);
const psql = (db: string, args: string[], input?: string) => execFileSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', db, ...args], { env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const DB = 'concert_access_test';

// Runs sql as the given role; returns the output, or the error text.
function as(role: string, sql: string): string {
  try {
    return psql(DB, [], `set role ${role}; ${sql}`).trim();
  } catch (err: any) {
    return `ERROR ${String(err.stderr ?? err.message)}`;
  }
}
const one = (sql: string) => as('service_role', sql);

test('access requests: the functions answer only the server, and each transition changes both tables', { skip: !pg && 'set RLS_PG to run' }, () => {
  psql('postgres', ['-c', `drop database if exists ${DB}`, '-c', `create database ${DB}`]);
  psql(DB, ['-f', path.resolve('tests/rls/stub.sql')]);
  for (const m of ['0002_source_first_lineups.sql', '0003_event_log.sql', '0004_email_imports.sql', '0006_app_settings.sql', '0014_entities.sql', '0015_share_links.sql', '0016_entity_labels.sql', '0017_members_and_user_id.sql']) psql(DB, ['-f', migration(m)]);
  psql(DB, [], `insert into members(email, role) values ('owner@x', 'owner'), ('ann@x', 'member');`);
  psql(DB, ['-f', migration('0024_access_requests.sql')]);

  // The anon and authenticated keys cannot call any of the four functions.
  for (const role of ['anon', 'authenticated']) {
    assert.match(as(role, `select access_request_submit('new@x', null);`), /permission denied/);
    assert.match(as(role, `select access_request_state('new@x', null);`), /permission denied/);
    assert.match(as(role, `select access_request_set('new@x', 'accepted', 'invited');`), /permission denied/);
    assert.match(as(role, `select access_request_removed('ann@x', 'owner');`), /permission denied/);
  }

  // The backfill: existing members are accepted, as invited.
  assert.equal(one(`select status || ' ' || source from access_requests where email = 'ann@x';`), 'accepted invited');
  assert.equal(one(`select status from access_requests where email = 'owner@x';`), 'accepted');

  // A stranger asks once; a second press changes nothing.
  assert.equal(one(`select access_request_submit('bob@x', 'sub-bob');`), 'sent');
  assert.equal(one(`select access_request_submit('bob@x', 'sub-bob');`), 'sent');
  assert.equal(one(`select count(*) from access_requests where email = 'bob@x';`), '1');
  assert.equal(one(`select access_request_state('bob@x', null);`), 'sent');
  assert.equal(one(`select access_request_state('zed@x', null);`), 'none');

  // Approving makes a member with a fresh row, and the owner's row cannot be changed.
  one(`select access_request_set('bob@x', 'accepted', 'invited');`);
  assert.equal(one(`select status || ' ' || source from access_requests where email = 'bob@x';`), 'accepted requested');
  assert.equal(one(`select blocked from members where email = 'bob@x';`), 'f');
  assert.match(one(`select access_request_set('owner@x', 'declined', 'blocked');`), /owner cannot be changed/);

  // Blocking keeps the member's row and marks it blocked; the request says sent.
  one(`select access_request_set('ann@x', 'declined', 'blocked');`);
  assert.equal(one(`select status from access_requests where email = 'ann@x';`), 'declined');
  assert.equal(one(`select blocked from members where email = 'ann@x';`), 't');
  assert.equal(one(`select count(*) from members where email = 'ann@x';`), '1');
  assert.equal(one(`select access_request_submit('ann@x', null);`), 'sent');
  assert.equal(one(`select status from access_requests where email = 'ann@x';`), 'declined');

  // Unblocking through an invite upserts the member row.
  one(`select access_request_set('ann@x', 'accepted', 'invited');`);
  assert.equal(one(`select blocked from members where email = 'ann@x';`), 'f');

  // A ban is silent and lifetime: a new email with the same Access sub gets sent, no row.
  one(`select access_request_set('bob@x', 'declined', 'blocked');`);
  assert.equal(one(`select access_request_submit('bob2@x', 'sub-bob');`), 'sent');
  assert.equal(one(`select count(*) from access_requests where email = 'bob2@x';`), '0');
  assert.equal(one(`select access_request_state('bob2@x', 'sub-bob');`), 'sent');

  // The owner removes a member's data: declined. A member who leaves: left, and may ask again.
  one(`delete from members where email = 'ann@x'; select access_request_removed('ann@x', 'owner');`);
  assert.equal(one(`select status from access_requests where email = 'ann@x';`), 'declined');
  one(`insert into members(email, role) values ('cy@x', 'member'); select access_request_set('cy@x', 'accepted', 'invited');`);
  one(`delete from members where email = 'cy@x'; select access_request_removed('cy@x', 'self');`);
  assert.equal(one(`select status from access_requests where email = 'cy@x';`), 'left');
  assert.equal(one(`select access_request_submit('cy@x', null);`), 'sent');
  assert.equal(one(`select status from access_requests where email = 'cy@x';`), 'pending');

  // The pending cap and the pause switch close requests; lowering the cap closes at once.
  one(`update app_settings set data = '{"paused": false, "cap": 1}' where key = 'access_requests';`);
  assert.equal(one(`select access_request_submit('dan@x', null);`), 'closed');
  assert.equal(one(`select access_request_state('dan@x', null);`), 'closed');
  one(`update app_settings set data = '{"paused": false, "cap": 20}' where key = 'access_requests';`);
  assert.equal(one(`select access_request_submit('dan@x', null);`), 'sent');
  one(`update app_settings set data = '{"paused": true, "cap": 20}' where key = 'access_requests';`);
  assert.equal(one(`select access_request_submit('eve@x', null);`), 'closed');
  assert.equal(one(`select count(*) from access_requests where email = 'eve@x';`), '0');
});
