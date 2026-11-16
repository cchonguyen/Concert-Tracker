import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { fakeFetcher } from './fakes.ts';
import { parseEventInput } from '../src/server/events/parse.ts';
import { applyLinkedPatch, editionPlaceValue, ensureCaptured, recordOverrides, resolveEvent, unlinkEvent } from '../src/server/events/inherit.ts';
import { newEvent, newEventFromEdition } from '../src/server/events/service.ts';
import { researchEvent, type DetailFinder } from '../src/server/events/details.ts';
import { eventsRouter, type EventsRunner } from '../src/server/events/routes.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { writeEdition } from '../src/server/canon/editions.ts';
import type { PipelineDeps } from '../src/server/lineup/pipeline.ts';
import type { Edition } from '../src/server/lineup/types.ts';

const NOW = new Date('2026-11-15T12:00:00Z');
const LATER = new Date('2026-11-16T12:00:00Z');

const coachella24 = (over: Partial<Edition> = {}): Edition => ({
  id: 'coachella-2024',
  key: 'coachella/2024',
  seriesSlug: 'coachella',
  seriesName: 'Coachella',
  year: 2024,
  name: 'Coachella',
  startDate: '2024-04-12',
  endDate: '2024-04-21',
  venue: 'Empire Polo Club',
  city: 'Indio',
  region: 'CA',
  country: 'United States',
  weekends: [
    { weekend: 1, startDate: '2024-04-12', endDate: '2024-04-14' },
    { weekend: 2, startDate: '2024-04-19', endDate: '2024-04-21' },
  ],
  status: 'verified',
  performances: [
    {
      artistKey: 'justice',
      name: 'Justice',
      days: [],
      stages: [],
      status: 'billed',
      confidence: 0.9,
      sources: [{ sourceType: 'promoter', sourceUrl: 'https://coachella.example', quotedSpan: 'Justice', evidence: 'billed', extractor: 'user' }],
    },
  ],
  updatedAt: NOW.toISOString(),
  ...over,
});

async function withDeps(
  fn: (deps: PipelineDeps, store: FileLineupStore, calls: string[]) => Promise<void>,
  routes: Record<string, { status?: number; body: unknown }> = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'slice14-'));
  try {
    const store = new FileLineupStore(dir);
    const { fetcher, calls } = fakeFetcher(routes);
    const deps: PipelineDeps = {
      store,
      fetcher,
      adapters: [],
      lateAdapters: [],
      gemini: null,
      quota: null,
      search: null,
      now: () => NOW,
    };
    await fn(deps, store, calls);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function appFor(deps: PipelineDeps, runner: EventsRunner = { kick() {} }, finders: DetailFinder[] = []) {
  const app = express();
  app.use(express.json());
  app.use('/api', eventsRouter(deps, runner, finders));
  return app;
}

test('parseEventInput extracts explicit weekend tokens without touching band names or literal W2', () => {
  const c = parseEventInput('Coachella 2024 weekend 2');
  assert.equal(c.name, 'Coachella');
  assert.equal(c.year, 2024);
  assert.equal(c.weekend, 2);
  assert.deepEqual(c.readings, [{ name: 'Coachella' }]);

  const edc = parseEventInput('EDC LV W1 2025');
  assert.equal(edc.name, 'EDC LV');
  assert.equal(edc.year, 2025);
  assert.equal(edc.weekend, 1);
  assert.deepEqual(edc.readings, [{ name: 'EDC LV' }]);

  const wknd = parseEventInput('Coachella wknd 3 at Empire Polo Club, Indio 2024');
  assert.equal(wknd.name, 'Coachella');
  assert.equal(wknd.venue, 'Empire Polo Club');
  assert.equal(wknd.city, 'Indio');
  assert.equal(wknd.year, 2024);
  assert.equal(wknd.weekend, 3);
  assert.deepEqual(wknd.readings, [
    { name: 'Coachella', venue: 'Empire Polo Club', city: 'Indio' },
    { name: 'Coachella at Empire Polo Club, Indio' },
  ]);

  const vw = parseEventInput('Vampire Weekend 2024');
  assert.equal(vw.name, 'Vampire Weekend');
  assert.equal(vw.year, 2024);
  assert.equal(vw.weekend, undefined);

  const tw = parseEventInput('The Weeknd');
  assert.equal(tw.name, 'The Weeknd');
  assert.equal(tw.weekend, undefined);

  const lit = parseEventInput('W2');
  assert.equal(lit.name, 'W2');
  assert.deepEqual(lit.readings, [{ name: 'W2' }]);

  const litAt = parseEventInput('W2 at Red Rocks');
  assert.equal(litAt.name, 'W2');
  assert.equal(litAt.venue, 'Red Rocks');
});

test('resolveEvent and applyLinkedPatch handle multi-weekend dates, daysAttended pruning, region, and local series overrides', async () => {
  await withDeps(async (_deps, store) => {
    const ed = coachella24();
    await store.upsertSeries({ slug: 'coachella', name: 'Coachella' });
    await writeEdition(store, { edition: ed, actor: 'owner', reason: 'seed' });

    // Multi-weekend without weekend chosen: dates remain blank (no leakage), year/region/series still resolve.
    const unweekended = newEventFromEdition('Coachella', ed, NOW);
    assert.equal(unweekended.weekend, undefined);
    const shownUnset = resolveEvent(unweekended, ed);
    assert.equal(shownUnset.startDate, undefined);
    assert.equal(shownUnset.endDate, undefined);
    assert.equal(shownUnset.year, 2024);
    assert.equal(shownUnset.region, 'CA');
    assert.equal(shownUnset.series, 'Coachella');

    // Single-weekend edition resolves dates from weekends[0] even when event.weekend is unset.
    const singleW = coachella24({
      id: 'single-w',
      weekends: [{ weekend: 1, startDate: '2024-04-12', endDate: '2024-04-14' }],
      startDate: undefined,
      endDate: undefined,
    });
    const singleShown = resolveEvent(newEventFromEdition('Coachella', singleW, NOW), singleW);
    assert.equal(singleShown.startDate, '2024-04-12');
    assert.equal(singleShown.endDate, '2024-04-14');

    // Weekend 2 from input resolves Weekend 2 dates.
    const w2Ev = newEventFromEdition('Coachella 2024 W2', ed, NOW);
    assert.equal(w2Ev.weekend, 2);
    const shownW2 = resolveEvent(w2Ev, ed);
    assert.equal(shownW2.startDate, '2024-04-19');
    assert.equal(shownW2.endDate, '2024-04-21');

    // Future multi-weekend computes attendance via resolveEvent.
    const futureEd = coachella24({
      id: 'coachella-2027',
      year: 2027,
      startDate: '2027-04-16',
      endDate: '2027-04-25',
      weekends: [
        { weekend: 1, startDate: '2027-04-16', endDate: '2027-04-18' },
        { weekend: 2, startDate: '2027-04-23', endDate: '2027-04-25' },
      ],
    });
    assert.equal(newEventFromEdition('Coachella 2027 W2', futureEd, NOW).attendance, 'planned');
    assert.equal(newEventFromEdition('Coachella 2027', futureEd, NOW).attendance, 'planned');
    assert.equal(w2Ev.attendance, undefined);

    // Switching from W1 (with manual date override + daysAttended) to W2 clears old date overrides & prunes daysAttended.
    let ev = newEventFromEdition('Coachella 2024 W1', ed, NOW);
    ev = applyLinkedPatch(ev, ed, { startDate: '2024-04-13', daysAttended: ['2024-04-12', '2024-04-13', '2024-04-20'] }, LATER).event;
    assert.equal(ev.overrides?.start_date, '2024-04-13');

    const switched = applyLinkedPatch(ev, ed, { weekend: 2 }, LATER);
    assert.equal(switched.event.weekend, 2);
    assert.equal(switched.event.overrides?.start_date, undefined);
    assert.deepEqual(switched.event.daysAttended, ['2024-04-20']);
    assert.deepEqual(switched.changes, []);
    assert.equal(resolveEvent(switched.event, ed).startDate, '2024-04-19');
    assert.equal(resolveEvent(switched.event, ed).endDate, '2024-04-21');

    // Manual date override on W2 compares against W2's date (2024-04-19), not W1's (2024-04-12).
    const customDate = applyLinkedPatch(switched.event, ed, { startDate: '2024-04-20' }, LATER);
    assert.equal(customDate.event.overrides?.start_date, '2024-04-20');
    assert.deepEqual(customDate.changes, [{ field: 'startDate', old: '2024-04-19', new: '2024-04-20' }]);
    assert.equal(resolveEvent(customDate.event, ed).startDate, '2024-04-20');

    // Region override produces a review item; series override stays local and creates NO review item.
    const regPatch = applyLinkedPatch(switched.event, ed, { region: 'California', series: 'My Desert Fest' }, LATER);
    assert.equal(regPatch.event.overrides?.region, 'California');
    assert.equal(regPatch.event.overrides?.series, 'My Desert Fest');
    assert.deepEqual(regPatch.changes, [{ field: 'region', old: 'CA', new: 'California' }]);
    const resolvedAfter = resolveEvent(regPatch.event, ed);
    assert.equal(resolvedAfter.region, 'California');
    assert.equal(resolvedAfter.series, 'My Desert Fest');
    const reviewRows = await recordOverrides(store, regPatch.event, regPatch.changes);
    assert.equal(reviewRows.length, 1);
    assert.equal((reviewRows[0].payload as any).field, 'region');
  });
});

test('Option 3B: 1 series match auto-links and skips Stage 1; 2+ matches yield canonical candidates; pick & dismiss-canon work', async () => {
  const GEO = 'https://geocoding-api.open-meteo.com/';
  const ARCHIVE = 'https://archive-api.open-meteo.com/';
  const INDIO = { name: 'Indio', admin1: 'California', country_code: 'US', country: 'United States', feature_code: 'PPLA2', latitude: 33.72, longitude: -116.21 };
  const archiveDays = { daily: { time: ['2024-04-19', '2024-04-20', '2024-04-21'], temperature_2m_max: [31, 32, 30], temperature_2m_min: [16, 17, 15], precipitation_sum: [0, 0, 0], weather_code: [0, 0, 0] } };

  await withDeps(
    async (deps, store, calls) => {
      await store.upsertSeries({ slug: 'coachella', name: 'Coachella', brand: 'Goldenvoice', aliases: ['Chella'] });
      await store.upsertSeries({ slug: 'edc-lv', name: 'EDC Las Vegas', brand: 'Insomniac' });
      await store.upsertSeries({ slug: 'edc-orlando', name: 'EDC Orlando', brand: 'Insomniac' });

      await writeEdition(store, { edition: coachella24(), actor: 'owner', reason: 'seed' });
      await writeEdition(store, {
        edition: {
          id: 'edc-lv-24',
          key: 'edc-lv/2024',
          seriesSlug: 'edc-lv',
          seriesName: 'EDC Las Vegas',
          year: 2024,
          name: 'EDC Las Vegas 2024',
          startDate: '2024-05-17',
          endDate: '2024-05-19',
          venue: 'Las Vegas Motor Speedway',
          city: 'Las Vegas',
          region: 'NV',
          country: 'United States',
          status: 'verified',
          performances: [],
          updatedAt: NOW.toISOString(),
        },
        actor: 'owner',
        reason: 'seed',
      });
      await writeEdition(store, {
        edition: {
          id: 'edc-orl-24',
          key: 'edc-orlando/2024',
          seriesSlug: 'edc-orlando',
          seriesName: 'EDC Orlando 2024',
          year: 2024,
          name: 'EDC Orlando 2024',
          startDate: '2024-11-08',
          endDate: '2024-11-10',
          venue: 'Tinker Field',
          city: 'Orlando',
          region: 'FL',
          country: 'United States',
          status: 'verified',
          performances: [],
          updatedAt: NOW.toISOString(),
        },
        actor: 'owner',
        reason: 'seed',
      });

      const kickedResearch: string[] = [];
      let finderCalls = 0;
      const extFinder: DetailFinder = {
        id: 'ticketmaster',
        enabled: () => true,
        find: async () => {
          finderCalls++;
          return [
            {
              id: 'tm-1',
              name: 'EDC Club Night',
              startDate: '2024-06-01',
              venue: 'Club Space',
              city: 'Miami, FL',
              sources: [{ sourceType: 'ticketmaster', sourceUrl: 'https://tm.example/1', fields: ['startDate', 'venue', 'city'] }],
            },
          ];
        },
      };
      const runner: EventsRunner = { kick() {}, kickResearch: (id) => void kickedResearch.push(id) };
      const app = appFor(deps, runner, [extFinder]);

      // 1 match: "Chella 2024 W2" auto-links, skips Stage 1, kicks lineup + fetches weather.
      const singleRes = await dispatch(app, {
        method: 'POST',
        url: '/api/events',
        body: { text: 'Chella 2024 W2', research: true },
      });
      assert.equal(singleRes.status, 201);
      const singleBody = singleRes.json<{ event: any; job?: any; research?: string }>();
      assert.equal(singleBody.research, undefined);
      assert.equal(singleBody.event.editionId, 'coachella-2024');
      assert.equal(singleBody.event.weekend, 2);
      assert.equal(singleBody.event.startDate, '2024-04-19');
      assert.equal(singleBody.event.details.status, 'matched');
      assert.equal(singleBody.job?.status, 'needs_review');
      assert.equal(singleBody.event.weather?.days.length, 3);
      assert.equal(kickedResearch.length, 0);
      assert.equal(finderCalls, 0);
      assert.ok(calls.every((u) => u.startsWith(GEO) || u.startsWith(ARCHIVE)));

      // Verify captured was kept for 1-tap unlink.
      const storedSingle = await store.getEvent(singleBody.event.id);
      assert.equal(storedSingle?.captured?.name, 'Chella');

      // 2+ matches: "EDC 2024" saves unlinked with status 'candidates', skips Stage 1 external research.
      const multiRes = await dispatch(app, {
        method: 'POST',
        url: '/api/events',
        body: { text: 'EDC 2024', research: true },
      });
      assert.equal(multiRes.status, 201);
      const multiBody = multiRes.json<{ event: any; research?: string }>();
      assert.equal(multiBody.research, undefined);
      assert.equal(multiBody.event.editionId, undefined);
      assert.equal(multiBody.event.details.status, 'candidates');
      assert.deepEqual(
        multiBody.event.details.candidates.map((c: any) => c.editionId).sort(),
        ['edc-lv-24', 'edc-orl-24'],
      );
      assert.equal(kickedResearch.length, 0);
      assert.equal(finderCalls, 0);

      // Picking a canonical candidate links editionId and kicks lineup lookup.
      const pickRes = await dispatch(app, {
        method: 'POST',
        url: `/api/events/${multiBody.event.id}/details/pick`,
        body: { candidateId: 'edc-lv-24' },
      });
      assert.equal(pickRes.status, 200);
      const pickedBody = pickRes.json<{ event: any; job?: any }>();
      assert.equal(pickedBody.event.editionId, 'edc-lv-24');
      assert.equal(pickedBody.event.venue, 'Las Vegas Motor Speedway');
      assert.equal(pickedBody.event.details.status, 'matched');
      assert.ok(pickedBody.job?.id);

      // Dismiss-canon clears canonical candidates and runs external Stage 1 research (skipCanon: true).
      const multiRes2 = await dispatch(app, {
        method: 'POST',
        url: '/api/events',
        body: { text: 'EDC 2024', research: true },
      });
      const ev2 = multiRes2.json<{ event: any }>().event;
      const appSync = appFor(deps, { kick() {} }, [extFinder]);
      const dismissRes = await dispatch(appSync, {
        method: 'POST',
        url: `/api/events/${ev2.id}/details/dismiss-canon`,
      });
      assert.equal(dismissRes.status, 200);
      const dismissed = dismissRes.json<{ event: any }>().event;
      assert.equal(finderCalls, 1);
      assert.equal(dismissed.details.status, 'choose');
      assert.equal(dismissed.details.skipCanon, true);
      assert.equal(dismissed.details.candidates.length, 1);
      assert.equal(dismissed.details.candidates[0].name, 'EDC Club Night');
      assert.equal(dismissed.details.candidates[0].editionId, undefined);
    },
    { [GEO]: { body: { results: [INDIO] } }, [ARCHIVE]: { body: archiveDays } },
  );
});

test('researchEvent catalogHit uses editionCoversDate for multi-weekend dates and honors skipCanon', async () => {
  await withDeps(async (_deps, store) => {
    await store.upsertSeries({ slug: 'coachella', name: 'Coachella' });
    await writeEdition(store, { edition: coachella24({ subjectKey: 'coachella' }), actor: 'owner', reason: 'seed' });

    // Date inside W2 matches W2 dates from catalog.
    const w2Ev = ensureCaptured(newEvent('Coachella at Empire Polo Club Apr 20 2024', NOW));
    const matched = await researchEvent({ ...w2Ev, city: undefined }, [], fakeFetcher({}).fetcher, NOW, undefined, { store });
    assert.equal(matched.details.status, 'matched');
    assert.equal(matched.venue, 'Empire Polo Club');
    assert.equal(matched.city, 'Indio');
    assert.equal(matched.details.candidates[0].startDate, '2024-04-19');
    assert.equal(matched.details.candidates[0].endDate, '2024-04-21');

    // Date in the gap between W1 and W2 does not match catalog.
    const gapEv = ensureCaptured(newEvent('Coachella at Empire Polo Club Apr 16 2024', NOW));
    const gapOut = await researchEvent(gapEv, [], fakeFetcher({}).fetcher, NOW, undefined, { store });
    assert.notEqual(gapOut.details.status, 'matched');

    // skipCanon bypasses catalogHit.
    const skipped = await researchEvent({ ...w2Ev, city: undefined }, [], fakeFetcher({}).fetcher, NOW, undefined, {
      store,
      skipCanon: true,
    });
    assert.equal(skipped.details.status, 'off');
    assert.equal(skipped.city, undefined);
  });
});

test('GET /api/events calls getEditionHeaders (never getEditions) and resolves inherited fields', async () => {
  await withDeps(async (deps, store) => {
    await store.upsertSeries({ slug: 'coachella', name: 'Coachella' });
    await writeEdition(store, { edition: coachella24(), actor: 'owner', reason: 'seed' });
    const ev = newEventFromEdition('Coachella 2024 W2', coachella24(), NOW);
    await store.putEvent(ev);

    let headerCalls = 0;
    let fullCalls = 0;
    const origHeaders = store.getEditionHeaders.bind(store);
    (store as any).getEditionHeaders = async (ids: string[]) => {
      headerCalls++;
      return origHeaders(ids);
    };
    (store as any).getEditions = async () => {
      fullCalls++;
      throw new Error('getEditions must not be called by GET /api/events');
    };

    const res = await dispatch(appFor(deps), { method: 'GET', url: '/api/events' });
    assert.equal(res.status, 200);
    const body = res.json<{ events: any[]; editions: Record<string, { acts: number }> }>();
    assert.equal(headerCalls, 1);
    assert.equal(fullCalls, 0);
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].venue, 'Empire Polo Club');
    assert.equal(body.events[0].region, 'CA');
    assert.equal(body.events[0].series, 'Coachella');
    assert.equal(body.events[0].startDate, '2024-04-19');
    assert.equal(body.editions[ev.id]?.acts, 1);
  });
});

test('Series -> Edition -> Event place inheritance, SoCal city override, tour non-inheritance, and read-only seriesKind', async () => {
  await withDeps(async (deps, store) => {
    await store.upsertSeries({
      slug: 'hard-summer',
      name: 'HARD Summer',
      kind: 'festival',
      city: 'San Bernardino',
      region: 'CA',
      country: 'United States',
    });
    await store.upsertSeries({
      slug: 'eras-tour',
      name: 'The Eras Tour',
      kind: 'tour',
    });

    // Edition without place inherits from festival series
    await writeEdition(store, {
      edition: {
        id: 'hs-2023',
        key: 'hard-summer/2023',
        seriesSlug: 'hard-summer',
        year: 2023,
        name: 'HARD Summer 2023',
        startDate: '2023-08-05',
        endDate: '2023-08-06',
        status: 'verified',
        performances: [],
        updatedAt: NOW.toISOString(),
      },
      actor: 'owner',
      reason: 'seed',
    });
    // Edition with its own city (e.g. SoCal city move to Los Angeles) wins over series city while still inheriting region/country
    await writeEdition(store, {
      edition: {
        id: 'hs-2024',
        key: 'hard-summer/2024',
        seriesSlug: 'hard-summer',
        year: 2024,
        name: 'HARD Summer 2024',
        startDate: '2024-08-03',
        endDate: '2024-08-04',
        city: 'Los Angeles',
        status: 'verified',
        performances: [],
        updatedAt: NOW.toISOString(),
      },
      actor: 'owner',
      reason: 'seed',
    });
    // Tour edition with no place gets zero place inheritance and seriesKind === 'concert'
    await writeEdition(store, {
      edition: {
        id: 'eras-2023',
        key: 'eras-tour/2023',
        seriesSlug: 'eras-tour',
        year: 2023,
        name: 'The Eras Tour',
        startDate: '2023-08-08',
        status: 'verified',
        performances: [],
        updatedAt: NOW.toISOString(),
      },
      actor: 'owner',
      reason: 'seed',
    });

    const hs23 = (await store.getEdition('hs-2023'))!;
    const hs24 = (await store.getEdition('hs-2024'))!;
    const eras23 = (await store.getEdition('eras-2023'))!;

    assert.equal(editionPlaceValue(hs23, 'city'), 'San Bernardino');
    assert.equal(editionPlaceValue(hs24, 'city'), 'Los Angeles');
    assert.equal(editionPlaceValue(hs24, 'region'), 'CA');
    assert.equal(editionPlaceValue(eras23, 'city'), undefined);

    const app = appFor(deps);
    // Create via POST /api/events with editionId: hs-2023
    const resFest = await dispatch(app, {
      method: 'POST',
      url: '/api/events',
      body: { text: 'HARD Summer 2023', editionId: 'hs-2023' },
    });
    assert.equal(resFest.status, 201);
    const festEv = resFest.json<{ event: any }>().event;
    assert.equal(festEv.city, 'San Bernardino');
    assert.equal(festEv.region, 'CA');
    assert.equal(festEv.country, 'United States');
    assert.equal(festEv.seriesKind, 'festival');

    // Stored event never persists seriesKind
    const rawStored = await store.getEvent(festEv.id);
    assert.equal(rawStored?.seriesKind, undefined);

    // Edition city override wins over festival series city
    const ev24 = resolveEvent(newEventFromEdition('HARD Summer 2024', hs24, NOW), hs24);
    assert.equal(ev24.city, 'Los Angeles');
    assert.equal(ev24.region, 'CA');
    assert.equal(ev24.country, 'United States');
    assert.equal(ev24.seriesKind, 'festival');

    // Patching city back to series-inherited value drops override
    const patchedCity = applyLinkedPatch(rawStored!, hs23, { city: 'Fontana' }, LATER);
    assert.deepEqual(patchedCity.changes, [{ field: 'city', old: 'San Bernardino', new: 'Fontana' }]);
    assert.equal(patchedCity.event.seriesKind, undefined);
    const resetCity = applyLinkedPatch(patchedCity.event, hs23, { city: 'San Bernardino' }, LATER);
    assert.equal(resetCity.event.overrides?.city, undefined);

    // Unlink clears seriesKind
    const unlinked = unlinkEvent(festEv, LATER);
    assert.equal(unlinked.seriesKind, undefined);

    // Tour series: zero place inheritance and seriesKind === 'concert'
    const evTour = resolveEvent(newEventFromEdition('The Eras Tour 2023', eras23, NOW), eras23);
    assert.equal(evTour.city, undefined);
    assert.equal(evTour.region, undefined);
    assert.equal(evTour.country, undefined);
    assert.equal(evTour.seriesKind, 'concert');

    // Multiple canonical matches -> canonicalCandidate populates city/region/country from festival series
    await writeEdition(store, {
      edition: {
        id: 'hs-2024-chi',
        key: 'hard-summer/2024-chi',
        seriesSlug: 'hard-summer',
        year: 2024,
        name: 'HARD Summer Chicago 2024',
        startDate: '2024-08-10',
        status: 'verified',
        performances: [],
        updatedAt: NOW.toISOString(),
      },
      actor: 'owner',
      reason: 'seed',
    });
    const multiRes = await dispatch(app, {
      method: 'POST',
      url: '/api/events',
      body: { text: 'HARD Summer 2024', research: true },
    });
    assert.equal(multiRes.status, 201);
    const cands = multiRes.json<{ event: any }>().event.details.candidates;
    const chiCand = cands.find((c: any) => c.editionId === 'hs-2024-chi');
    const laCand = cands.find((c: any) => c.editionId === 'hs-2024');
    assert.equal(chiCand.city, 'San Bernardino');
    assert.equal(chiCand.region, 'CA');
    assert.equal(laCand.city, 'Los Angeles');
  });
});
