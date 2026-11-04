import { dispatch } from './helpers/testApp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appearancesOf, isOwner, listCanonicalEditions, summarizeEdition, unifyArtists } from '../src/server/entities/canonicalManage.ts';
import { currentMember, runAsMember } from '../src/server/auth/requestScope.ts';
import type { Edition, EditionPerformance } from '../src/server/lineup/types.ts';

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

// ---- Catalog artists as records (GA3) ----------------------------------------

import express from 'express';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { withEntityLinks } from '../src/server/entities/linkingStore.ts';
import { entitiesRouter } from '../src/server/entities/routes.ts';
import { addArtistAka, mergeArtists, removeArtistAka, renameArtist, undoHistory } from '../src/server/entities/canonicalManage.ts';
import { ManageError } from '../src/server/entities/manage.ts';

const OWNER = { role: 'owner', uid: 'u0' } as any;
const MEMBER = { role: 'member', uid: 'u1' } as any;
const asOwner = <T>(store: any, fn: () => Promise<T>) => runAsMember(OWNER, store, fn);

async function freshStore() {
  return withEntityLinks(new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'ga3-'))));
}

const src = (quote: string) => ({ sourceType: 'promoter', sourceUrl: 'https://example.test/lineup', quotedSpan: quote });
const perf = (artistKey: string, quote: string, over: Partial<EditionPerformance> = {}): EditionPerformance => ({
  artistKey,
  name: quote,
  days: [],
  stages: [],
  status: 'billed',
  confidence: 1,
  sources: [src(quote)] as EditionPerformance['sources'],
  ...over,
});

// Two artists to rename or merge, a third with an AKA, and two editions.
async function seeded(store: any) {
  await store.upsertArtist({ key: 'deadmau5', name: 'deadmau5', mbid: 'MB-DEADMAU5' });
  await store.upsertArtist({ key: 'porter', name: 'Porter', mbid: 'MB-PORTER' });
  await store.upsertArtist({ key: 'porter robinson', name: 'Porter Robinson' });
  await store.putAliases({ 'p robinson': 'Porter' });
  await store.upsertEdition(ed({ id: 'e1', key: 'x/2023', year: 2023, name: 'X 2023', performances: [perf('deadmau5', 'deadmau5'), perf('porter', 'Porter at X 2023')] }));
  await store.upsertEdition(
    ed({
      id: 'e2',
      key: 'x/2024',
      year: 2024,
      name: 'X 2024',
      performances: [perf('porter', 'Porter at X 2024'), perf('porter robinson', 'Porter Robinson at X 2024', { billing: 'headliner' })],
    }),
  );
}

// Logged events of members, as the store holds them. Canonical edits must leave them alone.
const LOGGED = { id: 'ev1', name: 'X 2024', year: 2024, startDate: '2024-06-01', companions: [], seen: [{ key: 'deadmau5', name: 'deadmau5', from: 'you' }], updatedAt: AT };

test('rename moves the artist and its editions, keeps the old name as an AKA, and writes a history entry', async () => {
  const store: any = await freshStore();
  await seeded(store);
  const entry = await asOwner(store, () => renameArtist(store, 'deadmau5', 'Joel Zimmerman', AT));
  assert.equal(entry.operation, 'canonical-rename');
  assert.equal(await store.getArtist('deadmau5'), null);
  const moved = await store.getArtist('joel zimmerman');
  assert.equal(moved.name, 'Joel Zimmerman');
  assert.equal(moved.mbid, 'MB-DEADMAU5', 'the MusicBrainz id moves with the artist');
  assert.deepEqual((await store.artistPerformances(['joel zimmerman'])).map((p: any) => p.editionId), ['e1']);
  assert.equal((await store.getAliases())['deadmau5'], 'Joel Zimmerman');
  assert.equal((await store.getEntityHistory(entry.id))?.operation, 'canonical-rename');
});

test('rename refuses a name another artist holds, and changes nothing', async () => {
  const store: any = await freshStore();
  await seeded(store);
  await assert.rejects(
    asOwner(store, () => renameArtist(store, 'porter', 'Porter Robinson', AT)),
    (err: any) => err instanceof ManageError && err.status === 409 && err.conflict?.id === 'porter robinson',
  );
  assert.equal((await store.getArtist('porter'))?.name, 'Porter');
  assert.deepEqual(await store.listEvents(), []);
});

test('merge: the target keeps its MBID; the source name, its AKAs and its editions move to the target', async () => {
  const store: any = await freshStore();
  await seeded(store);
  await asOwner(store, () => mergeArtists(store, 'porter', 'porter robinson', AT));
  assert.equal(await store.getArtist('porter'), null);
  const target = await store.getArtist('porter robinson');
  assert.equal(target.mbid, 'MB-PORTER', 'the target has no MBID, so it takes the source one');
  const rows = await store.artistPerformances(['porter robinson']);
  assert.deepEqual(rows.map((r: any) => r.editionId).sort(), ['e1', 'e2']);
  const e2 = rows.find((r: any) => r.editionId === 'e2');
  assert.equal(e2.billing, 'headliner', 'the target row keeps its own fields');
  assert.equal(e2.sources.length, 2, 'both editions sources are kept');
  const aliases = await store.getAliases();
  assert.equal(aliases['porter'], 'Porter Robinson');
  assert.equal(aliases['p robinson'], 'Porter Robinson', 'AKAs of the source now name the target');
});

test('merge: a target with its own MBID keeps it', async () => {
  const store: any = await freshStore();
  await seeded(store);
  await store.upsertArtist({ key: 'porter robinson', name: 'Porter Robinson', mbid: 'MB-TARGET' });
  await asOwner(store, () => mergeArtists(store, 'porter', 'porter robinson', AT));
  assert.equal((await store.getArtist('porter robinson')).mbid, 'MB-TARGET');
});

test('alias add and remove: an AKA names the artist; a taken AKA is refused', async () => {
  const store: any = await freshStore();
  await seeded(store);
  await asOwner(store, () => addArtistAka(store, 'deadmau5', 'Dead Mau5', AT));
  assert.equal((await store.getAliases())['dead mau5'], 'deadmau5');
  await assert.rejects(asOwner(store, () => addArtistAka(store, 'deadmau5', 'Dead Mau5', AT)), (e: any) => e.status === 400);
  await assert.rejects(asOwner(store, () => addArtistAka(store, 'deadmau5', 'Porter', AT)), (e: any) => e.status === 409 && e.conflict.id === 'porter');
  await asOwner(store, () => removeArtistAka(store, 'deadmau5', 'Dead Mau5', AT));
  assert.equal((await store.getAliases())['dead mau5'], undefined);
  await assert.rejects(asOwner(store, () => removeArtistAka(store, 'deadmau5', 'Dead Mau5', AT)), (e: any) => e.status === 404);
});

test('undo puts back a rename, a merge and an AKA change, and a change can be undone once', async () => {
  const store: any = await freshStore();
  await seeded(store);
  const renamed = await asOwner(store, () => renameArtist(store, 'deadmau5', 'Joel Zimmerman', AT));
  await asOwner(store, () => undoHistory(store, renamed.id, AT));
  assert.equal((await store.getArtist('deadmau5'))?.mbid, 'MB-DEADMAU5');
  assert.equal((await store.getAliases())['deadmau5'], undefined);
  assert.deepEqual((await store.artistPerformances(['deadmau5'])).map((p: any) => p.editionId), ['e1']);
  await assert.rejects(asOwner(store, () => undoHistory(store, renamed.id, AT)), (e: any) => e.status === 409);

  const merged = await asOwner(store, () => mergeArtists(store, 'porter', 'porter robinson', AT));
  await asOwner(store, () => undoHistory(store, merged.id, AT));
  const source = await store.getArtist('porter');
  assert.equal(source.name, 'Porter');
  assert.equal(source.mbid, 'MB-PORTER', 'the source gets its MBID back');
  assert.equal((await store.getArtist('porter robinson')).mbid, undefined);
  assert.deepEqual((await store.artistPerformances(['porter'])).map((p: any) => p.editionId).sort(), ['e1', 'e2']);
  assert.equal((await store.artistPerformances(['porter robinson'])).find((p: any) => p.editionId === 'e2')?.sources.length, 1);
  assert.equal((await store.getAliases())['porter'], undefined);
  assert.equal((await store.getAliases())['p robinson'], 'Porter');

  const added = await asOwner(store, () => addArtistAka(store, 'deadmau5', 'Dead Mau5', AT));
  await asOwner(store, () => undoHistory(store, added.id, AT));
  assert.equal((await store.getAliases())['dead mau5'], undefined);
});

test('undo is refused when the records changed after the change, and the later change must be undone first', async () => {
  const store: any = await freshStore();
  await seeded(store);
  const first = await asOwner(store, () => renameArtist(store, 'deadmau5', 'Joel Zimmerman', AT));
  await asOwner(store, () => renameArtist(store, 'joel zimmerman', 'Joel Z', AT));
  await assert.rejects(asOwner(store, () => undoHistory(store, first.id, AT)), (e: any) => e.status === 409 && /changed after/.test(e.message));
});

test('owner only: members cannot undo an artist change, and get 403 on the artist routes', async () => {
  const store: any = await freshStore();
  await seeded(store);
  const renamed = await asOwner(store, () => renameArtist(store, 'deadmau5', 'Joel Zimmerman', AT));
  await runAsMember(MEMBER, store, async () => {
    await assert.rejects(undoHistory(store, renamed.id, AT), (e: any) => e.status === 403);
  });

  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runAsMember(MEMBER, store, next));
  app.use('/api', entitiesRouter({ store } as any));
  const calls = [
    dispatch(app, { method: 'PATCH', url: '/api/manage/canonical/artists/porter', headers: { 'content-type': 'application/json' }, body: { name: 'P' } }),
    dispatch(app, { method: 'POST', url: '/api/manage/canonical/artists/porter/merge', headers: { 'content-type': 'application/json' }, body: { into: 'porter robinson' } }),
    dispatch(app, { method: 'POST', url: '/api/manage/canonical/artists/porter/aliases', headers: { 'content-type': 'application/json' }, body: { name: 'P' } }),
    dispatch(app, { method: 'DELETE', url: '/api/manage/canonical/artists/porter/aliases?name=P' }),
  ];
  for (const res of await Promise.all(calls)) assert.equal(res.status, 403);
  assert.equal((await store.getArtist('joel zimmerman'))?.name, 'Joel Zimmerman', 'a refused call changes nothing');
});

test('owner routes: rename over HTTP, with the AKAs on the detail', async () => {
  const store: any = await freshStore();
  await seeded(store);
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runAsMember(OWNER, store, next));
  app.use('/api', entitiesRouter({ store } as any));
  const renamed = await dispatch(app, {
    method: 'PATCH',
    url: '/api/manage/canonical/artists/deadmau5',
    headers: { 'content-type': 'application/json' },
    body: { name: 'Joel Zimmerman' },
  });
  assert.equal(renamed.status, 200);
  const { entry } = renamed.json<{ entry: { operation: string } }>();
  assert.equal(entry.operation, 'canonical-rename');
  const detail = (await dispatch(app, { url: '/api/manage/canonical/artists/joel%20zimmerman' })).json<{ artist: { akas: string[]; name: string } }>();
  assert.equal(detail.artist.name, 'Joel Zimmerman');
  assert.deepEqual(detail.artist.akas, ['deadmau5']);
});

test('canonical edits never write logged_events or a member\'s seen text', async () => {
  // The raw store, not the linked view: linking shows canonical names at read time, and stores nothing.
  const base = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'ga3-raw-')));
  const store: any = withEntityLinks(base);
  await seeded(store);
  // Written raw: linking on save would create the owner's own artist record, which the rename then follows.
  await base.putEvents([LOGGED as any]);
  const before = JSON.stringify(await base.listEvents());
  await asOwner(store, () => renameArtist(store, 'deadmau5', 'Joel Zimmerman', AT));
  await asOwner(store, () => mergeArtists(store, 'porter', 'porter robinson', AT));
  await asOwner(store, () => addArtistAka(store, 'porter robinson', 'PR', AT));
  assert.equal(JSON.stringify(await base.listEvents()), before);
});

test('the owner\'s own artist record follows a rename, and undo puts it back', async () => {
  const store: any = await freshStore();
  await seeded(store);
  await store.addEntities([{ id: 'ent-1', kind: 'artist', name: 'deadmau5', nameNormalized: 'deadmau5', attrs: {}, createdAt: AT, updatedAt: AT }]);
  const entry = await asOwner(store, () => renameArtist(store, 'deadmau5', 'Joel Zimmerman', AT));
  assert.equal((await store.listEntities()).find((e: any) => e.id === 'ent-1')?.name, 'Joel Zimmerman');
  await asOwner(store, () => undoHistory(store, entry.id, AT));
  assert.equal((await store.listEntities()).find((e: any) => e.id === 'ent-1')?.name, 'deadmau5');
});
