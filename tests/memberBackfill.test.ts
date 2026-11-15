import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { LineupStore } from '../src/server/lineup/store/types.ts';
import type { FieldSource, LoggedEvent } from '../src/server/events/types.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { overrideActive, runMemberBackfill } from '../src/server/canon/memberBackfill.ts';
import { NOTICE_SETTING, NOTICE_VERSION } from '../src/server/auth/routes.ts';
import { newEvent } from '../src/server/events/service.ts';

const NOW = new Date('2026-11-14T12:00:00Z');
const fresh = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'mb-')));

// A member's personal store as a stand-in for forUser(): events and settings are kept per member.
interface FakeMember {
  userId: string;
  events: LoggedEvent[];
  settings: Map<string, unknown>;
  listCalls: number;
}

const event = (id: string, patch: Partial<LoggedEvent> = {}): LoggedEvent => ({ ...newEvent(patch.name ?? 'Band A', NOW), id, ...patch });
const typedSource: FieldSource = { sourceType: 'user' };
const sourcedElsewhere: FieldSource = { sourceType: 'promoter' };

function accepted(userId: string, events: LoggedEvent[]): FakeMember {
  const settings = new Map<string, unknown>([[NOTICE_SETTING, { version: NOTICE_VERSION, acceptedAt: NOW.toISOString() }]]);
  return { userId, events, settings, listCalls: 0 };
}

function setup(list: FakeMember[]) {
  const forUserCalls: string[] = [];
  const byId = new Map(list.map((m) => [m.userId, m]));
  const scoped = (m: FakeMember) =>
    ({
      async getSetting(key: string) {
        return (m.settings.get(key) ?? null) as never;
      },
      async putSetting(key: string, data: unknown) {
        m.settings.set(key, data);
      },
      async listEvents() {
        m.listCalls++;
        return m.events;
      },
    }) as unknown as LineupStore;
  return {
    forUserCalls,
    run: async (service: FileLineupStore, members: Parameters<typeof runMemberBackfill>[1], opts = {}) => {
      const withScope = Object.assign(service, {
        forUser: ({ userId }: { userId: string }) => {
          forUserCalls.push(userId);
          const m = byId.get(userId);
          return m ? scoped(m) : undefined;
        },
      });
      return runMemberBackfill(withScope as LineupStore, members, opts);
    },
  };
}

test('a member who accepted v2 creates a provisional edition from a dated event: typed venue and city only', async () => {
  const s = await fresh();
  const m = accepted('member-user-Zq92', [
    event('mev-Zq81', {
      name: 'Band A', startDate: '2026-06-01', venue: 'The Hall', city: 'Austin',
      sources: { venue: typedSource, city: typedSource },
      attendance: 'missed', notes: 'secret note', rating: 5, companions: ['Pat'],
    }),
    event('mev-Zq82', {
      name: 'Band B', startDate: '2026-06-02', venue: 'Guessed Hall', city: 'Guessville',
      sources: { venue: sourcedElsewhere, city: sourcedElsewhere },
    }),
  ]);
  const t = setup([m]);
  const r = (await t.run(s, [{ userId: m.userId, role: 'member' }]))!;
  assert.equal(r.created, 2);
  assert.equal(r.remaining, 0);

  const editions = await s.listEditions(10);
  const a = editions.find((e) => e.startDate === '2026-06-01')!;
  assert.equal(a.name, 'Band A');
  assert.equal(a.status, 'provisional');
  assert.equal(a.venue, 'The Hall');
  assert.equal(a.city, 'Austin');
  const changesA = await s.listEditionChanges(a.id);
  assert.ok(changesA.length > 0);
  assert.ok(changesA.every((c) => c.actor === 'member:entry'));

  const b = editions.find((e) => e.startDate === '2026-06-02')!;
  assert.equal(b.status, 'provisional');
  assert.equal(b.venue, undefined, 'a venue the person did not type is not stored');
  assert.equal(b.city, undefined, 'a city the person did not type is not stored');
});

test('a member who has not accepted v2 is not read and creates nothing', async () => {
  const s = await fresh();
  const old = accepted('member-user-old1', [event('mev-old1', { name: 'Band A', startDate: '2026-06-01' })]);
  old.settings.set(NOTICE_SETTING, { version: 1 });
  const none = accepted('member-user-none', [event('mev-none', { name: 'Band C', startDate: '2026-06-03' })]);
  none.settings.delete(NOTICE_SETTING);
  const t = setup([old, none]);
  const r = await t.run(s, [
    { userId: old.userId, role: 'member' },
    { userId: none.userId, role: 'member' },
  ]);
  assert.equal(r, null);
  assert.equal(old.listCalls, 0);
  assert.equal(none.listCalls, 0);
  assert.equal((await s.listEditions(10)).length, 0);
});

test('linked events, undated events and year-only dates are skipped', async () => {
  const s = await fresh();
  const m = accepted('member-user-Zq93', [
    event('mev-link', { name: 'Band A', startDate: '2026-06-01', editionId: 'some-edition' }),
    event('mev-undated', { name: 'Band B' }),
    event('mev-year', { name: 'Band C', year: 2026 }),
    event('mev-month', { name: 'Band D', startDate: '2026-06' }),
  ]);
  const t = setup([m]);
  const r = await t.run(s, [{ userId: m.userId, role: 'member' }]);
  assert.equal(r, null, 'nothing to do returns null');
  assert.equal((await s.listEditions(10)).length, 0);
  assert.deepEqual(m.settings.get('canon_member_backfill'), { done: [], complete: true });
});

test('a second run creates nothing new', async () => {
  const s = await fresh();
  const m = accepted('member-user-Zq94', [event('mev-Zq84', { name: 'Band A', startDate: '2026-06-01', venue: 'The Hall', sources: { venue: typedSource } })]);
  const t = setup([m]);
  const members = [{ userId: m.userId, role: 'member' }];
  assert.equal((await t.run(s, members))!.created, 1);
  assert.equal(await t.run(s, members), null, 'complete: one settings read, nothing to do');
  m.settings.set('canon_member_backfill', { done: [] });
  const again = (await t.run(s, members))!;
  assert.equal(again.created, 0);
  assert.equal(again.matched, 1);
  assert.equal((await s.listEditions(10)).length, 1);
});

test('the edition JSON and its change records hold no user id or event id', async () => {
  const s = await fresh();
  const m = accepted('member-user-Zq95', [
    event('mev-Zq85', { name: 'Band A', startDate: '2026-06-01', venue: 'The Hall', city: 'Austin', sources: { venue: typedSource, city: typedSource } }),
  ]);
  const t = setup([m]);
  await t.run(s, [{ userId: m.userId, role: 'member' }]);
  const [e] = await s.listEditions(10);
  const changes = await s.listEditionChanges(e.id);
  const text = JSON.stringify([e, changes]);
  assert.ok(!text.includes('member-user-Zq95'), 'no user id');
  assert.ok(!text.includes('mev-Zq85'), 'no event id');
});

test('owner and blocked members are never walked; a member without an id is skipped', async () => {
  const s = await fresh();
  const owner = accepted('owner-user-Zq96', [event('mev-own', { name: 'Band A', startDate: '2026-06-01' })]);
  const blocked = accepted('member-user-Zq97', [event('mev-blk', { name: 'Band B', startDate: '2026-06-02' })]);
  const t = setup([owner, blocked]);
  const r = await t.run(s, [
    { userId: owner.userId, role: 'owner' },
    { userId: blocked.userId, role: 'member', blocked: true },
    { userId: null, role: 'member' },
  ]);
  assert.equal(r, null);
  assert.deepEqual(t.forUserCalls, []);
  assert.equal(owner.listCalls, 0);
  assert.equal(blocked.listCalls, 0);
  assert.equal((await s.listEditions(10)).length, 0);
});

test('a few items per run; the rest waits for the next run', async () => {
  const s = await fresh();
  const events = Array.from({ length: 7 }, (_, i) => event(`mev-b${i}`, { name: `Band ${i}`, startDate: `2026-06-0${i + 1}` }));
  const m = accepted('member-user-Zq98', events);
  const t = setup([m]);
  const members = [{ userId: m.userId, role: 'member' }];
  const first = (await t.run(s, members))!;
  assert.equal(first.created, 5);
  assert.equal(first.remaining, 2);
  const second = (await t.run(s, members))!;
  assert.equal(second.created, 2);
  assert.equal(second.remaining, 0);
});

test('owner override: anyNotice walks a member on notice version 1 or with no notice, and creates the provisional edition', async () => {
  const s = await fresh();
  const old = accepted('member-user-ovr1', [event('mev-ovr1', { name: 'Band A', startDate: '2026-06-01' })]);
  old.settings.set(NOTICE_SETTING, { version: 1 });
  const none = accepted('member-user-ovr2', [event('mev-ovr2', { name: 'Band B', startDate: '2026-06-02' })]);
  none.settings.delete(NOTICE_SETTING);
  const t = setup([old, none]);
  const members = [
    { userId: old.userId, role: 'member' },
    { userId: none.userId, role: 'member' },
  ];
  const r = (await t.run(s, members, { anyNotice: true }))!;
  assert.equal(r.created, 2);
  assert.equal(old.listCalls, 1);
  assert.equal(none.listCalls, 1);
  const editions = await s.listEditions(10);
  assert.equal(editions.length, 2);
  assert.ok(editions.every((e) => e.status === 'provisional'));
});

test('owner override off: a member on notice version 1 is still skipped', async () => {
  const s = await fresh();
  const old = accepted('member-user-ovr3', [event('mev-ovr3', { name: 'Band A', startDate: '2026-06-01' })]);
  old.settings.set(NOTICE_SETTING, { version: 1 });
  const t = setup([old]);
  const r = await t.run(s, [{ userId: old.userId, role: 'member' }], { anyNotice: false });
  assert.equal(r, null);
  assert.equal(old.listCalls, 0);
  assert.equal((await s.listEditions(10)).length, 0);
});

test('overrideActive: true only for a future valid until', () => {
  const now = new Date('2026-11-14T12:00:00Z');
  assert.equal(overrideActive({ until: '2026-11-15T00:00:00Z' }, now), true);
  assert.equal(overrideActive({ until: '2026-11-13T00:00:00Z' }, now), false, 'past');
  assert.equal(overrideActive({ until: '2026-11-14T12:00:00Z' }, now), false, 'equal to now is not strictly future');
  assert.equal(overrideActive(null, now), false, 'missing value');
  assert.equal(overrideActive(undefined, now), false, 'missing value');
  assert.equal(overrideActive({}, now), false, 'no until');
  assert.equal(overrideActive({ until: 'next tuesday, probably' }, now), false, 'garbage text');
  assert.equal(overrideActive({ until: 'banana 2099' } as { until: string }, now), false, 'garbage with a year');
});

test('owner override: owner, blocked and id-less members are still skipped', async () => {
  const s = await fresh();
  const owner = accepted('owner-user-ovr4', [event('mev-ovr4', { name: 'Band A', startDate: '2026-06-01' })]);
  owner.settings.set(NOTICE_SETTING, { version: 1 });
  const blocked = accepted('member-user-ovr5', [event('mev-ovr5', { name: 'Band B', startDate: '2026-06-02' })]);
  blocked.settings.set(NOTICE_SETTING, { version: 1 });
  const t = setup([owner, blocked]);
  const r = await t.run(
    s,
    [
      { userId: owner.userId, role: 'owner' },
      { userId: blocked.userId, role: 'member', blocked: true },
      { userId: null, role: 'member' },
    ],
    { anyNotice: true },
  );
  assert.equal(r, null);
  assert.deepEqual(t.forUserCalls, []);
  assert.equal(owner.listCalls, 0);
  assert.equal(blocked.listCalls, 0);
  assert.equal((await s.listEditions(10)).length, 0);
});

test('a spent subrequest budget returns null and reads nothing (the idle case the worker traces)', async () => {
  const s = await fresh();
  const m = accepted('member-user-bud1', [event('mev-bud1', { name: 'Band A', startDate: '2026-06-01' })]);
  const t = setup([m]);
  const r = await t.run(s, [{ userId: m.userId, role: 'member' }], { budgetLeft: () => 5 });
  assert.equal(r, null);
  assert.equal(m.listCalls, 0);
  assert.equal((await s.listEditions(10)).length, 0);
});

test('the cron runs the member backfill before the owner backfill, which spends the whole budget', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../worker/index.ts', import.meta.url), 'utf8');
  const member = src.indexOf('runMemberBackfill(deps.store');
  const owner = src.indexOf('runCanonBackfill(store)');
  assert.ok(member > 0 && owner > 0);
  assert.ok(member < owner);
});

test('worker cron gates backfills on staggered 5-minute slots (% 5 === 0, 1, 2)', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../worker/index.ts', import.meta.url), 'utf8');
  assert.match(src, /now\.getUTCMinutes\(\)\s*%\s*5\s*===\s*1[\s\S]*?runMemberBackfill/);
  assert.match(src, /now\.getUTCMinutes\(\)\s*%\s*5\s*===\s*0[\s\S]*?runCanonBackfill/);
  assert.match(src, /now\.getUTCMinutes\(\)\s*%\s*5\s*===\s*2[\s\S]*?runResearchBackfill/);
});

test('two members entering the same show with no venue make one edition, not one each (KREAM duplicate)', async () => {
  const s = await fresh();
  const a = accepted('member-user-kr01', [event('mev-kr01', { name: 'KREAM', startDate: '2024-12-21' })]);
  const b = accepted('member-user-kr02', [event('mev-kr02', { name: 'KREAM', startDate: '2024-12-21' })]);
  const t = setup([a, b]);
  const r = await t.run(s, [
    { userId: a.userId, role: 'member' },
    { userId: b.userId, role: 'member' },
  ]);
  assert.equal(r?.created, 1);
  assert.equal(r?.matched, 1);
  assert.equal((await s.listEditions(10)).length, 1);
});

test('the same show with two different typed venues stays two editions', async () => {
  const s = await fresh();
  const a = accepted('member-user-vn01', [event('mev-vn01', { name: 'KREAM', startDate: '2024-12-21', venue: 'Club A', sources: { venue: typedSource } })]);
  const b = accepted('member-user-vn02', [event('mev-vn02', { name: 'KREAM', startDate: '2024-12-21', venue: 'Club B', sources: { venue: typedSource } })]);
  const t = setup([a, b]);
  const r = await t.run(s, [
    { userId: a.userId, role: 'member' },
    { userId: b.userId, role: 'member' },
  ]);
  assert.equal(r?.created, 2);
  assert.equal((await s.listEditions(10)).length, 2);
});
