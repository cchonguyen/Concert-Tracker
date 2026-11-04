import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Migration 0037 (canonical artist atomic apply and Undo).
// Part 1 reads the SQL text (static contract). Part 2 runs the functions in a scratch Postgres 16 cluster
// started in a temp directory on a unix socket, and removes that cluster and directory afterwards.
// Part 2 is skipped only when the Postgres binaries are missing; the skip reason is printed.

const migrationPath = fileURLToPath(new URL('../supabase/migrations/0037_canonical_artist_atomic_changes.sql', import.meta.url));
const raw = readFileSync(migrationPath, 'utf8');
// Code only: comment lines are removed so header prose cannot satisfy or break a check.
const code = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

const PUBLIC_FUNCTIONS = ['canonical_artist_fingerprint', 'canonical_apply_artist_change', 'canonical_undo_artist_change'];
const HELPER_FUNCTIONS = [
  'canonical_assert_owner',
  'canonical_json_artist',
  'canonical_json_perf',
  'canonical_json_entity',
  'canonical_json_user_entity',
  'canonical_artist_keys',
  'canonical_artist_lock',
  'canonical_artist_state',
  'canonical_artist_write',
];

// Splits the code into one block per `create or replace function`, keyed by function name.
function functionBlocks(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of source.split(/create or replace function /i).slice(1)) {
    const name = /^(\w+)\(/.exec(part)?.[1];
    assert.ok(name, 'every create or replace function has a name');
    out.set(name, part);
  }
  return out;
}

const blocks = functionBlocks(code);

test('defines the three public functions and their helpers', () => {
  for (const name of [...PUBLIC_FUNCTIONS, ...HELPER_FUNCTIONS]) {
    assert.ok(blocks.has(name), `missing function ${name}`);
  }
});

test('apply takes a fingerprint and a server-built entry, with no client plan parameter', () => {
  assert.match(
    code,
    /create or replace function canonical_apply_artist_change\(p_fingerprint text, p_entry jsonb, p_user_id uuid default null\)/,
  );
  assert.doesNotMatch(code, /\bp_plan\b/, 'no client-built plan parameter');
});

test('every function has a fixed search_path', () => {
  for (const [name, body] of blocks) {
    assert.match(body, /set search_path = public, pg_temp/, `${name} must fix its search_path`);
  }
});

test('security definer is set on every function that reads or writes tables', () => {
  for (const name of [...PUBLIC_FUNCTIONS, ...HELPER_FUNCTIONS.filter((n) => !n.startsWith('canonical_json_') && n !== 'canonical_artist_keys')]) {
    assert.match(blocks.get(name) ?? '', /security definer/, `${name} must be security definer`);
  }
});

test('public and anon execution is revoked on every function', () => {
  for (const name of [...PUBLIC_FUNCTIONS, ...HELPER_FUNCTIONS]) {
    assert.match(code, new RegExp(`revoke all on function ${name}\\([^)]*\\) from public, anon`), `revoke for ${name}`);
  }
});

test('authenticated and service_role are the only roles granted execute, and only on the three public functions', () => {
  const grants = [...code.matchAll(/grant execute on function (\w+)\([^)]*\) to ([^;]+);/g)];
  assert.deepEqual(
    grants.map((g) => g[1]).sort(),
    [...PUBLIC_FUNCTIONS].sort(),
    'grants only the public functions',
  );
  for (const g of grants) assert.equal(g[2].trim(), 'authenticated, service_role', `${g[1]} grants only authenticated and service_role`);
});

test('no table or column changes in the migration', () => {
  assert.doesNotMatch(code, /\bcreate\s+table\b/i);
  assert.doesNotMatch(code, /\balter\s+table\b/i);
  assert.doesNotMatch(code, /\badd\s+column\b/i);
  assert.doesNotMatch(code, /\bdrop\s+(table|column)\b/i);
});

test('owner check reads members with role owner', () => {
  const body = blocks.get('canonical_assert_owner') ?? '';
  assert.match(body, /from members m where m\.user_id = auth\.uid\(\) and m\.role = 'owner'/);
});

test('apply checks the fingerprint and the plan before any write, and raises P0409 on mismatch', () => {
  const body = blocks.get('canonical_apply_artist_change') ?? '';
  const check = body.indexOf('md5(canonical_artist_state');
  const historyWrite = body.indexOf('insert into entity_history');
  const recordWrite = body.indexOf("canonical_artist_write(p_entry, 'before', 'after', p_user_id)");
  assert.ok(check > 0, 'fingerprint check present');
  assert.ok(historyWrite > check, 'history is written only after the check');
  assert.ok(recordWrite > check, 'records are written only after the check');
  assert.match(body, /errcode = 'P0409'/);
  assert.match(body, /Preview is out of date; review it again/);
});

test('apply writes history and records in one function body and never commits or rolls back', () => {
  const body = blocks.get('canonical_apply_artist_change') ?? '';
  assert.match(body, /insert into user_entity_history/);
  assert.match(body, /canonical_artist_write\(p_entry, 'before', 'after', p_user_id\)/);
  assert.doesNotMatch(code, /\b(commit|rollback|savepoint)\b/i, 'the transaction is the function call itself');
});

test('undo checks the current after-state before restoring the before-state', () => {
  const body = blocks.get('canonical_undo_artist_change') ?? '';
  const check = body.indexOf("canonical_artist_state(v_entry, 'db', p_user_id) is distinct from canonical_artist_state(v_entry, 'after', p_user_id)");
  const restore = body.indexOf("canonical_artist_write(v_entry, 'after', 'before', p_user_id)");
  assert.ok(check > 0, 'after-state check present');
  assert.ok(restore > check, 'restore happens after the check');
  assert.match(body, /errcode = 'P0409'/);
});

test('apply and undo write activity_log rows after the seen rewrite, and check the row count', () => {
  const apply = blocks.get('canonical_apply_artist_change') ?? '';
  const undo = blocks.get('canonical_undo_artist_change') ?? '';
  assert.match(apply, /insert into activity_log/);
  assert.match(undo, /insert into activity_log/);
  assert.ok(
    apply.indexOf('insert into activity_log') > apply.indexOf("canonical_artist_write(p_entry, 'before', 'after', p_user_id)"),
    'apply writes activity after the seen rewrite',
  );
  assert.ok(
    undo.indexOf('insert into activity_log') > undo.indexOf("canonical_artist_write(v_entry, 'after', 'before', p_user_id)"),
    'undo writes activity after the seen rewrite',
  );
  assert.equal((apply.match(/get diagnostics v_activity = row_count/g) ?? []).length, 1);
  assert.equal((undo.match(/get diagnostics v_activity = row_count/g) ?? []).length, 1);
});

test('the four canonical operations are the only ones accepted', () => {
  const body = blocks.get('canonical_apply_artist_change') ?? '';
  for (const op of ['canonical-rename', 'canonical-merge', 'canonical-alias-add', 'canonical-alias-remove']) {
    assert.match(body, new RegExp(`'${op}'`));
  }
});

test('the migration header says it is not applied until approved', () => {
  assert.match(raw, /Not applied to the live database until Charlie's go\./);
});

// ---------------------------------------------------------------------------
// Part 2: the functions against a scratch Postgres cluster.
// ---------------------------------------------------------------------------

const PG_BIN = '/opt/homebrew/opt/postgresql@16/bin';
const INITDB = join(PG_BIN, 'initdb');
const PG_CTL = join(PG_BIN, 'pg_ctl');
const PSQL = join(PG_BIN, 'psql');
const missingBinaries = [INITDB, PG_CTL, PSQL].filter((p) => !existsSync(p)).map((p) => basename(p));
export const SKIP_REASON = missingBinaries.length
  ? `Postgres binaries not found (${missingBinaries.join(', ')} under ${PG_BIN}); real-database transaction tests were skipped`
  : '';
if (SKIP_REASON) console.log(`SKIP: ${SKIP_REASON}`);
// macOS refuses to start the server without a valid locale in the environment (the server log says so).
const PG_ENV = { ...process.env, LC_ALL: 'C' };

type Mode = 'single' | 'multi';

const OWNER = '00000000-0000-4000-8000-00000000000a';
const MEMBER = '00000000-0000-4000-8000-00000000000b';
const E1 = '00000000-0000-4000-8000-0000000000e1';
const E2 = '00000000-0000-4000-8000-0000000000e2';
const E3 = '00000000-0000-4000-8000-0000000000e3';
const PERF = '00000000-0000-4000-8000-0000000000f1';
const HISTORY_ID = '00000000-0000-4000-8000-0000000000c1';
const CREATED = '2026-11-03T10:00:00.000Z';
const SEEN_BEFORE = [{ key: 'old artist', name: 'Old Artist', from: 'you', artistId: E1 }];
const SEEN_AFTER = [{ key: 'new artist', name: 'New Artist', from: 'you', artistId: E1 }];

// Minimal schema: only the tables and columns the functions touch (names and types from migrations 0002, 0003, 0014,
// 0017, 0020, 0023, 0029, 0030), without foreign keys beyond what the functions need. auth.uid() and auth.role() are stubs
// that read the request settings Supabase sets. A trigger can force an error on logged_events (test only).
const SCHEMA_SQL = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
create table members (email text primary key, user_id uuid unique, role text not null default 'member' check (role in ('owner', 'member')));
create function owner_user_id() returns uuid language sql stable security definer set search_path = public as $$ select user_id from members where role = 'owner' $$;
create table event_editions (id text primary key);
create table canonical_artists (key text primary key, name text not null, mbid text unique, resolved_at timestamptz);
create table performances (
  id uuid primary key default gen_random_uuid(),
  edition_id text not null references event_editions(id),
  artist_key text not null references canonical_artists(key),
  name text not null,
  days date[] not null default '{}',
  stages text[] not null default '{}',
  status text not null check (status in ('billed', 'performed', 'cancelled')),
  billing text,
  confidence numeric not null,
  sources jsonb not null default '[]',
  slot_id text,
  alias text,
  b2b text[],
  "set" text
);
create table artist_aliases (alias_normalized text primary key, canonical_name text not null);
create table entities (
  id uuid primary key,
  kind text not null,
  name text not null,
  name_normalized text not null,
  attrs jsonb not null default '{}',
  merged_into_id uuid references entities(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index entities_kind_name_live_idx on entities(kind, name_normalized) where merged_into_id is null;
create table entity_aliases (entity_id uuid not null references entities(id), kind text not null, alias_normalized text not null, unique (kind, alias_normalized));
create table entity_links (
  from_id uuid not null references entities(id),
  to_id uuid not null references entities(id),
  role text not null,
  created_at timestamptz not null default now(),
  primary key (from_id, to_id, role)
);
create table entity_history (id uuid primary key, operation text not null, manifest jsonb not null, created_at timestamptz not null default now(), undone_at timestamptz);
create table logged_events (id text primary key, name text not null, seen jsonb not null default '[]', user_id uuid, updated_at timestamptz not null default now());
create table user_entities (
  user_id uuid not null,
  id uuid not null,
  kind text not null,
  name text not null default '',
  name_normalized text not null default '',
  name_encrypted text,
  attrs jsonb not null default '{}',
  merged_into_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create table user_entity_aliases (user_id uuid not null, entity_id uuid not null, kind text not null, companion_token text not null, unique (user_id, kind, companion_token));
create table user_entity_links (user_id uuid not null, from_id uuid not null, to_id uuid not null, role text not null, created_at timestamptz not null default now(), primary key (user_id, from_id, to_id, role));
create table user_entity_history (user_id uuid not null, id uuid not null, operation text not null, manifest jsonb not null, created_at timestamptz not null default now(), undone_at timestamptz, primary key (user_id, id));
create function force_fail() returns trigger language plpgsql as $$
begin
  if current_setting('test.force_fail', true) = 'on' then
    raise exception 'forced failure in logged_events' using errcode = 'XX000';
  end if;
  return new;
end $$;
create trigger logged_events_force_fail before update on logged_events for each row execute function force_fail();
create table activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid default owner_user_id(),
  event_id text,
  action text not null check (action in ('create', 'update', 'delete', 'restore', 'undo')),
  field text,
  before_value jsonb,
  after_value jsonb,
  sensitive boolean not null default false,
  created_at timestamptz not null default now()
);
create function force_activity_fail() returns trigger language plpgsql as $$
begin
  if current_setting('test.force_activity_fail', true) = 'on' then
    raise exception 'forced failure after activity insert' using errcode = 'XX000';
  end if;
  return new;
end $$;
create trigger activity_log_force_fail after insert on activity_log for each row execute function force_activity_fail();
`;

const lit = (v: unknown) => `$j$${JSON.stringify(v)}$j$::jsonb`;

function seedSql(mode: Mode): string {
  const common = `
insert into members (email, user_id, role) values ('owner@example.com', '${OWNER}', 'owner'), ('member@example.com', '${MEMBER}', 'member');
insert into event_editions (id) values ('ed1');
insert into canonical_artists (key, name) values ('old artist', 'Old Artist');
insert into performances (id, edition_id, artist_key, name, status, confidence, days, stages, sources, b2b)
  values ('${PERF}', 'ed1', 'old artist', 'Old Artist', 'billed', 0.9, '{}', '{}', '[]', null);`;
  if (mode === 'single') {
    return `${common}
insert into entities (id, kind, name, name_normalized) values
  ('${E1}', 'artist', 'Old Artist', 'old artist'), ('${E2}', 'series', 'Series Two', 'series two'), ('${E3}', 'series', 'Series Three', 'series three');
insert into entity_links (from_id, to_id, role, created_at) values ('${E1}', '${E2}', 'hosted_by', '2026-01-01T00:00:00Z');
insert into logged_events (id, name, seen, user_id) values ('ev1', 'Show', ${lit(SEEN_BEFORE)}, null);`;
  }
  return `${common}
insert into user_entities (user_id, id, kind, name, name_normalized) values
  ('${OWNER}', '${E1}', 'artist', 'Old Artist', 'old artist'), ('${OWNER}', '${E2}', 'series', 'Series Two', 'series two'), ('${OWNER}', '${E3}', 'series', 'Series Three', 'series three');
insert into user_entity_links (user_id, from_id, to_id, role, created_at) values ('${OWNER}', '${E1}', '${E2}', 'hosted_by', '2026-01-01T00:00:00Z');
insert into logged_events (id, name, seen, user_id) values ('ev1', 'Show', ${lit(SEEN_BEFORE)}, '${OWNER}');`;
}

// The rename entry the planner would build for "Old Artist" -> "New Artist", with the owner record, its alias,
// its link to E2 replaced by a link to E3, and the event's seen text rewritten. Written in the SQL contract's shape.
const perfRow = (artistKey: string) => ({
  id: PERF, edition_id: 'ed1', artist_key: artistKey, name: 'Old Artist', days: [], stages: [], status: 'billed',
  billing: null, confidence: 0.9, sources: [], slot_id: null, alias: null, b2b: null, set: null,
});
const ownerRow = (name: string, norm: string) => ({ id: E1, kind: 'artist', name, name_normalized: norm, attrs: {}, merged_into_id: null });

function renameEntry() {
  return {
    id: HISTORY_ID,
    operation: 'canonical-rename',
    summary: 'Renamed artist "Old Artist" to "New Artist", and your own record',
    createdAt: CREATED,
    canonical: {
      key: 'old artist',
      artists: {
        before: [{ key: 'old artist', name: 'Old Artist', mbid: null, resolved_at: null }],
        after: [{ key: 'new artist', name: 'New Artist', mbid: null, resolved_at: null }],
      },
      performances: { before: [perfRow('old artist')], after: [perfRow('new artist')] },
      aliases: { before: [], after: [{ alias: 'old artist', name: 'New Artist' }] },
      owner: { before: [ownerRow('Old Artist', 'old artist')], after: [ownerRow('New Artist', 'new artist')] },
      ownerTouched: [E1],
      ownerAliases: { before: [], after: [{ entity_id: E1, kind: 'artist', alias: 'old artist' }] },
      ownerLinks: {
        before: [{ from_id: E1, to_id: E2, role: 'hosted_by', created_at: '2026-01-01T00:00:00Z' }],
        after: [{ from_id: E1, to_id: E3, role: 'hosted_by', created_at: CREATED }],
      },
      events: { before: [{ id: 'ev1', seen: SEEN_BEFORE }], after: [{ id: 'ev1', seen: SEEN_AFTER }] },
      activity: [{ event_id: 'ev1', action: 'update', field: 'seen', before: SEEN_BEFORE, after: SEEN_AFTER, sensitive: false }],
    },
  };
}

const uidSql = (uid: string | null) => (uid ? `'${uid}'::uuid` : 'null');
const asUser = (uid: string | null, role = 'authenticated') =>
  `do $$ begin perform set_config('request.jwt.claim.sub', '${uid ?? ''}', false); perform set_config('request.jwt.claim.role', '${role}', false); end $$;`;
const forceFail = `do $$ begin perform set_config('test.force_fail', 'on', false); end $$;`;
const forceActivityFail = `do $$ begin perform set_config('test.force_activity_fail', 'on', false); end $$;`;
const fingerprintSql = (uid: string | null) => `select canonical_artist_fingerprint(${lit(renameEntry())}, ${uidSql(uid)});`;
const applySql = (fp: string, uid: string | null) => `select canonical_apply_artist_change('${fp}', ${lit(renameEntry())}, ${uidSql(uid)});`;
const undoSql = (uid: string | null) => `select canonical_undo_artist_change('${HISTORY_ID}'::uuid, ${uidSql(uid)});`;

// The state of every row the change touches, as JSON. Compared before and after each case.
function snapshot(db: string, mode: Mode): any {
  const t = mode === 'single'
    ? { ents: 'entities', ali: 'entity_aliases', aliCol: 'alias_normalized', lnk: 'entity_links', hist: 'entity_history' }
    : { ents: 'user_entities', ali: 'user_entity_aliases', aliCol: 'companion_token', lnk: 'user_entity_links', hist: 'user_entity_history' };
  const out = run(`
select jsonb_build_object(
  'artists', (select coalesce(jsonb_agg(jsonb_build_object('key', c.key, 'name', c.name, 'mbid', c.mbid, 'resolved_at', c.resolved_at) order by c.key), '[]'::jsonb) from canonical_artists c),
  'performances', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'artist_key', p.artist_key, 'edition_id', p.edition_id) order by p.id), '[]'::jsonb) from performances p),
  'artist_aliases', (select coalesce(jsonb_agg(jsonb_build_object('alias', l.alias_normalized, 'name', l.canonical_name) order by l.alias_normalized), '[]'::jsonb) from artist_aliases l),
  'events', (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'seen', v.seen) order by v.id), '[]'::jsonb) from logged_events v),
  'entities', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'name_normalized', e.name_normalized, 'attrs', e.attrs, 'merged_into_id', e.merged_into_id) order by e.id), '[]'::jsonb) from ${t.ents} e),
  'entity_aliases', (select coalesce(jsonb_agg(jsonb_build_object('entity_id', a.entity_id, 'kind', a.kind, 'alias', a.${t.aliCol}) order by a.entity_id, a.${t.aliCol}), '[]'::jsonb) from ${t.ali} a),
  'entity_links', (select coalesce(jsonb_agg(jsonb_build_object('from_id', l.from_id, 'to_id', l.to_id, 'role', l.role) order by l.from_id, l.to_id, l.role), '[]'::jsonb) from ${t.lnk} l),
  'history', (select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'undone', h.undone_at is not null) order by h.id), '[]'::jsonb) from ${t.hist} h),
  'activity', (select coalesce(jsonb_agg(jsonb_build_object('user_id', a.user_id, 'event_id', a.event_id, 'action', a.action, 'field', a.field, 'before', a.before_value, 'after', a.after_value, 'sensitive', a.sensitive) order by a.event_id, a.action, a.field, a.before_value::text, a.after_value::text), '[]'::jsonb) from activity_log a)
)::text;`, db);
  return JSON.parse(out);
}

// An apply or Undo writes history and activity rows too, so the restore checks compare everything else.
const withoutHistoryAndLog = (s: any) => {
  const { history: _h, activity: _a, ...rest } = s;
  return rest;
};

// The activity_log rows of a scratch database, oldest first.
function activityRows(db: string): any[] {
  return JSON.parse(
    run(
      `select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'event_id', event_id, 'action', action, 'field', field,
  'before', before_value, 'after', after_value, 'sensitive', sensitive,
  'created_at', to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by created_at, event_id), '[]'::jsonb)::text from activity_log;`,
      db,
    ),
  );
}

let cluster: { dir: string; port: number } | null = null;
let counter = 0;

// Runs SQL through psql on the scratch cluster (one session per call). Errors are returned, not thrown, by psql().
function psql(input: string, db = 'postgres'): { ok: boolean; out: string; err: string } {
  assert.ok(cluster, 'cluster is running');
  const r = spawnSync(
    PSQL,
    ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', cluster.dir, '-p', String(cluster.port), '-U', 'postgres', '-d', db],
    { input: `\\set VERBOSITY verbose\n${input}\n`, encoding: 'utf8', env: PG_ENV },
  );
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function run(input: string, db = 'postgres'): string {
  const r = psql(input, db);
  assert.ok(r.ok, `psql failed: ${r.err}`);
  return r.out;
}

// Runs SQL that must fail; returns the error text (with the SQLSTATE, from VERBOSITY verbose).
function refused(input: string, db = 'postgres'): string {
  const r = psql(input, db);
  assert.ok(!r.ok, `expected an error, got output: ${r.out}`);
  return r.err;
}

// A fresh database from the migrated template, seeded for one store mode.
function freshDb(mode: Mode): string {
  const name = `ca_t${++counter}`;
  run(`create database ${name} template ca_template;`);
  run(seedSql(mode), name);
  return name;
}

// Fingerprint, then apply, as the owner in one call each (the fingerprint is the value the client would send back).
function applyAsOwner(db: string, mode: Mode): string {
  const uid = mode === 'single' ? null : OWNER;
  const fp = run(`${asUser(OWNER)}\n${fingerprintSql(uid)}`, db);
  return run(`${asUser(OWNER)}\n${applySql(fp, uid)}`, db);
}

const undoAsOwner = (db: string, mode: Mode) => run(`${asUser(OWNER)}\n${undoSql(mode === 'single' ? null : OWNER)}`, db);

describe('scratch Postgres: migration 0037 transactions', { skip: SKIP_REASON || undefined }, () => {
  before(() => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-pg-'));
    cluster = { dir, port: 52000 + Math.floor(Math.random() * 2000) };
    const data = join(dir, 'data');
    execFileSync(INITDB, ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C'], { stdio: 'ignore', env: PG_ENV });
    execFileSync(
      PG_CTL,
      ['-D', data, '-l', join(dir, 'server.log'), '-o', `-k ${dir} -p ${cluster.port} -c listen_addresses=`, '-w', '-t', '60', 'start'],
      { stdio: 'ignore', env: PG_ENV },
    );
    run('create database ca_template;');
    run(SCHEMA_SQL, 'ca_template');
    run(`\\i ${migrationPath}`, 'ca_template');
  });

  after(() => {
    if (!cluster) return;
    try {
      execFileSync(PG_CTL, ['-D', join(cluster.dir, 'data'), '-m', 'fast', '-w', '-t', '60', 'stop'], { stdio: 'ignore', env: PG_ENV });
    } finally {
      rmSync(cluster.dir, { recursive: true, force: true });
      cluster = null;
    }
  });

  describe('single-user store (entities, entity_history, logged_events)', () => {
    test('a successful apply commits every write: canonical rows, owner record, owner alias and link, event seen text, history', () => {
      const db = freshDb('single');
      const out = JSON.parse(applyAsOwner(db, 'single'));
      assert.equal(out.id, HISTORY_ID);
      const s = snapshot(db, 'single');
      assert.deepEqual(s.artists, [{ key: 'new artist', name: 'New Artist', mbid: null, resolved_at: null }]);
      assert.deepEqual(s.performances.map((p: any) => p.artist_key), ['new artist']);
      assert.deepEqual(s.artist_aliases, [{ alias: 'old artist', name: 'New Artist' }]);
      assert.equal(s.entities.find((e: any) => e.id === E1)?.name, 'New Artist');
      assert.deepEqual(s.entity_aliases, [{ entity_id: E1, kind: 'artist', alias: 'old artist' }]);
      assert.deepEqual(s.entity_links, [{ from_id: E1, to_id: E3, role: 'hosted_by' }]);
      assert.deepEqual(s.events, [{ id: 'ev1', seen: SEEN_AFTER }]);
      assert.deepEqual(s.history, [{ id: HISTORY_ID, undone: false }]);
    });

    test('a fingerprint mismatch raises P0409 and writes nothing', () => {
      const db = freshDb('single');
      const before = snapshot(db, 'single');
      const err = refused(`${asUser(OWNER)}\n${applySql('0'.repeat(32), null)}`, db);
      assert.match(err, /P0409/);
      assert.match(err, /Preview is out of date; review it again/);
      assert.deepEqual(snapshot(db, 'single'), before);
    });

    test('a member, or a caller with no user, is refused with 42501 and writes nothing', () => {
      const db = freshDb('single');
      const before = snapshot(db, 'single');
      const fp = run(`${asUser(OWNER)}\n${fingerprintSql(null)}`, db);
      assert.match(refused(`${asUser(MEMBER)}\n${applySql(fp, null)}`, db), /42501/);
      assert.match(refused(`${asUser(null, 'anon')}\n${applySql(fp, null)}`, db), /42501/);
      assert.deepEqual(snapshot(db, 'single'), before);
    });

    test('a forced error partway through (on the event write, after the canonical and owner writes) rolls back every write', () => {
      const db = freshDb('single');
      const before = snapshot(db, 'single');
      const fp = run(`${asUser(OWNER)}\n${fingerprintSql(null)}`, db);
      const err = refused(`${forceFail}\n${asUser(OWNER)}\n${applySql(fp, null)}`, db);
      assert.match(err, /forced failure in logged_events/);
      assert.deepEqual(snapshot(db, 'single'), before);
    });

    test('undo of a successful apply restores the before-state in one transaction', () => {
      const db = freshDb('single');
      const before = snapshot(db, 'single');
      applyAsOwner(db, 'single');
      const undone = JSON.parse(undoAsOwner(db, 'single'));
      assert.equal(undone.undone, true);
      const after = snapshot(db, 'single');
      assert.deepEqual(withoutHistoryAndLog(after), withoutHistoryAndLog(before));
      assert.deepEqual(after.history, [{ id: HISTORY_ID, undone: true }]);
    });

    test('undo is refused with P0409 when the current state differs from the after-state, and writes nothing', () => {
      const db = freshDb('single');
      applyAsOwner(db, 'single');
      run(`update entities set name = 'Later Name', name_normalized = 'later name' where id = '${E1}';`, db);
      const beforeUndo = snapshot(db, 'single');
      const err = refused(`${asUser(OWNER)}\n${undoSql(null)}`, db);
      assert.match(err, /P0409/);
      assert.match(err, /Those records changed after this/);
      assert.deepEqual(snapshot(db, 'single'), beforeUndo);
      assert.deepEqual(beforeUndo.history, [{ id: HISTORY_ID, undone: false }]);
    });

    test('an undo that fails partway through (forced error on the event write) rolls back every write', () => {
      const db = freshDb('single');
      applyAsOwner(db, 'single');
      const beforeUndo = snapshot(db, 'single');
      const err = refused(`${forceFail}\n${asUser(OWNER)}\n${undoSql(null)}`, db);
      assert.match(err, /forced failure in logged_events/);
      assert.deepEqual(snapshot(db, 'single'), beforeUndo);
    });
    test('a successful apply writes one seen activity row: the stored text before and after, for the owner, at the plan time', () => {
      const db = freshDb('single');
      applyAsOwner(db, 'single');
      assert.deepEqual(activityRows(db), [
        { user_id: OWNER, event_id: 'ev1', action: 'update', field: 'seen', before: SEEN_BEFORE, after: SEEN_AFTER, sensitive: false, created_at: CREATED },
      ]);
    });

    test('a forced failure after the activity insert rolls the activity rows back with every other write', () => {
      const db = freshDb('single');
      const before = snapshot(db, 'single');
      const fp = run(`${asUser(OWNER)}\n${fingerprintSql(null)}`, db);
      const err = refused(`${forceActivityFail}\n${asUser(OWNER)}\n${applySql(fp, null)}`, db);
      assert.match(err, /forced failure after activity insert/);
      assert.deepEqual(activityRows(db), []);
      assert.deepEqual(snapshot(db, 'single'), before);
    });

    test('undo writes one seen activity row holding the text before the undo, and the apply row stays', () => {
      const db = freshDb('single');
      applyAsOwner(db, 'single');
      undoAsOwner(db, 'single');
      const rows = activityRows(db);
      assert.equal(rows.length, 2);
      // jsonb returns object keys in its own order, so match on content rather than on the string.
      const undoRow = rows.find((r) => r.before?.[0]?.key === 'new artist');
      assert.ok(undoRow, 'an undo row holds the text the undo replaced');
      assert.equal(undoRow.action, 'update');
      assert.equal(undoRow.field, 'seen');
      assert.deepEqual(undoRow.after, SEEN_BEFORE);
      assert.equal(undoRow.sensitive, false);
      assert.equal(undoRow.user_id, OWNER);
    });
  });

  describe('multi-user store (user_entities, user_entity_history, logged_events by user_id)', () => {
    test('apply and undo write and restore the owner-side rows for the owner', () => {
      const db = freshDb('multi');
      const before = snapshot(db, 'multi');
      applyAsOwner(db, 'multi');
      const applied = snapshot(db, 'multi');
      assert.equal(applied.entities.find((e: any) => e.id === E1)?.name, 'New Artist');
      assert.deepEqual(applied.entity_aliases, [{ entity_id: E1, kind: 'artist', alias: 'old artist' }]);
      assert.deepEqual(applied.entity_links, [{ from_id: E1, to_id: E3, role: 'hosted_by' }]);
      assert.deepEqual(applied.events, [{ id: 'ev1', seen: SEEN_AFTER }]);
      undoAsOwner(db, 'multi');
      const restored = snapshot(db, 'multi');
      assert.deepEqual(withoutHistoryAndLog(restored), withoutHistoryAndLog(before));
      assert.deepEqual(restored.history, [{ id: HISTORY_ID, undone: true }]);
    });

    test('apply writes its seen activity row for the owner, and undo adds one more', () => {
      const db = freshDb('multi');
      applyAsOwner(db, 'multi');
      assert.deepEqual(
        activityRows(db).map((r) => ({ user_id: r.user_id, event_id: r.event_id, field: r.field, before: r.before, after: r.after })),
        [{ user_id: OWNER, event_id: 'ev1', field: 'seen', before: SEEN_BEFORE, after: SEEN_AFTER }],
      );
      undoAsOwner(db, 'multi');
      assert.equal(activityRows(db).length, 2);
    });
  });
});
