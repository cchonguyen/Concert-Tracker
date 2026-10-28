import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { LoggedEvent } from '../src/server/events/types.ts';
import {
  BACKFILL_SETTING,
  backfillEntities,
  backfillVenuePlaces,
  VENUE_PLACES_SETTING,
  withEntityLinks,
} from '../src/server/entities/linkingStore.ts';
import { entityIdFor } from '../src/server/entities/link.ts';
import { addLink, linkVenuePlaces, mergeEntity, renameEntity, undoEntry, venuePlaceConflicts } from '../src/server/entities/manage.ts';
import { LineupStore } from '../src/server/lineup/store/types.ts';

const AT = '2026-10-28T00:00:00.000Z';

const event = (id: string, over: Partial<LoggedEvent> = {}): LoggedEvent => ({
  id,
  input: '',
  name: `Night ${id}`,
  sources: {},
  details: { status: 'resolved', candidates: [], notes: [] },
  seen: [],
  daysAttended: [],
  companions: [],
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const LA = { city: 'Los Angeles', region: 'CA', country: 'United States' };
const PASADENA = { city: 'Pasadena', region: 'CA', country: 'United States' };
const venueId = (name: string) => entityIdFor('venue', name);
const placeId = (p: { city: string; region: string; country: string }) =>
  entityIdFor('place', `${p.city} ${p.region} ${p.country}`.toLowerCase());

const linking = async (): Promise<LineupStore> => withEntityLinks(new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'venue-'))));
const get = async (store: LineupStore, id: string) => (await store.getEvent(id))!;
const weather = { place: 'Los Angeles', latitude: 34, longitude: -118, days: [], sourceUrl: 'https://open-meteo.com', checkedAt: AT };

test('a new venue saved with a city is put in it, and later events there take that city', async () => {
  const store = await linking();
  await store.putEvent(event('a', { venue: 'Shrine', ...LA }));
  assert.deepEqual(
    (await store.listEntityLinks()).map((l) => [l.fromId, l.toId, l.role]),
    [[venueId('shrine'), placeId(LA), 'in']],
  );
  // No city typed: the venue fills it, marked as from the venue.
  await store.putEvent(event('b', { venue: 'shrine' }));
  const b = await get(store, 'b');
  assert.equal(b.city, 'Los Angeles');
  assert.equal(b.region, 'CA');
  assert.equal(b.country, 'United States');
  assert.equal(b.sources.city?.sourceType, 'venue');
  assert.equal(b.refs?.placeId, placeId(LA));
});

test('another city brought by a save is replaced and kept on the venue as an offer', async () => {
  const store = await linking();
  await store.putEvent(event('a', { venue: 'Shrine', ...LA }));
  await store.putEvent(event('b', { venue: 'Shrine', ...PASADENA, sources: { city: { sourceType: 'ticketmaster', sourceUrl: 'https://tm' } } }));
  const b = await get(store, 'b');
  assert.equal(b.city, 'Los Angeles');
  assert.equal(b.sources.city?.sourceType, 'venue');
  const venue = (await store.listEntities()).find((e) => e.id === venueId('shrine'))!;
  const offers = venue.attrs.placeOffers as Array<Record<string, unknown>>;
  assert.equal(offers.length, 1);
  assert.equal(offers[0].city, 'Pasadena');
  assert.equal(offers[0].from, 'ticketmaster');
  assert.equal(offers[0].eventId, 'b');
});

test('weather looked up for the old city is kept and flagged', async () => {
  const store = await linking();
  await store.putEvent(event('a', { venue: 'Shrine', ...LA }));
  await store.putEvent(event('b', { venue: 'Shrine', ...PASADENA, weather }));
  const b = await get(store, 'b');
  assert.equal(b.weather?.cityChanged, true);
  assert.equal(b.weather?.place, 'Los Angeles');
});

test('putting a venue in a place in Manage fills its events, and undo puts them back', async () => {
  const store = await linking();
  await store.putEvents([event('a', { venue: 'Hollywood Bowl' }), event('b', { ...LA })]);
  const bowl = venueId('hollywood bowl');
  const entry = await addLink(store, bowl, placeId(LA), 'in');
  assert.equal(entry.events.length, 1);
  assert.match(entry.summary, /\(1 event\)/);
  const a = await get(store, 'a');
  assert.equal(a.city, 'Los Angeles');
  assert.equal(a.sources.city?.sourceType, 'venue');
  await undoEntry(store, entry.id);
  const undone = await get(store, 'a');
  assert.equal(undone.city, undefined);
  assert.equal(undone.sources.city, undefined);
  assert.equal((await store.listEntityLinks()).length, 0);
});

test('renaming the place keeps events marked as from the venue', async () => {
  const store = await linking();
  await store.putEvents([event('a', { venue: 'Shrine', ...LA }), event('b', { venue: 'Shrine' })]);
  await renameEntity(store, placeId(LA), 'Los Angeles City');
  const b = await get(store, 'b');
  assert.equal(b.city, 'Los Angeles City');
  assert.equal(b.sources.city?.sourceType, 'venue');
});

test('merging a venue moves its events to the target venue\'s city', async () => {
  const store = await linking();
  await store.putEvents([event('a', { venue: 'Shrine Auditorium', ...LA }), event('b', { venue: 'The Shrine', ...PASADENA })]);
  await mergeEntity(store, venueId('the shrine'), venueId('shrine auditorium'));
  const b = await get(store, 'b');
  assert.equal(b.venue, 'Shrine Auditorium');
  assert.equal(b.city, 'Los Angeles');
});

test('first backfill does not put a venue in a city; the venue pass links only venues whose events agree', async () => {
  const plain = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'venue-')));
  // Saved before 0014: no records yet.
  await plain.putEvents([
    event('a', { venue: 'Shrine', ...LA }),
    event('b', { venue: 'Shrine', ...LA }),
    event('c', { venue: 'Shrine' }),
    event('d', { venue: 'Warehouse', ...LA }),
    event('e', { venue: 'Warehouse', ...PASADENA }),
  ]);
  const store = withEntityLinks(plain);
  assert.equal(await backfillVenuePlaces(store), null); // waits for the first backfill
  await backfillEntities(store, () => AT);
  assert.ok(await store.getSetting(BACKFILL_SETTING));
  assert.equal((await store.listEntityLinks()).length, 0);

  const result = (await backfillVenuePlaces(store, () => AT))!;
  assert.equal(result.venues, 1);
  assert.equal(result.events, 3); // a and b marked as from the venue, c filled
  assert.ok(await store.getSetting(VENUE_PLACES_SETTING));
  assert.equal((await get(store, 'c')).city, 'Los Angeles');
  // The warehouse's events disagree: left for you, cities as typed.
  assert.equal((await get(store, 'e')).city, 'Pasadena');
  const conflicts = await venuePlaceConflicts(store);
  assert.deepEqual(conflicts.map((c) => c.venueId), [venueId('warehouse')]);
  assert.deepEqual(conflicts[0].places.map((p) => p.events), [1, 1]);
  // Once only, and the pass is one undoable change.
  assert.equal(await backfillVenuePlaces(store), null);
  assert.equal(await linkVenuePlaces(store), null);
  await undoEntry(store, result.historyId!);
  assert.equal((await get(store, 'c')).city, undefined);
});
