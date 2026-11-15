import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { withEntityLinks } from '../src/server/entities/linkingStore.ts';
import { entitiesRouter } from '../src/server/entities/routes.ts';
import { lineupRouter } from '../src/server/lineup/routes.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';
import { writeEdition, undoEditionChange } from '../src/server/canon/editions.ts';
import { editionCoversDate, findSeriesEditionMatches, findVerifiedEdition, matchEdition } from '../src/server/canon/match.ts';
import { dedupeProvisionalEditions } from '../src/server/canon/dedupeProvisional.ts';
import {
  CanonicalInputError,
  confirmCanonicalEdition,
  editEditionFacts,
  mergeCanonicalEditions,
  parseCanonicalInput,
  parseEditionFacts,
} from '../src/server/lineup/canonicalIngest.ts';
import type { Edition, EditionPerformance } from '../src/server/lineup/types.ts';
import { newEvent } from '../src/server/events/service.ts';

async function withFileStore(fn: (store: FileLineupStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sw-api-'));
  try {
    await fn(new FileLineupStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const perf = (artistKey: string, name: string): EditionPerformance => ({
  artistKey,
  name,
  days: [],
  stages: [],
  status: 'billed',
  confidence: 0.9,
  sources: [{ sourceType: 'promoter', sourceUrl: 'https://fest.example', quotedSpan: name, evidence: 'billed', extractor: 'user' }],
});

const ed = (id: string, name: string, year: number, over: Partial<Edition> = {}): Edition => ({
  id,
  key: `${id}/${year}`,
  year,
  name,
  status: 'verified',
  updatedAt: '2026-01-01T00:00:00.000Z',
  performances: [],
  ...over,
});

function makeApp(store: FileLineupStore, role: 'owner' | 'member' = 'owner') {
  const linked = withEntityLinks(store);
  const deps = { store: linked, now: () => new Date('2026-11-15T00:00:00.000Z') } as any;
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runAsMember({ role, uid: role === 'owner' ? 'u0' : 'u1' } as any, linked as any, next));
  app.use('/api', entitiesRouter(deps));
  app.use('/api', lineupRouter(deps, { kick: async () => undefined } as any));
  return app;
}

test('writeEdition and undoEditionChange audit and restore region, seriesSlug, and weekends', async () => {
  await withFileStore(async (store) => {
    await store.upsertSeries({ slug: 'coachella', name: 'Coachella Valley Music and Arts Festival' });
    const w1 = { weekend: 1, startDate: '2024-04-12', endDate: '2024-04-14' };
    const w2 = { weekend: 2, startDate: '2024-04-19', endDate: '2024-04-21' };
    await writeEdition(store, {
      edition: ed('c24', 'Coachella 2024', 2024, { region: 'CA', seriesSlug: 'coachella', weekends: [w1] }),
      actor: 'owner',
      reason: 'seed',
    });

    // Identical weekends array should not record a spurious change.
    const noop = await writeEdition(store, {
      edition: ed('c24', 'Coachella 2024', 2024, { region: 'CA', seriesSlug: 'coachella', weekends: [{ ...w1 }] }),
      actor: 'owner',
      reason: 'noop',
    });
    assert.equal(noop.changed, false);

    // Update region, detach seriesSlug, and configure 2 weekends.
    const w = await writeEdition(store, {
      edition: ed('c24', 'Coachella 2024', 2024, { region: 'California', seriesSlug: undefined, weekends: [w1, w2] }),
      actor: 'owner',
      reason: 'update',
    });
    assert.equal(w.changed, true);
    assert.deepEqual(w.change!.before, { region: 'CA', seriesSlug: 'coachella', weekends: [w1] });
    assert.deepEqual(w.change!.after, { region: 'California', seriesSlug: null, weekends: [w1, w2] });

    const undone = await undoEditionChange(store, 'c24', w.change!.id, 'owner');
    assert.equal(undone.ok, true);
    const restored = await store.getEdition('c24');
    assert.equal(restored?.region, 'CA');
    assert.equal(restored?.seriesSlug, 'coachella');
    assert.deepEqual(restored?.weekends, [w1]);
  });
});

test('matchEdition, findVerifiedEdition, and dedupeProvisionalEditions use listEditionHeaders (not listEditions) and cover multi-weekend dates', async () => {
  await withFileStore(async (store) => {
    await store.upsertSeries({
      slug: 'coachella',
      name: 'Coachella Valley Music and Arts Festival',
      brand: 'Goldenvoice',
      aliases: ['Chella'],
    });
    const w1 = { weekend: 1, startDate: '2024-04-12', endDate: '2024-04-14' };
    const w2 = { weekend: 2, startDate: '2024-04-19', endDate: '2024-04-21' };
    await writeEdition(store, {
      edition: ed('c24', 'Coachella 2024', 2024, {
        seriesSlug: 'coachella',
        subjectKey: 'coachella',
        startDate: '2024-04-12',
        endDate: '2024-04-21',
        venue: 'Empire Polo Club',
        city: 'Indio, CA',
        weekends: [w1, w2],
        performances: [perf('justice', 'Justice')],
      }),
      actor: 'owner',
      reason: 'seed',
    });

    await writeEdition(store, {
      edition: ed('p1', 'Dup Show', 2024, { status: 'provisional', startDate: '2024-08-01', subjectKey: 'dup-show' }),
      actor: 'system',
      reason: 'seed',
    });
    await writeEdition(store, {
      edition: ed('p2', 'Dup Show', 2024, { status: 'provisional', startDate: '2024-08-01', subjectKey: 'dup-show', performances: [perf('dj-x', 'DJ X')] }),
      actor: 'system',
      reason: 'seed',
    });

    // Spy on listEditions to prove none of the scan paths call it.
    let listEditionsCalls = 0;
    const proxyStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'listEditions') {
          return () => {
            listEditionsCalls++;
            throw new Error('listEditions must not be called');
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });

    assert.deepEqual(editionCoversDate((await store.getEditionHeaders(['c24']))[0], '2024-04-20'), { matched: true, weekend: 2 });
    assert.deepEqual(editionCoversDate((await store.getEditionHeaders(['c24']))[0], '2024-04-16'), { matched: false });

    const m = await matchEdition(proxyStore, {
      startDate: '2024-04-20',
      venue: 'Empire Polo Club',
      subjectKey: 'coachella',
    });
    assert.equal(m.kind, 'same');
    if (m.kind === 'same') {
      assert.equal(m.edition.id, 'c24');
      assert.equal(m.weekend, 2);
    }

    const vf = await findVerifiedEdition(proxyStore, { eventName: 'Coachella', year: 2024, startDate: '2024-04-20' });
    assert.equal(vf?.id, 'c24');

    const dedupe = await dedupeProvisionalEditions(proxyStore);
    assert.deepEqual(dedupe, { groups: 1, merged: 1 });
    // p2 had more acts so p2 survived
    assert.equal(await store.getEdition('p1'), null);
    assert.ok(await store.getEdition('p2'));
    assert.equal(listEditionsCalls, 0);
  });
});

test('findSeriesEditionMatches matches series name, brand, and aliases and filters out explicit conflicts', async () => {
  await withFileStore(async (store) => {
    await store.upsertSeries({
      slug: 'edc-lv',
      name: 'EDC Las Vegas',
      brand: 'Insomniac',
      aliases: ['Electric Daisy Carnival Las Vegas'],
    });
    await store.upsertSeries({
      slug: 'edc-orlando',
      name: 'EDC Orlando',
      brand: 'Insomniac',
      aliases: ['Electric Daisy Carnival Orlando'],
    });
    await store.upsertSeries({
      slug: 'coachella',
      name: 'Coachella Valley Music and Arts Festival',
      brand: 'Goldenvoice',
      aliases: ['Chella'],
    });

    await writeEdition(store, {
      edition: ed('edclv24', 'EDC Las Vegas 2024', 2024, {
        seriesSlug: 'edc-lv',
        startDate: '2024-05-17',
        endDate: '2024-05-19',
        venue: 'Las Vegas Motor Speedway',
        city: 'Las Vegas, NV',
      }),
      actor: 'owner',
      reason: 'seed',
    });
    await writeEdition(store, {
      edition: ed('edcorl24', 'EDC Orlando 2024', 2024, {
        seriesSlug: 'edc-orlando',
        startDate: '2024-11-08',
        endDate: '2024-11-10',
        venue: 'Tinker Field',
        city: 'Orlando, FL',
      }),
      actor: 'owner',
      reason: 'seed',
    });
    await writeEdition(store, {
      edition: ed('coachella24', 'Coachella 2024', 2024, {
        seriesSlug: 'coachella',
        startDate: '2024-04-12',
        endDate: '2024-04-21',
        venue: 'Empire Polo Club',
        city: 'Indio, CA',
        weekends: [
          { weekend: 1, startDate: '2024-04-12', endDate: '2024-04-14' },
          { weekend: 2, startDate: '2024-04-19', endDate: '2024-04-21' },
        ],
      }),
      actor: 'owner',
      reason: 'seed',
    });
    await writeEdition(store, {
      edition: ed('standalone24', 'EDC Tribute Night', 2024, { startDate: '2024-05-17' }),
      actor: 'owner',
      reason: 'seed',
    });
    await writeEdition(store, {
      edition: ed('prov-edc', 'EDC Las Vegas 2024', 2024, { seriesSlug: 'edc-lv', status: 'provisional', startDate: '2024-05-17' }),
      actor: 'owner',
      reason: 'seed',
    });

    // Unambiguous alias + year match, ignores standalone (no seriesSlug) and provisional.
    const lv = await findSeriesEditionMatches(store, { name: 'Electric Daisy Carnival Las Vegas', year: 2024 });
    assert.deepEqual(lv.map((e) => e.id), ['edclv24']);

    // Multi-city disambiguation when only "EDC" + 2024 given.
    const bothEdc = await findSeriesEditionMatches(store, { name: 'EDC', year: 2024 });
    assert.deepEqual(bothEdc.map((e) => e.id).sort(), ['edclv24', 'edcorl24']);

    // City filter narrows "EDC" + 2024 to Las Vegas.
    const edcCity = await findSeriesEditionMatches(store, { name: 'EDC', year: 2024, city: 'Las Vegas' });
    assert.deepEqual(edcCity.map((e) => e.id), ['edclv24']);

    // Conflicting venue filters out.
    const edcBadVenue = await findSeriesEditionMatches(store, { name: 'EDC Las Vegas', year: 2024, venue: 'Tinker Field' });
    assert.deepEqual(edcBadVenue, []);

    // Brand + weekend + date matching for Coachella W2.
    const chellaW2 = await findSeriesEditionMatches(store, { name: 'Goldenvoice Chella', startDate: '2024-04-20', weekend: 2 });
    assert.deepEqual(chellaW2.map((e) => e.id), ['coachella24']);

    // Gap between weekends does not match.
    const chellaGap = await findSeriesEditionMatches(store, { name: 'Coachella', startDate: '2024-04-16' });
    assert.deepEqual(chellaGap, []);
  });
});

test('editEditionFacts validates weekends, attaches/detaches seriesSlug, and updates region/country', async () => {
  await withFileStore(async (store) => {
    await store.upsertSeries({ slug: 'coachella', name: 'Coachella', brand: 'Goldenvoice' });
    const confirmRes = await confirmCanonicalEdition(
      store,
      parseCanonicalInput({
        name: 'Unique Fest 2024',
        year: 2024,
        startDate: '2024-04-12',
        performers: [{ name: 'Justice' }],
        apply: true,
      }),
    );
    const created = confirmRes.edition!;
    assert.equal(created.seriesSlug, undefined);
    assert.equal(await store.getSeries('unique-fest'), null, 'must not auto-create stub series');

    assert.throws(
      () =>
        parseEditionFacts({
          name: 'Coachella 2024',
          sourceNote: 'Official',
          weekends: [
            { weekend: 1, startDate: '2024-04-12', endDate: '2024-04-14' },
            { weekend: 1, startDate: '2024-04-19', endDate: '2024-04-21' },
          ],
        }),
      CanonicalInputError,
    );
    assert.throws(
      () =>
        parseEditionFacts({
          name: 'Coachella 2024',
          sourceNote: 'Official',
          weekends: [{ weekend: 1, startDate: '2024-04-14', endDate: '2024-04-12' }],
        }),
      CanonicalInputError,
    );

    await assert.rejects(
      editEditionFacts(
        store,
        created.id,
        parseEditionFacts({
          name: 'Coachella 2024',
          seriesSlug: 'missing-series',
          sourceNote: 'Official',
        }),
      ),
      CanonicalInputError,
    );

    const updated = await editEditionFacts(
      store,
      created.id,
      parseEditionFacts({
        name: 'Coachella 2024',
        venue: 'Empire Polo Club',
        city: 'Indio',
        region: 'CA',
        country: 'US',
        seriesSlug: 'coachella',
        weekends: [
          { weekend: 2, startDate: '2024-04-19', endDate: '2024-04-21' },
          { weekend: 1, startDate: '2024-04-12', endDate: '2024-04-14' },
        ],
        sourceNote: 'Official',
      }),
    );
    assert.equal(updated.seriesSlug, 'coachella');
    assert.equal(updated.seriesName, 'Coachella');
    assert.equal(updated.seriesBrand, 'Goldenvoice');
    assert.equal(updated.region, 'CA');
    assert.equal(updated.country, 'US');
    assert.equal(updated.startDate, '2024-04-12');
    assert.equal(updated.endDate, '2024-04-21');
    assert.deepEqual(updated.weekends?.map((w) => w.weekend), [1, 2]);
    assert.equal(updated.performances.length, 1);

    // Detach seriesSlug
    const detached = await editEditionFacts(
      store,
      created.id,
      parseEditionFacts({
        name: 'Coachella 2024',
        startDate: '2024-04-12',
        endDate: '2024-04-21',
        seriesSlug: null,
        sourceNote: 'Detach',
      }),
    );
    assert.equal(detached.seriesSlug, undefined);
    assert.equal(detached.seriesName, undefined);
  });
});

test('confirmCanonicalEdition with editionId updates the same edition after name/startDate/seriesSlug edits', async () => {
  await withFileStore(async (store) => {
    await store.upsertSeries({ slug: 'portola', name: 'Portola' });
    const first = await confirmCanonicalEdition(
      store,
      parseCanonicalInput({
        name: 'Portola 2024',
        year: 2024,
        startDate: '2024-09-28',
        performers: [{ name: 'Four Tet' }],
        apply: true,
      }),
    );
    const id = first.edition!.id;

    await editEditionFacts(
      store,
      id,
      parseEditionFacts({
        name: 'Portola Music Festival 2024',
        startDate: '2024-09-27',
        endDate: '2024-09-29',
        region: 'CA',
        seriesSlug: 'portola',
        sourceNote: 'Updated poster',
      }),
    );

    const second = await confirmCanonicalEdition(
      store,
      parseCanonicalInput({
        editionId: id,
        name: 'Portola Music Festival 2024',
        year: 2024,
        startDate: '2024-09-27',
        performers: [{ name: 'Four Tet' }, { name: 'Jamie xx' }],
        apply: true,
      }),
    );
    assert.equal(second.edition!.id, id);
    assert.equal(second.edition!.seriesSlug, 'portola');
    assert.equal(second.edition!.region, 'CA');
    assert.equal(second.edition!.performances.length, 2);
    assert.equal((await store.listEditions(20)).length, 1);
  });
});

test('mergeCanonicalEditions with combineAsWeekends stamps logged_events.weekend before merge', async () => {
  await withFileStore(async (store) => {
    await store.upsertSeries({ slug: 'coachella', name: 'Coachella' });
    await writeEdition(store, {
      edition: ed('e-w1', 'Coachella 2024 Weekend 1', 2024, {
        seriesSlug: 'coachella',
        status: 'provisional',
        startDate: '2024-04-12',
        endDate: '2024-04-14',
        performances: [perf('justice', 'Justice')],
      }),
      actor: 'system',
      reason: 'seed',
    });
    await writeEdition(store, {
      edition: ed('e-w2', 'Coachella 2024 Weekend 2', 2024, {
        seriesSlug: 'coachella',
        status: 'verified',
        startDate: '2024-04-19',
        endDate: '2024-04-21',
        venue: 'Empire Polo Club',
        city: 'Indio, CA',
        region: 'CA',
        performances: [perf('justice', 'Justice'), perf('gesaffelstein', 'Gesaffelstein')],
      }),
      actor: 'system',
      reason: 'seed',
    });

    const now = new Date('2026-01-01T00:00:00.000Z');
    await store.putEvent({ ...newEvent('Coachella W1', now), id: 'ev-1', editionId: 'e-w1' });
    await store.putEvent({ ...newEvent('Coachella W2', now), id: 'ev-2', editionId: 'e-w2' });

    const res = await mergeCanonicalEditions(store, {
      keepId: 'e-w1',
      dropIds: ['e-w2'],
      factChoices: { name: 'Coachella 2024' },
      combineAsWeekends: true,
      actor: 'owner',
      reason: 'Combine W1 and W2',
    });

    assert.equal(res.edition.id, 'e-w1');
    assert.equal(res.edition.name, 'Coachella 2024');
    assert.equal(res.edition.status, 'verified');
    assert.equal(res.edition.venue, 'Empire Polo Club');
    assert.equal(res.edition.region, 'CA');
    assert.equal(res.edition.startDate, '2024-04-12');
    assert.equal(res.edition.endDate, '2024-04-21');
    assert.deepEqual(res.edition.weekends, [
      { weekend: 1, startDate: '2024-04-12', endDate: '2024-04-14' },
      { weekend: 2, startDate: '2024-04-19', endDate: '2024-04-21' },
    ]);
    assert.equal(res.edition.performances.length, 2);
    assert.equal(await store.getEdition('e-w2'), null);

    const ev1 = await store.getEvent('ev-1');
    const ev2 = await store.getEvent('ev-2');
    assert.equal(ev1?.editionId, 'e-w1');
    assert.equal(ev1?.weekend, 1);
    assert.equal(ev2?.editionId, 'e-w1');
    assert.equal(ev2?.weekend, 2);
  });
});

test('series CRUD/merge/editions routes, edition merge route, lean artists routes, and multi-weekend suggest route', async () => {
  await withFileStore(async (store) => {
    const app = makeApp(store, 'owner');
    const memberApp = makeApp(store, 'member');

    // Member blocked from owner series & merge endpoints.
    assert.equal((await dispatch(memberApp, { url: '/api/manage/canonical/series' })).status, 403);
    assert.equal(
      (await dispatch(memberApp, { url: '/api/manage/canonical/editions/e1/merge', method: 'POST', headers: { 'content-type': 'application/json' }, body: { dropIds: ['e2'] } })).status,
      403,
    );

    // Create two series, patch one, merge them.
    const c1 = await dispatch(app, {
      url: '/api/manage/canonical/series',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { name: 'EDC Las Vegas', brand: 'Insomniac', aliases: ['EDCLV'] },
    });
    assert.equal(c1.status, 201);
    const c2 = await dispatch(app, {
      url: '/api/manage/canonical/series',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { name: 'EDC LV Alt', slug: 'edc-lv-alt' },
    });
    assert.equal(c2.status, 201);

    const dup = await dispatch(app, {
      url: '/api/manage/canonical/series',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { name: 'EDC Las Vegas' },
    });
    assert.equal(dup.status, 409);

    const patched = await dispatch(app, {
      url: '/api/manage/canonical/series/edc-las-vegas',
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: { aliases: ['EDCLV', 'Electric Daisy Carnival'], lineupUrl: 'https://edc.example' },
    });
    assert.equal(patched.status, 200);
    assert.equal(((await patched.json()) as any).series.lineupUrl, 'https://edc.example');

    await writeEdition(store, {
      edition: ed('ed-1', 'EDC Las Vegas 2024', 2024, {
        seriesSlug: 'edc-las-vegas',
        startDate: '2024-05-17',
        endDate: '2024-05-19',
        weekends: [
          { weekend: 1, startDate: '2024-05-17', endDate: '2024-05-19' },
          { weekend: 2, startDate: '2024-05-24', endDate: '2024-05-26' },
        ],
        performances: [perf('kaskade', 'Kaskade')],
      }),
      actor: 'owner',
      reason: 'seed',
    });
    await writeEdition(store, {
      edition: ed('ed-2', 'EDC Las Vegas 2023', 2023, {
        seriesSlug: 'edc-lv-alt',
        startDate: '2023-05-19',
        performances: [perf('kaskade', 'Kaskade')],
      }),
      actor: 'owner',
      reason: 'seed',
    });
    await store.ensureArtists([{ key: 'kaskade', name: 'Kaskade' }]);

    const mergedSeries = await dispatch(app, {
      url: '/api/manage/canonical/series/edc-las-vegas/merge',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { dropSlug: 'edc-lv-alt' },
    });
    assert.equal(mergedSeries.status, 200);
    assert.equal(((await mergedSeries.json()) as any).merged.editions_moved, 1);

    const listedSeries = await dispatch(app, { url: '/api/manage/canonical/series?brand=Insomniac' });
    assert.equal(listedSeries.status, 200);
    const seriesBody = (await listedSeries.json()) as { series: Array<{ slug: string; editionCount: number }> };
    assert.deepEqual(seriesBody.series.map((s) => [s.slug, s.editionCount]), [['edc-las-vegas', 2]]);

    const seriesEds = await dispatch(app, { url: '/api/manage/canonical/series/edc-las-vegas/editions' });
    assert.equal(seriesEds.status, 200);
    const seBody = (await seriesEds.json()) as { editions: Array<{ id: string; performanceCount: number }> };
    assert.deepEqual(seBody.editions.map((e) => [e.id, e.performanceCount]), [['ed-1', 1], ['ed-2', 1]]);

    // Lean artists routes must NOT call listEditions.
    const origListEditions = store.listEditions.bind(store);
    let calledListEditions = 0;
    (store as any).listEditions = () => {
      calledListEditions++;
      throw new Error('listEditions must not be called by artist routes');
    };
    const artistsRes = await dispatch(app, { url: '/api/manage/canonical/artists' });
    assert.equal(artistsRes.status, 200);
    const artistsBody = (await artistsRes.json()) as { artists: Array<{ key: string; editionsCount: number }> };
    assert.equal(artistsBody.artists.find((a) => a.key === 'kaskade')?.editionsCount, 2);

    const artistDetailRes = await dispatch(app, { url: '/api/manage/canonical/artists/kaskade' });
    assert.equal(artistDetailRes.status, 200);
    const detailBody = (await artistDetailRes.json()) as { appearances: Array<{ editionId: string }> };
    assert.deepEqual(detailBody.appearances.map((a) => a.editionId), ['ed-1', 'ed-2']);
    assert.equal(calledListEditions, 0);
    (store as any).listEditions = origListEditions;

    // Edition merge route test.
    await writeEdition(store, {
      edition: ed('ed-dup', 'EDC Las Vegas 2023 Dup', 2023, { startDate: '2023-05-19' }),
      actor: 'owner',
      reason: 'seed',
    });
    const mergeEdRes = await dispatch(app, {
      url: '/api/manage/canonical/editions/ed-2/merge',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { dropIds: ['ed-dup'], reason: 'dup' },
    });
    assert.equal(mergeEdRes.status, 200);
    assert.equal(await store.getEdition('ed-dup'), null);

    // Multi-weekend suggest route: stays suggested when W1 logged, hidden once W1 & W2 logged.
    const now = new Date('2026-01-01T00:00:00.000Z');
    await store.putEvent({ ...newEvent('EDC W1', now), id: 'log-w1', editionId: 'ed-1', weekend: 1 });
    await store.putEvent({ ...newEvent('EDC 2023', now), id: 'log-23', editionId: 'ed-2' });

    const suggest1 = await dispatch(memberApp, { url: '/api/editions/suggest?q=edc' });
    assert.equal(suggest1.status, 200);
    assert.deepEqual(
      ((await suggest1.json()) as { editions: Array<{ id: string }> }).editions.map((e) => e.id),
      ['ed-1'],
    );

    await store.putEvent({ ...newEvent('EDC W2', now), id: 'log-w2', editionId: 'ed-1', weekend: 2 });
    const suggest2 = await dispatch(memberApp, { url: '/api/editions/suggest?q=edc' });
    assert.equal(suggest2.status, 200);
    assert.deepEqual(((await suggest2.json()) as { editions: Array<{ id: string }> }).editions, []);
  });
});
