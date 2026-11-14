import { dispatch } from './helpers/testApp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import {
  confirmCanonicalEdition,
  parseCanonicalInput,
} from '../src/server/lineup/canonicalIngest.ts';
import { entitiesRouter } from '../src/server/entities/routes.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';
import {
  researchEditionFacts,
  type DetailFinder,
  type DetailQuery,
} from '../src/server/events/details.ts';
import type { DetailCandidate, EventDetails } from '../src/server/events/types.ts';
import type { Fetcher } from '../src/server/lineup/types.ts';
import { canonicalApi } from '../src/services/lineupApi.ts';

// Check details for canonical edition facts (GA4 / Slice 12.6):
// Owner-only, checks draft or stored edition facts against structured sources
// without touching logged_events or personal data.

const store = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'edition-details-')));
const base = {
  name: 'Portola Music Festival',
  year: 2024,
  startDate: '2024-09-28',
  endDate: '2024-09-29',
  venue: 'Pier 80',
  city: 'San Francisco, CA',
  performers: [
    { name: 'Rüfüs Du Sol', billing: 'headliner' as const, days: ['2024-09-28'], stages: ['Pier Stage'], set: 'DJ Set' },
    { name: 'Lane 8' },
  ],
};
const SAVED = 'portola-music-festival/2024-09-28';

async function withRole(
  role: string,
  s: any,
  finders: DetailFinder[] = [],
  fn: (app: express.Express) => Promise<void>,
) {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runAsMember({ role, uid: 'u1' } as any, s, next));
  app.use('/api', entitiesRouter({ store: s } as any, finders));
  await fn(app);
}

const post = (app: express.Express, path: string, body?: unknown) =>
  dispatch(app, { method: 'POST', url: path, headers: { 'content-type': 'application/json' }, body });

test('non-owner (member) gets 403 on edition details check and store is not queried', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  const edition = (await s.getEditionByKey(SAVED))!;

  let finderCalled = false;
  const mockFinder: DetailFinder = {
    id: 'discovered',
    enabled: () => true,
    withoutYear: true,
    async find(): Promise<DetailCandidate[]> {
      finderCalled = true;
      return [];
    },
  };

  await withRole('member', s, [mockFinder], async (app) => {
    const res = await post(app, `/api/manage/canonical/editions/${edition.id}/details`, {});
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, 'Only the owner can do this.');
  });

  assert.equal(finderCalled, false, 'finders must not run for non-owner');
  assert.deepEqual(await s.listEvents(), [], 'logged_events must remain untouched');
});

test('returns 404 when the requested edition does not exist', async () => {
  const s = await store();
  await withRole('owner', s, [], async (app) => {
    const res = await post(app, `/api/manage/canonical/editions/nonexistent-id/details`, {});
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, 'Edition not found.');
  });
  assert.deepEqual(await s.listEvents(), [], 'logged_events must remain untouched');
});

test('runs finders with stored edition values when body is empty, without touching logged_events', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  const edition = (await s.getEditionByKey(SAVED))!;

  const queries: DetailQuery[] = [];
  const mockFinder: DetailFinder = {
    id: 'ticketmaster',
    enabled: () => true,
    withoutYear: true,
    async find(q: DetailQuery): Promise<DetailCandidate[]> {
      queries.push(q);
      return [
        {
          id: 'tm-1',
          name: q.name,
          startDate: q.startDate,
          endDate: q.endDate,
          venue: q.venue,
          city: q.city,
          sources: [{ sourceType: 'ticketmaster', sourceUrl: 'https://tm.example/portola', fields: ['startDate', 'venue', 'city'] }],
        },
      ];
    },
  };

  await withRole('owner', s, [mockFinder], async (app) => {
    const res = await post(app, `/api/manage/canonical/editions/${edition.id}/details`, {});
    assert.equal(res.status, 200);
    const body = (await res.json()) as EventDetails;
    assert.equal(body.status, 'matched');
    assert.equal(body.candidates.length, 1);
    assert.equal(body.candidates[0].name, 'Portola Music Festival');
    assert.equal(body.candidates[0].startDate, '2024-09-28');
  });

  assert.equal(queries.length, 1);
  assert.equal(queries[0].name, 'Portola Music Festival');
  assert.equal(queries[0].year, 2024);
  assert.equal(queries[0].startDate, '2024-09-28');
  assert.equal(queries[0].endDate, '2024-09-29');
  assert.equal(queries[0].venue, 'Pier 80');
  assert.equal(queries[0].city, 'San Francisco, CA');

  // Verify database state: stored edition is unchanged and logged_events is empty
  const storedAgain = (await s.getEdition(edition.id))!;
  assert.equal(storedAgain.name, 'Portola Music Festival');
  assert.equal(storedAgain.venue, 'Pier 80');
  assert.deepEqual(await s.listEvents(), []);
});

test('runs finders with draft form values overriding stored values, without mutating stored edition or logged_events', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  const edition = (await s.getEditionByKey(SAVED))!;

  const queries: DetailQuery[] = [];
  const mockFinder: DetailFinder = {
    id: 'setlistfm',
    enabled: () => true,
    withoutYear: true,
    async find(q: DetailQuery): Promise<DetailCandidate[]> {
      queries.push(q);
      return [
        {
          id: 'setlist-1',
          name: q.name,
          startDate: q.startDate,
          endDate: q.endDate,
          venue: q.venue,
          city: q.city,
          sources: [{ sourceType: 'setlistfm', sourceUrl: 'https://setlist.example/portola2025', fields: ['startDate', 'venue', 'city'] }],
        },
      ];
    },
  };

  const draft = {
    name: 'Portola 2025 Draft',
    startDate: '2025-10-04',
    endDate: '2025-10-05',
    venue: 'Pier 70',
    city: 'San Francisco, CA',
  };

  await withRole('owner', s, [mockFinder], async (app) => {
    const res = await post(app, `/api/manage/canonical/editions/${edition.id}/details`, draft);
    assert.equal(res.status, 200);
    const body = (await res.json()) as EventDetails;
    assert.equal(body.status, 'matched');
    assert.equal(body.candidates[0].name, 'Portola 2025 Draft');
    assert.equal(body.candidates[0].startDate, '2025-10-04');
  });

  assert.equal(queries.length, 1);
  assert.equal(queries[0].name, 'Portola 2025 Draft');
  assert.equal(queries[0].year, 2025);
  assert.equal(queries[0].startDate, '2025-10-04');
  assert.equal(queries[0].endDate, '2025-10-05');
  assert.equal(queries[0].venue, 'Pier 70');
  assert.equal(queries[0].city, 'San Francisco, CA');

  // Stored edition in database still has the original 2024 values
  const storedAgain = (await s.getEdition(edition.id))!;
  assert.equal(storedAgain.name, 'Portola Music Festival');
  assert.equal(storedAgain.startDate, '2024-09-28');
  assert.equal(storedAgain.venue, 'Pier 80');
  assert.deepEqual(await s.listEvents(), []);
});

test('partial draft values blend draft fields with stored edition fields', async () => {
  const s = await store();
  await confirmCanonicalEdition(s, parseCanonicalInput({ ...base, apply: true }));
  const edition = (await s.getEditionByKey(SAVED))!;

  const queries: DetailQuery[] = [];
  const mockFinder: DetailFinder = {
    id: 'discovered',
    enabled: () => true,
    withoutYear: true,
    async find(q: DetailQuery): Promise<DetailCandidate[]> {
      queries.push(q);
      return [];
    },
  };

  await withRole('owner', s, [mockFinder], async (app) => {
    // Only override venue in the draft
    const res = await post(app, `/api/manage/canonical/editions/${edition.id}/details`, { venue: 'Cow Palace' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as EventDetails;
    assert.equal(body.status, 'none');
  });

  assert.equal(queries.length, 1);
  assert.equal(queries[0].name, 'Portola Music Festival', 'name preserved from stored edition');
  assert.equal(queries[0].year, 2024, 'year preserved from stored edition');
  assert.equal(queries[0].startDate, '2024-09-28', 'startDate preserved from stored edition');
  assert.equal(queries[0].venue, 'Cow Palace', 'venue overridden by draft');
  assert.equal(queries[0].city, 'San Francisco, CA', 'city preserved from stored edition');

  assert.deepEqual(await s.listEvents(), []);
});

test('researchEditionFacts returns off when no finders enabled, and none when name is empty', async () => {
  const disabledFinder: DetailFinder = {
    id: 'discovered',
    enabled: () => false,
    find: async () => [],
  };

  const offResult = await researchEditionFacts(
    { id: 'ed-1', name: 'Some Fest', year: 2024 },
    [disabledFinder],
  );
  assert.equal(offResult.status, 'off');
  assert.deepEqual(offResult.candidates, []);

  const emptyNameResult = await researchEditionFacts(
    { id: 'ed-1', name: '   ', year: 2024 },
    [{ id: 'discovered', enabled: () => true, withoutYear: true, find: async () => [] }],
  );
  assert.equal(emptyNameResult.status, 'none');
});

test('researchEditionFacts classifies candidates as choose when multiple distinct dates are found', async () => {
  const multiFinder: DetailFinder = {
    id: 'discovered',
    enabled: () => true,
    withoutYear: true,
    async find(): Promise<DetailCandidate[]> {
      return [
        {
          id: 'c1',
          name: 'Festival A',
          startDate: '2024-05-01',
          sources: [{ sourceType: 'discovered', sourceUrl: 'https://a.com/1', fields: ['startDate'] }],
        },
        {
          id: 'c2',
          name: 'Festival B',
          startDate: '2024-06-01',
          sources: [{ sourceType: 'discovered', sourceUrl: 'https://b.com/2', fields: ['startDate'] }],
        },
      ];
    },
  };

  const res = await researchEditionFacts(
    { id: 'ed-1', name: 'Festival', year: 2024 },
    [multiFinder],
  );
  assert.equal(res.status, 'choose');
  assert.equal(res.candidates.length, 2);
});

test('canonicalApi.researchEdition formats the request to /api/manage/canonical/editions/:id/details', async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl = '';
  let calledMethod = '';
  let calledBody = '';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calledUrl = String(input);
    calledMethod = init?.method ?? 'GET';
    calledBody = init?.body ? String(init.body) : '';
    return new Response(
      JSON.stringify({
        status: 'matched',
        candidates: [],
        notes: ['Found 1 match'],
        checkedAt: '2026-11-14T00:00:00.000Z',
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof fetch;

  try {
    const draft = { name: 'Draft Fest', startDate: '2025-06-01' };
    const result = await canonicalApi.researchEdition('edition-xyz', draft);
    assert.equal(calledUrl, '/api/manage/canonical/editions/edition-xyz/details');
    assert.equal(calledMethod, 'POST');
    assert.deepEqual(JSON.parse(calledBody), draft);
    assert.equal(result.status, 'matched');
    assert.deepEqual(result.notes, ['Found 1 match']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
