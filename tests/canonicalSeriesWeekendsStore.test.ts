import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { SupabaseLineupStore } from '../src/server/lineup/store/supabaseStore.ts';
import { canonicalEditionPage, suggestEditionMatches } from '../src/server/lineup/store/types.ts';
import type { Edition, EditionPerformance, SourceAdapter } from '../src/server/lineup/types.ts';
import { listCanonicalEditions, summarizeEdition } from '../src/server/entities/canonicalManage.ts';
import { createLookup, runJob, type PipelineDeps } from '../src/server/lineup/pipeline.ts';
import { confirmLookup, confirmLookupForMember } from '../src/server/lineup/learning.ts';
import { makeDocument } from '../src/server/lineup/adapters/common.ts';
import { newEvent } from '../src/server/events/service.ts';
import { fakeFetcher } from './fakes.ts';

async function withFileStore(fn: (store: FileLineupStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'series-weekends-'));
  try {
    await fn(new FileLineupStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const perf = (artistKey: string, name: string, over: Partial<EditionPerformance> = {}): EditionPerformance => ({
  artistKey,
  name,
  days: [],
  stages: [],
  status: 'billed',
  confidence: 0.9,
  sources: [{ sourceType: 'promoter', sourceUrl: 'https://fest.example', quotedSpan: name, evidence: 'billed', extractor: 'user' }],
  ...over,
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

test('nullable seriesSlug: FileLineupStore, canonicalEditionPage, listCanonicalEditions, and suggestEditionMatches never match undefined or null', async () => {
  await withFileStore(async (store) => {
    await store.upsertEdition(ed('s1', 'Standalone Show', 2026, { venue: 'Fox Theater', region: 'CA', country: 'US' }));
    const loaded = await store.getEdition('s1');
    assert.equal(loaded?.seriesSlug, undefined);
    assert.equal(loaded?.region, 'CA');

    const pageNoMatch = canonicalEditionPage([loaded!], { query: 'undefined', limit: 20 });
    assert.equal(pageNoMatch.total, 0);
    const pageNullMatch = canonicalEditionPage([loaded!], { query: 'null', limit: 20 });
    assert.equal(pageNullMatch.total, 0);

    assert.equal(listCanonicalEditions([loaded!], { query: 'undefined' }).length, 0);
    assert.equal(listCanonicalEditions([loaded!], { query: 'null' }).length, 0);
    const summary = summarizeEdition(loaded!);
    assert.equal(summary.seriesSlug, null);
    assert.equal(summary.region, 'CA');
    assert.deepEqual(summary.weekends, []);

    assert.deepEqual(suggestEditionMatches([loaded!], 'undefined', { excludeIds: [], limit: 8 }), []);
    assert.deepEqual(suggestEditionMatches([loaded!], 'null', { excludeIds: [], limit: 8 }), []);
    assert.deepEqual(
      suggestEditionMatches([loaded!], 'standalone', { excludeIds: [], limit: 8 }).map((x) => x.id),
      ['s1'],
    );
  });
});

test('suggestEditionMatches matches across seriesName, seriesBrand, and seriesAliases and supports multi-weekend re-selection', async () => {
  await withFileStore(async (store) => {
    await store.upsertSeries({
      slug: 'coachella',
      name: 'Coachella Valley Music and Arts Festival',
      brand: 'Goldenvoice',
      aliases: ['Chella', 'Coachella Fest'],
    });
    const w1 = { weekend: 1, startDate: '2026-04-10', endDate: '2026-04-12' };
    const w2 = { weekend: 2, startDate: '2026-04-17', endDate: '2026-04-19' };
    await store.upsertEdition(
      ed('c26', 'Coachella 2026', 2026, {
        seriesSlug: 'coachella',
        region: 'CA',
        country: 'US',
        weekends: [w1, w2],
      }),
    );

    assert.deepEqual((await store.suggestEditions('goldenvoice', { excludeIds: [], limit: 8 })).map((s) => s.id), ['c26']);
    assert.deepEqual((await store.suggestEditions('chella', { excludeIds: [], limit: 8 })).map((s) => s.id), ['c26']);
    const hit = (await store.suggestEditions('valley', { excludeIds: [], limit: 8 }))[0];
    assert.equal(hit.seriesSlug, 'coachella');
    assert.equal(hit.seriesName, 'Coachella Valley Music and Arts Festival');
    assert.equal(hit.seriesBrand, 'Goldenvoice');
    assert.equal(hit.region, 'CA');
    assert.deepEqual(hit.weekends, [w1, w2]);

    // Multi-weekend edition stays selectable when only weekend 1 is logged.
    const oneLogged = await store.suggestEditions('coachella', {
      excludeIds: ['c26'],
      limit: 8,
      loggedWeekendsByEdition: { c26: [1] },
    });
    assert.deepEqual(oneLogged.map((s) => s.id), ['c26']);

    // Once both weekends are logged, it is excluded.
    const bothLogged = await store.suggestEditions('coachella', {
      excludeIds: ['c26'],
      limit: 8,
      loggedWeekendsByEdition: { c26: [1, 2] },
    });
    assert.deepEqual(bothLogged, []);
  });
});

test('FileLineupStore implements listSeries, mergeSeries, getEditionHeaders, listEditionHeaders, listEditionArtistRefs, and stampUnsetWeekend', async () => {
  await withFileStore(async (store) => {
    await store.upsertSeries({
      slug: 'edc-lv',
      name: 'EDC Las Vegas',
      brand: 'Insomniac',
      aliases: ['Electric Daisy Carnival'],
      clashfinderSlugs: { '2025': 'edclv25' },
    });
    await store.upsertSeries({
      slug: 'edc-las-vegas-alt',
      name: 'EDC LV',
      aliases: ['Electric Daisy Carnival', 'EDCLV'],
      lineupUrl: 'https://lasvegas.electricdaisycarnival.com/lineup/',
      clashfinderSlugs: { '2024': 'edclv24', '2025': 'old25' },
      sourcePriority: ['promoter', 'clashfinder'],
    });

    await store.upsertEdition(
      ed('ed1', 'EDC Las Vegas 2025', 2025, {
        seriesSlug: 'edc-lv',
        startDate: '2025-05-16',
        weekends: [{ weekend: 1, startDate: '2025-05-16', endDate: '2025-05-18' }],
        performances: [perf('kaskade', 'Kaskade'), perf('cancelled-dj', 'Cancelled DJ', { status: 'cancelled' })],
      }),
    );
    await store.upsertEdition(
      ed('ed2', 'EDC Las Vegas 2024', 2024, {
        seriesSlug: 'edc-las-vegas-alt',
        startDate: '2024-05-17',
        status: 'provisional',
        performances: [perf('dom-dolla', 'Dom Dolla')],
      }),
    );

    const listed = await store.listSeries({ brand: 'insomniac' });
    assert.deepEqual(listed.map((s) => [s.slug, s.editionCount]), [['edc-lv', 1]]);

    const merged = await store.mergeSeries('edc-lv', 'edc-las-vegas-alt');
    assert.equal(merged.editions_moved, 1);
    assert.equal(await store.getSeries('edc-las-vegas-alt'), null);
    const keep = await store.getSeries('edc-lv');
    assert.ok(keep);
    assert.equal(keep.brand, 'Insomniac');
    assert.equal(keep.lineupUrl, 'https://lasvegas.electricdaisycarnival.com/lineup/');
    assert.deepEqual(keep.sourcePriority, ['promoter', 'clashfinder']);
    assert.deepEqual(keep.clashfinderSlugs, { '2024': 'edclv24', '2025': 'edclv25' });
    assert.deepEqual(keep.aliases, ['Electric Daisy Carnival', 'EDCLV', 'EDC LV']);

    assert.equal((await store.getEdition('ed2'))?.seriesSlug, 'edc-lv');

    const headers = await store.getEditionHeaders(['ed1', 'ed2']);
    assert.equal(headers.length, 2);
    assert.equal('performances' in headers[0], false);
    assert.equal(headers[0].seriesBrand, 'Insomniac');

    const filteredHeaders = await store.listEditionHeaders({ seriesSlug: 'edc-lv', status: 'verified' });
    assert.deepEqual(filteredHeaders.map((h) => h.id), ['ed1']);

    const refs = await store.listEditionArtistRefs({ verifiedOnly: true });
    assert.deepEqual(
      refs.map((r) => [r.editionId, r.artistKey, r.status]),
      [
        ['ed1', 'kaskade', 'billed'],
        ['ed1', 'cancelled-dj', 'cancelled'],
      ],
    );

    const now = new Date('2026-01-01T00:00:00.000Z');
    await store.putEvent({ ...newEvent('EDC 2025', now), id: 'ev-unset', name: 'EDC 2025', editionId: 'ed1' });
    await store.putEvent({ ...newEvent('EDC 2025 W2', now), id: 'ev-set', name: 'EDC 2025', editionId: 'ed1', weekend: 2 });
    await store.putEvent({ ...newEvent('EDC 2025 deleted', now), id: 'ev-deleted', name: 'EDC 2025', editionId: 'ed1' });
    await store.deleteEvent('ev-deleted');

    const stamped = await store.stampUnsetWeekend('ed1', 1);
    assert.equal(stamped, 1);
    assert.equal((await store.getEvent('ev-unset'))?.weekend, 1);
    assert.equal((await store.getEvent('ev-set'))?.weekend, 2);
  });
});

test('pipeline and learning do not auto-create event_series stubs for standalone concerts', async () => {
  await withFileStore(async (store) => {
    const adapter: SourceAdapter = {
      id: 'ticketmaster',
      enabled: () => true,
      async collect() {
        const doc = makeDocument('https://tm.example/solo', 'ticketmaster', '{}', 'json');
        return {
          documents: [doc],
          performers: [
            {
              documentId: doc.id,
              sourceType: 'ticketmaster',
              sourceUrl: doc.url,
              name: 'Solo Artist',
              quotedSpan: 'Solo Artist',
              evidence: 'billed',
              extractor: 'ticketmaster',
              extractorVersion: '1',
            },
          ],
          facts: { startDate: [{ value: '2026-09-01', sourceType: 'ticketmaster', sourceUrl: doc.url }] },
          extractionQueue: [],
          notes: [],
        };
      },
    };
    const deps: PipelineDeps = {
      store,
      fetcher: fakeFetcher({}).fetcher,
      adapters: [adapter],
      lateAdapters: [],
      gemini: null,
      quota: null,
      search: null,
      now: () => new Date('2026-09-02T00:00:00.000Z'),
    };
    const job = (await runJob(deps, (await createLookup(deps, { eventName: 'Solo Artist', year: 2026 })).id))!;
    assert.equal(await store.getSeries('solo-artist'), null);

    const confirmed = await confirmLookup(store, job, {
      performers: [{ key: 'solo artist', name: 'Solo Artist', accepted: true, seen: true }],
    });
    assert.equal(await store.getSeries('solo-artist'), null);
    assert.equal(confirmed.edition.seriesSlug, undefined);
    assert.equal(confirmed.edition.subjectKey, 'solo-artist');

    // Member draft review also omits seriesSlug when no event_series exists.
    await store.putEvent({ ...newEvent('Club Night 2026', new Date('2026-01-01T00:00:00.000Z')), id: 'm-ev', name: 'Club Night' });
    const memberJob = {
      id: 'mj1',
      kind: 'lineup' as const,
      input: { eventName: 'Club Night', year: 2026 },
      editionKey: 'club-night/2026',
      status: 'needs_review' as const,
      stage: 'done' as const,
      attempts: 1,
      pendingExtraction: [],
      discoveryDone: true,
      facts: {},
      eventId: 'm-ev',
      candidate: {
        editionKey: 'club-night/2026',
        cached: false,
        facts: { sources: {} },
        performers: [],
        droppedCount: 0,
      },
      log: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await store.createJob(memberJob);
    const memberRes = await confirmLookupForMember(store, memberJob, { performers: [] });
    assert.equal(memberRes.edition.seriesSlug, undefined);
  });
});

test('SupabaseLineupStore: upsertEdition skips event_series when seriesSlug is absent, editionLineupFacts uses RPC, and suggestEditions caps at 60', async () => {
  const upserts: Array<{ table: string; payload: any }> = [];
  const rpcCalls: Array<{ fn: string; args: any }> = [];
  const editionSelects: Array<{ columns?: string; limit?: number; or?: string }> = [];

  class MockBuilder {
    private cols?: string;
    private lim?: number;
    private orExpr?: string;
    constructor(private readonly table: string) {}
    select(columns?: string) {
      this.cols = columns;
      return this;
    }
    in() {
      return this;
    }
    eq() {
      return this;
    }
    or(expr: string) {
      this.orExpr = expr;
      return this;
    }
    order() {
      return this;
    }
    limit(n: number) {
      this.lim = n;
      return this;
    }
    delete() {
      return this;
    }
    upsert(payload: any) {
      upserts.push({ table: this.table, payload });
      return Promise.resolve({ data: null, error: null });
    }
    insert(payload: any) {
      upserts.push({ table: this.table, payload });
      return Promise.resolve({ data: null, error: null });
    }
    maybeSingle() {
      return Promise.resolve({ data: null, error: null });
    }
    then(resolve: (v: any) => unknown) {
      if (this.table === 'event_editions') {
        editionSelects.push({ columns: this.cols, limit: this.lim, or: this.orExpr });
        return Promise.resolve({
          data: [
            {
              id: 'ed-brand',
              key: 'edc/2026',
              series_slug: 'edc-lv',
              year: 2026,
              name: 'EDC 2026',
              start_date: '2026-05-15',
              end_date: '2026-05-17',
              venue: 'Motor Speedway',
              city: 'Las Vegas',
              region: 'NV',
              country: 'US',
              weekends: [{ weekend: 1, startDate: '2026-05-15', endDate: '2026-05-17' }],
              status: 'verified',
              updated_at: '2026-01-01T00:00:00.000Z',
              event_series: { name: 'EDC Las Vegas', brand: 'Insomniac', aliases: ['EDCLV'] },
            },
          ],
          error: null,
        }).then(resolve);
      }
      return Promise.resolve({ data: [], error: null }).then(resolve);
    }
  }

  const dbWithRpc = {
    from: (table: string) => new MockBuilder(table),
    rpc: (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      if (fn === 'edition_lineup_facts') {
        return Promise.resolve({
          data: [{ edition_id: 'ed-brand', act_count: 12, has_clashfinder: true }],
          error: null,
        });
      }
      if (fn === 'list_canonical_series_summary') {
        return Promise.resolve({
          data: [
            {
              slug: 'edc-lv',
              name: 'EDC Las Vegas',
              brand: 'Insomniac',
              aliases: ['EDCLV'],
              lineup_url: null,
              clashfinder_slugs: {},
              source_priority: null,
              edition_count: 1,
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };

  const store = new SupabaseLineupStore(dbWithRpc as any);
  await store.upsertEdition(ed('standalone-1', 'Standalone Concert', 2026, { region: 'CA' }));
  assert.equal(upserts.some((u) => u.table === 'event_series'), false);
  const edUpsert = upserts.find((u) => u.table === 'event_editions')?.payload;
  assert.equal(edUpsert.series_slug, null);
  assert.equal(edUpsert.region, 'CA');
  assert.deepEqual(edUpsert.weekends, []);

  const facts = await store.editionLineupFacts(['ed-brand', 'ed-empty']);
  assert.equal(rpcCalls[0].fn, 'edition_lineup_facts');
  assert.deepEqual(facts['ed-brand'], { acts: 12, clashfinder: true });
  assert.deepEqual(facts['ed-empty'], { acts: 0, clashfinder: false });

  const suggested = await store.suggestEditions('insomniac', { excludeIds: [], limit: 8 });
  assert.equal(suggested.length, 1);
  assert.equal(suggested[0].actCount, 12);
  assert.equal(suggested[0].seriesBrand, 'Insomniac');
  assert.equal(suggested[0].region, 'NV');
  assert.equal(editionSelects[0].limit, 60);
  assert.ok(editionSelects[0].columns?.includes('event_series(name, brand, aliases)'));
  assert.ok(editionSelects[0].or?.includes('series_slug.in.("edc-lv")'));

  // Without rpc(), editionLineupFacts falls back to performances select.
  const dbNoRpc = {
    from: () => ({
      select: () => ({
        in: () =>
          Promise.resolve({
            data: [{ edition_id: 'ed1', status: 'billed', sources: [{ sourceType: 'clashfinder' }] }],
            error: null,
          }),
      }),
    }),
  };
  const fallbackStore = new SupabaseLineupStore(dbNoRpc as any);
  const fbFacts = await fallbackStore.editionLineupFacts(['ed1']);
  assert.deepEqual(fbFacts.ed1, { acts: 1, clashfinder: true });
});
