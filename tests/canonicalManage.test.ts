import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appearancesOf, isOwner, listCanonicalEditions, summarizeEdition, unifyArtists } from '../src/server/entities/canonicalManage.ts';
import { currentMember, runAsMember } from '../src/server/auth/requestScope.ts';
import type { Edition } from '../src/server/lineup/types.ts';

const AT = '2026-11-03T00:00:00.000Z';
const ed = (over: Partial<Edition> = {}): Edition => ({
  id: 'e',
  key: 'x/2024',
  seriesSlug: 'x',
  year: 2024,
  name: 'X 2024',
  status: 'confirmed',
  performances: [],
  updatedAt: AT,
  ...over,
});

test('summary carries only shared edition facts', () => {
  const s = summarizeEdition(ed({ startDate: '2024-09-28', venue: 'Pier 80', city: 'San Francisco, CA' }));
  assert.deepEqual(Object.keys(s).sort(), [
    'city', 'endDate', 'hasSetTimes', 'id', 'key', 'name', 'performanceCount', 'seriesSlug', 'startDate', 'status', 'venue', 'year',
  ]);
  assert.equal(s.endDate, null);
  assert.equal(s.venue, 'Pier 80');
});

test('set times are reported only where a source gave days or stages', () => {
  const perf = { artistKey: 'a', name: 'A', days: [], stages: [], status: 'billed' as const, confidence: 1, sources: [] } as any;
  assert.equal(summarizeEdition(ed({ performances: [perf] })).hasSetTimes, false);
  assert.equal(summarizeEdition(ed({ performances: [{ ...perf, stages: ['Main'] }] })).hasSetTimes, true);
});

test('status filter shows only confirmed or only drafts when asked', () => {
  const list = [ed({ id: 'c', status: 'confirmed' }), ed({ id: 'd', status: 'draft', name: 'D 2024' })];
  assert.deepEqual(listCanonicalEditions(list, { status: 'confirmed' }).map((e) => e.id), ['c']);
  assert.deepEqual(listCanonicalEditions(list, { status: 'draft' }).map((e) => e.id), ['d']);
  assert.equal(listCanonicalEditions(list).length, 2);
});

test('query matches name, series or venue, ignoring case', () => {
  const list = [ed({ id: 'a', name: 'Portola 2024', venue: 'Pier 80' }), ed({ id: 'b', name: 'EDC 2024', seriesSlug: 'edc' })];
  assert.deepEqual(listCanonicalEditions(list, { query: 'pier' }).map((e) => e.id), ['a']);
  assert.deepEqual(listCanonicalEditions(list, { query: 'EDC' }).map((e) => e.id), ['b']);
});

test('newest year first, then name', () => {
  const list = [ed({ id: 'old', year: 2023, name: 'A' }), ed({ id: 'b', year: 2024, name: 'B' }), ed({ id: 'a', year: 2024, name: 'A' })];
  assert.deepEqual(listCanonicalEditions(list).map((e) => e.id), ['a', 'b', 'old']);
});

test('artists: origins from the owner and canonical layers; community count stays unknown', () => {
  const canonical = [{ key: 'porter robinson', name: 'Porter Robinson', mbid: 'c4393710' }, { key: 'rufus du sol', name: 'Rüfüs Du Sol' }];
  const edition = ed({
    status: 'confirmed',
    performances: [
      { artistKey: 'porter robinson', name: 'Porter Robinson', days: [], stages: [], status: 'billed', confidence: 1, sources: [] } as any,
      { artistKey: 'porter robinson', name: 'Porter Robinson', days: [], stages: [], status: 'billed', confidence: 1, sources: [] } as any,
    ],
  });
  const rows = unifyArtists({ canonical, ownerNames: ['Porter Robinson', 'Only Me'], editions: [edition] });
  const pr = rows.find((r) => r.key === 'porter robinson')!;
  assert.deepEqual(pr.origins, ['unmanaged_fetch', 'from_me']);
  assert.equal(pr.editionsCount, 2);
  assert.equal(pr.mbid, 'c4393710');
  assert.equal(pr.communityCount, null);
  assert.deepEqual(rows.find((r) => r.key === 'only me')!.origins, ['from_me']);
});

test('artists: performances in draft editions are not counted', () => {
  const draft = ed({ status: 'draft', performances: [{ artistKey: 'a', name: 'A', days: [], stages: [], status: 'billed', confidence: 1, sources: [] } as any] });
  const rows = unifyArtists({ canonical: [{ key: 'a', name: 'A' }], ownerNames: [], editions: [draft] });
  assert.equal(rows[0].editionsCount, 0);
});

test('owner guard: only the owner passes; members and anonymous requests do not', async () => {
  const store = {} as any;
  assert.equal(isOwner(null), false);
  assert.equal(isOwner(currentMember()), false);
  await runAsMember({ role: 'member', uid: 'u1' } as any, store, () => assert.equal(isOwner(currentMember()), false));
  await runAsMember({ role: 'owner', uid: 'u0' } as any, store, () => assert.equal(isOwner(currentMember()), true));
});

test('appearances: one artist across editions, newest first, billing and set per edition', () => {
  const perf = (artistKey: string, over: any = {}) => ({ artistKey, name: artistKey, days: [], stages: [], status: 'billed', confidence: 1, sources: [], ...over });
  const old = ed({ id: 'o', name: 'Old', year: 2023, performances: [perf('a', { billing: 'support' }), perf('b')] });
  const newer = ed({ id: 'n', name: 'New', year: 2024, performances: [perf('a', { set: 'DJ Set' })] });
  const rows = appearancesOf([old, newer], 'a');
  assert.deepEqual(rows.map((r) => r.editionId), ['n', 'o']);
  assert.equal(rows[0].set, 'DJ Set');
  assert.equal(rows[1].billing, 'support');
  assert.deepEqual(appearancesOf([old, newer], 'zzz'), []);
});

test('unifyArtists: community counts fill in per key; without counts it stays null', async () => {
  const canonical = [{ key: 'porter robinson', name: 'Porter Robinson' } as any];
  const withCounts = unifyArtists({
    canonical,
    ownerNames: ['Only Me'],
    editions: [],
    communityCounts: new Map([['porter robinson', 4]]),
  });
  assert.equal(withCounts.find((r) => r.key === 'porter robinson')!.communityCount, 4);
  assert.equal(withCounts.find((r) => r.key === 'only me')!.communityCount, 0, 'no live event has it: zero, not unknown');
  const without = unifyArtists({ canonical, ownerNames: [], editions: [], communityCounts: null });
  assert.equal(without[0].communityCount, null);
});
