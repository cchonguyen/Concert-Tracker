import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { dispatch } from './helpers/testApp.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { genresRouter } from '../src/server/events/genreRoutes.ts';
import { requestScopedStore, runAsMember } from '../src/server/auth/requestScope.ts';
import type { ArtistGenres } from '../src/server/events/genreTypes.ts';
import type { LoggedEvent, SeenAct } from '../src/server/events/types.ts';

const now = new Date('2026-11-27T00:00:00Z');
const OWNER = { userId: 'u-owner', role: 'owner' as const };
const ANN = { userId: 'u-ann', role: 'member' as const };
const BOB = { userId: 'u-bob', role: 'member' as const };

const row = (key: string, name: string, source: ArtistGenres['source'], style: string): ArtistGenres => ({
  key,
  name,
  source,
  genres: [{ parent: 'electronic', style, weight: 1 }],
  checkedAt: '2026-01-01T00:00:00Z',
});

// An event whose lineup is the listing it was matched to (details.candidates[0].performers).
const ev = (id: string, lineup: string[], seen: SeenAct[] = []): LoggedEvent => ({
  id,
  input: id,
  name: id,
  sources: {},
  details: {
    status: 'resolved',
    candidates: lineup.length
      ? [{ id: `c-${id}`, sources: [], performers: lineup.map((name) => ({ name, sourceType: 'ticketmaster' as const, sourceUrl: 'https://example.test/t' })) }]
      : [],
    notes: [],
  },
  seen,
  daysAttended: [],
  companions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

async function withApp(fn: (app: express.Express, store: FileLineupStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'lineup-genres-route-'));
  try {
    const store = new FileLineupStore(dir);
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', genresRouter({ store: requestScopedStore(store), fetcher: {} as any, now: () => now } as any));
    await fn(app, store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const asRole = <T>(
  member: { userId: string; role: 'owner' | 'member' },
  store: FileLineupStore,
  fn: () => Promise<T>,
) =>
  new Promise<T>((resolve, reject) =>
    runAsMember({ role: member.role, userId: member.userId, email: `${member.userId}@example.test` } as any, store.forUser(member) as any, () =>
      fn().then(resolve, reject),
    ),
  );

const get = (app: express.Express, id: string) => dispatch(app, { url: `/api/events/${encodeURIComponent(id)}/lineup-genres` });

test('owner gets the shared genre rows of a lineup act that is not in seen', async () => {
  await withApp(async (app, store) => {
    await store.writeArtistGenres([{ key: 'moon garden', source: 'owner', row: row('moon garden', 'Moon Garden', 'owner', 'house') }], {
      actor: 'owner',
      reason: 'Set in the app',
    });
    await asRole(OWNER, store, () => store.forUser(OWNER).putEvent(ev('own-1', ['Moon Garden'])));
    const res = await asRole(OWNER, store, () => get(app, 'own-1'));
    assert.equal(res.status, 200);
    const body = res.json<{ acts: Array<{ key: string; name: string }>; genres: ArtistGenres[] }>();
    assert.deepEqual(body.acts.map((a) => [a.key, a.name]), [['moon garden', 'Moon Garden']]);
    assert.deepEqual(body.genres.map((g) => `${g.key}:${g.source}`), ['moon garden:owner']);
  });
});

test('a member gets the shared rows of unseen lineup acts of their own event', async () => {
  await withApp(async (app, store) => {
    await store.writeArtistGenres([{ key: 'moon garden', source: 'owner', row: row('moon garden', 'Moon Garden', 'owner', 'house') }], {
      actor: 'owner',
      reason: 'Set in the app',
    });
    await asRole(ANN, store, () => store.forUser(ANN).putEvent(ev('ann-1', ['Moon Garden'])));
    const res = await asRole(ANN, store, () => get(app, 'ann-1'));
    assert.equal(res.status, 200);
    const body = res.json<{ acts: Array<{ key: string }>; genres: ArtistGenres[] }>();
    assert.deepEqual(body.acts.map((a) => a.key), ['moon garden']);
    assert.deepEqual(body.genres.map((g) => `${g.key}:${g.source}`), ['moon garden:owner']);
  });
});

test('a member gets no rows for an act that is not on that event lineup', async () => {
  await withApp(async (app, store) => {
    await store.writeArtistGenres(
      [
        { key: 'moon garden', source: 'owner', row: row('moon garden', 'Moon Garden', 'owner', 'house') },
        { key: 'other act', source: 'owner', row: row('other act', 'Other Act', 'owner', 'techno') },
      ],
      { actor: 'owner', reason: 'Set in the app' },
    );
    await asRole(ANN, store, () => store.forUser(ANN).putEvent(ev('ann-1', ['Moon Garden'])));
    const body = (await asRole(ANN, store, () => get(app, 'ann-1'))).json<{ genres: ArtistGenres[] }>();
    assert.deepEqual(body.genres.map((g) => g.key), ['moon garden']);
  });
});

test("another member's added rows never appear, only the caller's own", async () => {
  await withApp(async (app, store) => {
    await store.writeArtistGenres([{ key: 'moon garden', source: 'owner', row: row('moon garden', 'Moon Garden', 'owner', 'house') }], {
      actor: 'owner',
      reason: 'Set in the app',
    });
    await asRole(ANN, store, () => store.forUser(ANN).putArtistGenres([row('moon garden', 'Moon Garden', 'added', 'techno')]));
    await asRole(BOB, store, () => store.forUser(BOB).putArtistGenres([row('moon garden', 'Moon Garden', 'added', 'dubstep')]));
    await asRole(ANN, store, () => store.forUser(ANN).putEvent(ev('ann-1', ['Moon Garden'])));
    await asRole(BOB, store, () => store.forUser(BOB).putEvent(ev('bob-1', ['Moon Garden'])));

    const ann = (await asRole(ANN, store, () => get(app, 'ann-1'))).json<{ genres: ArtistGenres[] }>();
    assert.deepEqual(ann.genres.map((g) => `${g.source}:${g.genres[0].style}`).sort(), ['added:techno', 'owner:house']);

    const bob = (await asRole(BOB, store, () => get(app, 'bob-1'))).json<{ genres: ArtistGenres[] }>();
    assert.deepEqual(bob.genres.map((g) => `${g.source}:${g.genres[0].style}`).sort(), ['added:dubstep', 'owner:house']);
  });
});

test('an unknown event id gives 404 with the event-not-found message', async () => {
  await withApp(async (app, store) => {
    const res = await asRole(OWNER, store, () => get(app, 'missing'));
    assert.equal(res.status, 404);
    assert.deepEqual(res.json(), { error: 'Event not found.' });
  });
});

test("another member's event gives 404 to a member", async () => {
  await withApp(async (app, store) => {
    await asRole(ANN, store, () => store.forUser(ANN).putEvent(ev('ann-1', ['Moon Garden'])));
    const res = await asRole(BOB, store, () => get(app, 'ann-1'));
    assert.equal(res.status, 404);
    assert.deepEqual(res.json(), { error: 'Event not found.' });
  });
});

test('an event with no lineup gives empty lists', async () => {
  await withApp(async (app, store) => {
    await store.writeArtistGenres([{ key: 'moon garden', source: 'owner', row: row('moon garden', 'Moon Garden', 'owner', 'house') }], {
      actor: 'owner',
      reason: 'Set in the app',
    });
    await asRole(ANN, store, () => store.forUser(ANN).putEvent(ev('ann-empty', [])));
    const res = await asRole(ANN, store, () => get(app, 'ann-empty'));
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { acts: [], genres: [] });
  });
});
