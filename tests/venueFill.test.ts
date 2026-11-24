import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { entitiesRouter } from '../src/server/entities/routes.ts';
import { runAsMember } from '../src/server/auth/requestScope.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import type { Edition } from '../src/server/lineup/types.ts';
import { writeEdition, undoEditionChange } from '../src/server/canon/editions.ts';
import { applyVenueFill, planVenueFill, VENUE_FILL_ACTOR } from '../src/server/canon/venueFill.ts';
import { BudgetExhausted, countingFetch, makeBudget, runWithBudget } from '../src/server/lineup/budget.ts';

const fresh = async () => new FileLineupStore(await mkdtemp(join(tmpdir(), 'venuefill-')));
const ed = (id: string, extra: Partial<Edition>): Edition => ({
  id,
  key: `show-${id}/2025`,
  year: 2025,
  name: `Show ${id}`,
  startDate: '2025-05-01',
  status: 'provisional',
  performances: [],
  updatedAt: '2025-01-01T00:00:00.000Z',
  ...extra,
});
const put = (s: FileLineupStore, e: Edition) => writeEdition(s, { edition: e, actor: 'test', reason: 'setup' });

async function seeded() {
  const s = await fresh();
  await s.upsertVenue({ name: 'Red Rocks Amphitheatre', city: 'Morrison', region: 'CO', country: 'United States' });
  await s.upsertVenue({ name: 'Red Rocks Amphitheatre' });
  await s.upsertVenue({ name: 'The Fillmore', city: 'San Francisco', country: 'United States' });
  await s.upsertVenue({ name: 'The Fillmore', city: 'Denver', country: 'United States' });
  await put(s, ed('a', { venue: 'Red Rocks Amphitheatre' })); // all empty: filled from the venue
  await put(s, ed('b', { venue: 'Somewhere', city: 'Austin, TX' })); // state split from the city
  await put(s, ed('c', { venue: 'Red Rocks Amphitheatre', city: 'Denver' })); // another city: nothing filled
  await put(s, ed('d', { venue: 'The Fillmore' })); // two places: a choice
  await put(s, ed('e', { venue: 'Red Rocks Amphitheatre', city: 'Morrison', region: 'CO', country: 'United States' })); // full
  return s;
}

test('the preview fills only empty fields, splits "City, ST", and lists venues with several places as choices', async () => {
  const s = await seeded();
  const plan = await planVenueFill(s, { budgetLeft: () => 1000 });
  const by = new Map(plan.fills.map((f) => [f.editionId, f]));
  assert.deepEqual(by.get('a')?.after, { city: 'Morrison', region: 'CO', country: 'United States' });
  assert.deepEqual(by.get('a')?.from, ['venue']);
  assert.deepEqual(by.get('b')?.after, { city: 'Austin', region: 'TX', country: 'United States' });
  assert.deepEqual(by.get('b')?.from, ['city']);
  assert.equal(by.has('c'), false);
  assert.equal(by.has('e'), false);
  assert.deepEqual(plan.choices.map((c) => c.editionId), ['d']);
  assert.equal(plan.choices[0].choices.length, 2);
});

test('apply writes one logged, undoable change per edition and ignores a pick the venue records do not hold', async () => {
  const s = await seeded();
  const r = await applyVenueFill(s, {
    editionIds: ['a', 'b', 'c', 'e'],
    picks: [{ editionId: 'd', location: { city: 'Denver' } }],
    budgetLeft: () => 1000,
  });
  assert.equal(r.filled.length, 3);
  assert.equal(r.skipped, 2);
  assert.equal((await s.getEdition('a'))?.region, 'CO');
  assert.equal((await s.getEdition('c'))?.city, 'Denver');
  assert.equal((await s.getEdition('c'))?.country, undefined);
  assert.equal((await s.getEdition('d'))?.city, 'Denver');
  const bad = await applyVenueFill(s, { picks: [{ editionId: 'a', location: { city: 'Nowhere' } }], budgetLeft: () => 1000 });
  assert.equal(bad.filled.length, 0);
  const changes = await s.listEditionChanges('a');
  const fill = changes.find((c) => c.actor === VENUE_FILL_ACTOR);
  assert.ok(fill, 'the fill is recorded');
  const undo = await undoEditionChange(s, 'a', fill!.id, 'owner');
  assert.equal(undo.ok, true);
  assert.equal((await s.getEdition('a'))?.city, undefined);
});

test('a run out of budget leaves the rest for the next press', async () => {
  const s = await seeded();
  const r = await applyVenueFill(s, { editionIds: ['a', 'b'], budgetLeft: () => 0 });
  assert.deepEqual(r, { filled: [], skipped: 0, left: 2 });
});

test('the routes are owner only', async () => {
  const s = await seeded();
  const app = (role: 'owner' | 'member') => {
    const a = express();
    a.use(express.json());
    a.use((_req, _res, next) => runAsMember({ role, uid: 'u1' } as any, s as any, next));
    a.use('/api', entitiesRouter({ store: s } as any));
    return a;
  };
  assert.equal((await dispatch(app('member'), { method: 'GET', url: '/api/manage/canonical/venue-fill' })).status, 403);
  const owner = await dispatch(app('owner'), { method: 'GET', url: '/api/manage/canonical/venue-fill' });
  assert.equal(owner.status, 200);
  assert.ok(owner.json().fills.length >= 2);
});

// A store whose calls each cost subrequests through countingFetch, as the Supabase store's do.
function costed(s: FileLineupStore, cost: Record<string, number>) {
  return new Proxy(s, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== 'function' || !(String(prop) in cost)) return v;
      return async (...args: unknown[]) => {
        for (let i = 0; i < cost[String(prop)]; i++) await countingFetch('http://x.invalid/');
        return v.apply(target, args);
      };
    },
  });
}

test('a spent budget never leaves a saved edition without its change record', async () => {
  const s = await seeded();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}')) as typeof fetch;
  try {
    const budget = makeBudget();
    const store = costed(s, { upsertEdition: 5, recordEditionChange: 1 });
    // Only the edition save fits under the ordinary ceiling; the change record needs the reserve.
    budget.used = budget.limit - budget.reserve - 5;
    const edition = (await s.getEdition('a'))!;
    const w = await runWithBudget(budget, () =>
      writeEdition(store as any, { edition: { ...edition, city: 'Morrison' }, before: edition, actor: VENUE_FILL_ACTOR, reason: 'test' }),
    );
    assert.equal(w.changed, true);
    assert.ok(w.change);
    assert.equal(budget.used, budget.limit - budget.reserve + 1);
    // Outside the change record, the reserve stays closed.
    await assert.rejects(runWithBudget(budget, async () => countingFetch('http://x.invalid/')), BudgetExhausted);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('bulk fill counts the real cost of each write and stops before the budget runs out', async () => {
  const s = await seeded();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}')) as typeof fetch;
  try {
    const budget = makeBudget();
    // The Supabase store's worst case: edition + acts, alias + venues, a save that rewrites the acts, the record.
    const store = costed(s, { getEdition: 2, listVenuesByAlias: 2, upsertEdition: 5, recordEditionChange: 1 });
    budget.used = 10; // the request's own calls before the fill (sign-in, settings)
    const r = await runWithBudget(budget, () => applyVenueFill(store as any, { editionIds: ['a', 'b', 'c', 'd', 'e'] }));
    assert.equal(r.filled.length, 2);
    assert.ok(budget.used <= budget.limit - budget.reserve, `used ${budget.used}`);
    const changes = await s.listEditionChanges('a');
    assert.ok(changes.some((c) => c.actor === VENUE_FILL_ACTOR));
  } finally {
    globalThis.fetch = realFetch;
  }
});
