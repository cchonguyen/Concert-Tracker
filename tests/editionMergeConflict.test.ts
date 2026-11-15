import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { EditionOccurrenceConflictError } from '../src/server/lineup/store/types.ts';
import { withEntityLinks } from '../src/server/entities/linkingStore.ts';
import { entitiesRouter } from '../src/server/entities/routes.ts';
import { canonReviewRouter } from '../src/server/canon/reviewRoutes.ts';
import { lineupRouter } from '../src/server/lineup/routes.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';
import { writeEdition } from '../src/server/canon/editions.ts';
import { mergeCanonicalEditions } from '../src/server/lineup/canonicalIngest.ts';
import { runCanonBackfill } from '../src/server/canon/backfill.ts';
import type { Edition, EditionPerformance, LookupJob } from '../src/server/lineup/types.ts';
import { newEvent } from '../src/server/events/service.ts';

async function withFileStore(fn: (store: FileLineupStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'emc-'));
  try {
    await fn(new FileLineupStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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

const perf = (artistKey: string, name: string): EditionPerformance => ({
  artistKey,
  name,
  days: [],
  stages: [],
  status: 'billed',
  confidence: 0.9,
  sources: [{ sourceType: 'promoter', sourceUrl: 'https://fest.example', quotedSpan: name, evidence: 'billed', extractor: 'user' }],
});

function makeEntitiesApp(store: FileLineupStore, role: 'owner' | 'member' = 'owner') {
  const linked = withEntityLinks(store);
  const deps = { store: linked, now: () => new Date('2026-11-15T00:00:00.000Z') } as any;
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runAsMember({ role, uid: role === 'owner' ? 'u0' : 'u1' } as any, linked as any, next));
  app.use('/api', entitiesRouter(deps));
  return app;
}

function makeReviewApp(store: FileLineupStore, role: 'owner' | 'member' = 'owner') {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runAsMember({ role, uid: role === 'owner' ? 'u0' : 'u1' } as any, store as any, next));
  app.use('/api', canonReviewRouter(store));
  return app;
}

function makeLineupApp(store: FileLineupStore, role: 'owner' | 'member' = 'owner') {
  const deps = { store, now: () => new Date('2026-11-15T00:00:00.000Z') } as any;
  const runner = { kick: async () => undefined } as any;
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runAsMember({ role, uid: role === 'owner' ? 'u0' : 'u1' } as any, store as any, next));
  app.use('/api', lineupRouter(deps, runner));
  return app;
}

test('mergeCanonicalEditions when keep inherits venueId and subjectKey from drop (no self-clash)', async () => {
  await withFileStore(async (store) => {
    // keep has missing venueId and subjectKey
    await store.upsertEdition(ed('e-keep', 'Fest 2026', 2026, {
      startDate: '2026-06-01',
      venue: 'The Forum',
      performances: [perf('act1', 'Act 1')],
    }));
    // drop has venueId and subjectKey on the same date
    await store.upsertEdition(ed('e-drop', 'Fest 2026', 2026, {
      startDate: '2026-06-01',
      venue: 'The Forum',
      venueId: 'v-forum',
      subjectKey: 'fest',
      performances: [perf('act2', 'Act 2')],
    }));

    const res = await mergeCanonicalEditions(store, {
      keepId: 'e-keep',
      dropIds: ['e-drop'],
      actor: 'owner',
      reason: 'Merge into keep',
    });

    assert.equal(res.edition.id, 'e-keep');
    assert.equal(res.edition.venueId, 'v-forum');
    assert.equal(res.edition.subjectKey, 'fest');
    assert.equal(res.edition.performances.length, 2);
    assert.equal(await store.getEdition('e-drop'), null);
  });
});

test('mergeCanonicalEditions when combineAsWeekends or factChoices.startDate adopts drop startDate (no self-clash)', async () => {
  await withFileStore(async (store) => {
    // keep has different date
    await store.upsertEdition(ed('e-w1', 'Festival W1', 2026, {
      startDate: '2026-06-12',
      endDate: '2026-06-14',
      venue: 'The Park',
      venueId: 'v-park',
      subjectKey: 'fest-series',
      performances: [perf('act1', 'Act 1')],
    }));
    // drop has earlier startDate
    await store.upsertEdition(ed('e-w2', 'Festival W2', 2026, {
      startDate: '2026-06-05',
      endDate: '2026-06-07',
      venue: 'The Park',
      venueId: 'v-park',
      subjectKey: 'fest-series',
      performances: [perf('act2', 'Act 2')],
    }));

    // With combineAsWeekends, next.startDate becomes minStart (2026-06-05, matching drop)
    const res = await mergeCanonicalEditions(store, {
      keepId: 'e-w1',
      dropIds: ['e-w2'],
      combineAsWeekends: true,
      factChoices: { name: 'Festival 2026' },
      actor: 'owner',
      reason: 'Combine weekends',
    });

    assert.equal(res.edition.id, 'e-w1');
    assert.equal(res.edition.startDate, '2026-06-05');
    assert.equal(res.edition.endDate, '2026-06-14');
    assert.equal(res.edition.weekends?.length, 2);
    assert.equal(res.edition.performances.length, 2);
    assert.equal(await store.getEdition('e-w2'), null);

    // Also test factChoices.startDate adopting drop's startDate directly without weekends
    await store.upsertEdition(ed('e-sub1', 'Show 1', 2026, {
      startDate: '2026-07-10',
      venue: 'The Park',
      venueId: 'v-park',
      subjectKey: 'show-series',
    }));
    await store.upsertEdition(ed('e-sub2', 'Show 2', 2026, {
      startDate: '2026-07-01',
      venue: 'The Park',
      venueId: 'v-park',
      subjectKey: 'show-series',
    }));

    const res2 = await mergeCanonicalEditions(store, {
      keepId: 'e-sub1',
      dropIds: ['e-sub2'],
      factChoices: { startDate: '2026-07-01' },
      actor: 'owner',
      reason: 'Adopt drop date',
    });
    assert.equal(res2.edition.id, 'e-sub1');
    assert.equal(res2.edition.startDate, '2026-07-01');
    assert.equal(await store.getEdition('e-sub2'), null);
  });
});

test('mergeCanonicalEditions throws EditionOccurrenceConflictError with conflictingEdition before mutating when clashing with a third edition', async () => {
  await withFileStore(async (store) => {
    // keep edition
    await store.upsertEdition(ed('e-keep', 'Fest Keep', 2026, {
      startDate: '2026-08-10',
      venue: 'The Grounds',
      venueId: 'v-grounds',
      subjectKey: 'fest',
    }));
    // drop edition
    await store.upsertEdition(ed('e-drop', 'Fest Drop', 2026, {
      startDate: '2026-08-15',
      venue: 'The Grounds',
      venueId: 'v-grounds',
      subjectKey: 'fest',
    }));
    // third edition already holding 2026-08-01
    await store.upsertEdition(ed('e-third', 'Fest Existing', 2026, {
      startDate: '2026-08-01',
      venue: 'The Grounds',
      venueId: 'v-grounds',
      subjectKey: 'fest',
    }));

    let mergeEditionsCalled = false;
    let stampCalled = false;
    const origMerge = store.mergeEditions.bind(store);
    store.mergeEditions = async (...args) => {
      mergeEditionsCalled = true;
      return origMerge(...args);
    };
    const origStamp = store.stampUnsetWeekend.bind(store);
    store.stampUnsetWeekend = async (...args) => {
      stampCalled = true;
      return origStamp(...args);
    };

    // Merging e-keep and e-drop while choosing startDate = 2026-08-01 clashes with e-third
    await assert.rejects(
      mergeCanonicalEditions(store, {
        keepId: 'e-keep',
        dropIds: ['e-drop'],
        factChoices: { startDate: '2026-08-01' },
        actor: 'owner',
      }),
      (err: any) => {
        assert.ok(err instanceof EditionOccurrenceConflictError);
        assert.equal(err.name, 'EditionOccurrenceConflictError');
        assert.equal(err.editionId, 'e-keep');
        assert.equal(err.startDate, '2026-08-01');
        assert.equal(err.venueId, 'v-grounds');
        assert.equal(err.subjectKey, 'fest');
        assert.deepEqual(err.conflictingEdition, { id: 'e-third', key: 'e-third/2026', name: 'Fest Existing' });
        assert.match(err.message, /Edition e-keep clashes with edition e-third \(Fest Existing\)/);
        return true;
      },
    );

    // Verify no mutations happened
    assert.equal(mergeEditionsCalled, false, 'mergeEditions must not be called when conflict is detected');
    assert.equal(stampCalled, false, 'stampUnsetWeekend must not be called when conflict is detected');
    assert.ok(await store.getEdition('e-drop'), 'e-drop must not be deleted');
  });
});

test('HTTP 409 responses with conflictingEdition in entities/routes.ts (merge, confirm, facts, verify)', async () => {
  await withFileStore(async (store) => {
    const app = makeEntitiesApp(store, 'owner');
    await store.upsertEdition(ed('e-clash', 'Clashing Show', 2026, {
      startDate: '2026-09-01',
      venue: 'The Hall',
      venueId: 'v-hall',
      subjectKey: 'band-x',
    }));
    await store.upsertEdition(ed('e-keep', 'Show Keep', 2026, {
      startDate: '2026-09-10',
      venue: 'The Hall',
      venueId: 'v-hall',
      subjectKey: 'band-x',
    }));
    await store.upsertEdition(ed('e-drop', 'Show Drop', 2026, {
      startDate: '2026-09-15',
      venue: 'The Hall',
      venueId: 'v-hall',
      subjectKey: 'band-x',
    }));

    // 1. Merge route returns 409
    const mergeRes = await dispatch(app, {
      url: '/api/manage/canonical/editions/e-keep/merge',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { dropIds: ['e-drop'], factChoices: { startDate: '2026-09-01' } },
    });
    assert.equal(mergeRes.status, 409);
    const mergeBody = (await mergeRes.json()) as any;
    assert.match(mergeBody.error, /Edition e-keep clashes with edition e-clash/);
    assert.deepEqual(mergeBody.conflictingEdition, { id: 'e-clash', key: 'e-clash/2026', name: 'Clashing Show' });

    // 2. Edit facts route returns 409
    const factsRes = await dispatch(app, {
      url: '/api/manage/canonical/editions/e-keep/facts',
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: { name: 'Show Keep', startDate: '2026-09-01', sourceNote: 'Source note' },
    });
    assert.equal(factsRes.status, 409);
    const factsBody = (await factsRes.json()) as any;
    assert.match(factsBody.error, /clashes with edition e-clash/);
    assert.deepEqual(factsBody.conflictingEdition, { id: 'e-clash', key: 'e-clash/2026', name: 'Clashing Show' });

    // 3. Confirm route returns 409 when applying a conflicting edition
    await store.upsertSeries({ slug: 'band-x', name: 'Band X' });
    const origUpsertConf = store.upsertEdition.bind(store);
    store.upsertEdition = async (edition) => {
      if (edition.name === 'New Confirmed Show') {
        throw new EditionOccurrenceConflictError(edition.id, edition.startDate, 'v-hall', 'band-x', {
          id: 'e-clash',
          key: 'e-clash/2026',
          name: 'Clashing Show',
        });
      }
      return origUpsertConf(edition);
    };
    const confirmRes = await dispatch(app, {
      url: '/api/manage/canonical/confirm',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: {
        editionId: 'e-new',
        name: 'New Confirmed Show',
        year: 2026,
        startDate: '2026-09-01',
        venue: 'The Hall',
        seriesSlug: 'band-x',
        performers: [{ name: 'Band X' }],
        apply: true,
      },
    });
    assert.equal(confirmRes.status, 409);
    const confirmBody = (await confirmRes.json()) as any;
    assert.match(confirmBody.error, /clashes with edition e-clash/);
    assert.deepEqual(confirmBody.conflictingEdition, { id: 'e-clash', key: 'e-clash/2026', name: 'Clashing Show' });
    store.upsertEdition = origUpsertConf;

    // 4. Verify route returns 409 if writing verified status causes occurrence clash
    // To test this cleanly, create a provisional edition and simulate collision during verify
    await store.upsertEdition(ed('e-prov', 'Provisional', 2026, {
      status: 'provisional',
      startDate: '2026-09-20',
      venueId: 'v-hall',
      subjectKey: 'band-x',
    }));
    // Override upsertEdition temporarily to throw conflict when e-prov is verified
    const origUpsert = store.upsertEdition.bind(store);
    store.upsertEdition = async (edition) => {
      if (edition.id === 'e-prov' && edition.status === 'verified') {
        throw new EditionOccurrenceConflictError(edition.id, edition.startDate, edition.venueId, edition.subjectKey, {
          id: 'e-clash',
          key: 'e-clash/2026',
          name: 'Clashing Show',
        });
      }
      return origUpsert(edition);
    };
    const verifyRes = await dispatch(app, {
      url: '/api/manage/canonical/editions/e-prov/verify',
      method: 'POST',
    });
    assert.equal(verifyRes.status, 409);
    const verifyBody = (await verifyRes.json()) as any;
    assert.match(verifyBody.error, /clashes with edition e-clash/);
    assert.deepEqual(verifyBody.conflictingEdition, { id: 'e-clash', key: 'e-clash/2026', name: 'Clashing Show' });
  });
});

test('HTTP 409 responses with conflictingEdition in canon/reviewRoutes.ts (promote, verify, undo)', async () => {
  await withFileStore(async (store) => {
    const app = makeReviewApp(store, 'owner');
    await store.upsertEdition(ed('e-clash', 'Clashing Fest', 2026, {
      startDate: '2026-10-01',
      venueId: 'v-arena',
      subjectKey: 'fest-z',
    }));
    await store.upsertEdition(ed('e-rev', 'Review Fest', 2026, {
      startDate: '2026-10-10',
      venueId: 'v-arena',
      subjectKey: 'fest-z',
    }));

    // 1. Promote route hitting conflict
    const item = await store.addReviewItem({
      kind: 'override',
      editionId: 'e-rev',
      payload: { field: 'startDate', old: '2026-10-10', new: '2026-10-01' },
    });
    const promoteRes = await dispatch(app, {
      url: `/api/canon/review/${item.id}/promote`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: {},
    });
    assert.equal(promoteRes.status, 409);
    const promoteBody = (await promoteRes.json()) as any;
    assert.match(promoteBody.error, /clashes with edition e-clash/);
    assert.deepEqual(promoteBody.conflictingEdition, { id: 'e-clash', key: 'e-clash/2026', name: 'Clashing Fest' });

    // 2. Verify route in review queue hitting conflict
    await store.upsertEdition(ed('e-prov-rev', 'Prov Fest', 2026, {
      status: 'provisional',
      startDate: '2026-10-20',
      venueId: 'v-arena',
      subjectKey: 'fest-z',
    }));
    const provItem = await store.addReviewItem({
      kind: 'provisional',
      editionId: 'e-prov-rev',
      payload: {},
    });
    const origUpsert = store.upsertEdition.bind(store);
    store.upsertEdition = async (edition) => {
      if (edition.id === 'e-prov-rev') {
        throw new EditionOccurrenceConflictError(edition.id, edition.startDate, edition.venueId, edition.subjectKey, {
          id: 'e-clash',
          key: 'e-clash/2026',
          name: 'Clashing Fest',
        });
      }
      return origUpsert(edition);
    };
    const verifyReviewRes = await dispatch(app, {
      url: `/api/canon/review/${provItem.id}/verify`,
      method: 'POST',
    });
    assert.equal(verifyReviewRes.status, 409);
    const verifyReviewBody = (await verifyReviewRes.json()) as any;
    assert.match(verifyReviewBody.error, /clashes with edition e-clash/);
    assert.deepEqual(verifyReviewBody.conflictingEdition, { id: 'e-clash', key: 'e-clash/2026', name: 'Clashing Fest' });
    store.upsertEdition = origUpsert;

    // 3. Undo route hitting conflict
    const change = await store.recordEditionChange({
      editionId: 'e-rev',
      actor: 'owner',
      reason: 'test change',
      before: { startDate: '2026-10-01' },
      after: { startDate: '2026-10-10' },
    });
    // Undoing would restore startDate: '2026-10-01', which clashes with e-clash!
    const undoRes = await dispatch(app, {
      url: `/api/canon/changes/${change.id}/undo`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { editionId: 'e-rev' },
    });
    assert.equal(undoRes.status, 409);
    const undoBody = (await undoRes.json()) as any;
    assert.match(undoBody.error, /clashes with edition e-clash/);
    assert.deepEqual(undoBody.conflictingEdition, { id: 'e-clash', key: 'e-clash/2026', name: 'Clashing Fest' });
  });
});

test('HTTP 409 response with conflictingEdition in lineup/routes.ts (/lookups/:id/confirm)', async () => {
  await withFileStore(async (store) => {
    const app = makeLineupApp(store, 'owner');
    const job: LookupJob = {
      id: 'job-1',
      kind: 'lineup',
      editionKey: 'fest-test/2026-11-01',
      status: 'needs_review',
      stage: 'done',
      input: { eventName: 'Fest Test', year: 2026 },
      attempts: 1,
      pendingExtraction: [],
      discoveryDone: true,
      facts: {},
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.createJob(job);

    // Mock confirmLookup by throwing EditionOccurrenceConflictError
    // In lineup/routes.ts, confirmLookup is called. We can spy on store.upsertEdition or inject via store:
    const origGetJob = store.getJob.bind(store);
    store.getJob = async (id) => {
      const j = await origGetJob(id);
      if (j && id === 'job-1') {
        // Return job
        return j;
      }
      return j;
    };
    // Cause confirm to trigger EditionOccurrenceConflictError
    const origUpsert = store.upsertEdition.bind(store);
    store.upsertEdition = async (e) => {
      throw new EditionOccurrenceConflictError(e.id, '2026-11-01', 'v-1', 'fest-test', {
        id: 'e-existing',
        key: 'e-existing/2026',
        name: 'Existing Fest',
      });
    };

    const res = await dispatch(app, {
      url: '/api/lookups/job-1/confirm',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { name: 'Fest Test', year: 2026, performers: [{ name: 'Artist A' }] },
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as any;
    assert.match(body.error, /Edition .* clashes with edition e-existing \(Existing Fest\)/);
    assert.deepEqual(body.conflictingEdition, { id: 'e-existing', key: 'e-existing/2026', name: 'Existing Fest' });
  });
});

test('runCanonBackfill enqueues merge_suggestion when fillEdition hits EditionOccurrenceConflictError', async () => {
  await withFileStore(async (store) => {
    // e1 is missing venueId and subjectKey, but has venue text 'The Arena' and seriesSlug 'fest'
    await store.upsertEdition(ed('e1', 'Fest A', 2026, {
      startDate: '2026-12-01',
      venue: 'The Arena',
      seriesSlug: 'fest',
    }));
    // e2 already has venueId for 'The Arena' and subjectKey 'fest' on the same date
    const v = await store.upsertVenue({ name: 'The Arena' });
    await store.upsertEdition(ed('e2', 'Fest A Verified', 2026, {
      startDate: '2026-12-01',
      venue: 'The Arena',
      venueId: v.id,
      subjectKey: 'fest',
    }));

    // In runCanonBackfill, item.kind === 'edition' will process e1.
    // fillEdition sets e1.venueId = v.id and e1.subjectKey = 'fest'.
    // upsertEdition will clash with e2!
    const report = (await runCanonBackfill(store))!;
    assert.ok(report);
    assert.equal(report.skipped_other, 1);

    // Verify a merge_suggestion review queue item was enqueued
    const reviews = await store.listReviewItems({ kind: 'merge_suggestion' });
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].editionId, 'e1');
    assert.deepEqual((reviews[0].payload as any).editionIds, ['e1', 'e2']);
    assert.equal((reviews[0].payload as any).startDate, '2026-12-01');

    // Verify e1 was marked done in the cursor so it is not retried
    const cursor = (await store.getSetting<any>('canon_backfill'))!;
    assert.ok(cursor.done.includes('edition:e1'));
  });
});
