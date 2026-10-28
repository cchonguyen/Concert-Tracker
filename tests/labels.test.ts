import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { LoggedEvent } from '../src/server/events/types.ts';
import { withEntityLinks } from '../src/server/entities/linkingStore.ts';
import { entityIdFor } from '../src/server/entities/link.ts';
import { addLink, createEntity, ManageError, undoEntry, updateAttrs } from '../src/server/entities/manage.ts';
import { categoryGaps, linkedSuggestions, rareLabels, venuesWithoutPlace, placeOfferVenues } from '../src/services/dataHealth.ts';
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

async function setup(events: LoggedEvent[]): Promise<LineupStore> {
  const store = withEntityLinks(new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'labels-'))));
  await store.putEvents(events);
  return store;
}

const venue = (n: string) => entityIdFor('venue', n);
const series = (n: string) => entityIdFor('series', n);

async function health(store: LineupStore) {
  return { entities: await store.listEntities(), links: await store.listEntityLinks(), events: await store.listEvents() };
}

test('a label is added with its group, and a record has one label per group', async () => {
  const store = await setup([event('a', { venue: 'Shrine' })]);
  const indoor = (await createEntity(store, 'label', 'Indoor', AT, 'Indoor/Outdoor')).entity;
  const outdoor = (await createEntity(store, 'label', 'Outdoor', AT, ' Indoor/Outdoor ')).entity;
  const vip = (await createEntity(store, 'label', 'Has VIP', AT)).entity;
  assert.equal(indoor.attrs.group, 'Indoor/Outdoor');
  assert.deepEqual(vip.attrs, {});
  await addLink(store, venue('shrine'), indoor.id, 'has_label', AT);
  await addLink(store, venue('shrine'), vip.id, 'has_label', AT);
  const swap = await addLink(store, venue('shrine'), outdoor.id, 'has_label', AT);
  assert.match(swap.summary, /labelled "Outdoor"/);
  const labels = (await store.listEntityLinks()).filter((l) => l.role === 'has_label').map((l) => l.toId).sort();
  assert.deepEqual(labels, [outdoor.id, vip.id].sort());
  await undoEntry(store, swap.id);
  assert.ok((await store.listEntityLinks()).some((l) => l.toId === indoor.id));
  await assert.rejects(createEntity(store, 'label', 'indoor'), (err: ManageError) => err.status === 409);
  await assert.rejects(createEntity(store, 'artist', 'Someone'), ManageError);
  await assert.rejects(addLink(store, indoor.id, venue('shrine'), 'has_label'), ManageError);
});

test('details follow the kind\'s schema, keep other attrs, and can be undone', async () => {
  const store = await setup([event('a', { venue: 'Shrine' })]);
  const id = venue('shrine');
  const entry = await updateAttrs(store, id, { address: ' 665 W Jefferson  Blvd ', type: 'Auditorium', note: 'Line\nbreaks kept' }, AT);
  assert.equal(entry.operation, 'details');
  const shrine = (await store.listEntities()).find((e) => e.id === id)!;
  assert.equal(shrine.attrs.address, '665 W Jefferson Blvd');
  assert.equal(shrine.attrs.note, 'Line\nbreaks kept');
  await updateAttrs(store, id, { type: '' }, AT);
  assert.equal((await store.listEntities()).find((e) => e.id === id)!.attrs.type, undefined);
  await assert.rejects(updateAttrs(store, id, { city: 'LA' }), ManageError);
  await assert.rejects(updateAttrs(store, id, { capacity: 'x'.repeat(41) }), ManageError);
  await assert.rejects(updateAttrs(store, id, { address: '665 W Jefferson Blvd' }), /Nothing changed/);
  await assert.rejects(updateAttrs(store, entityIdFor('person', 'nobody'), { note: 'x' }), ManageError);
});

test('Data health: gaps per group, linked offers and rare labels', async () => {
  const store = await setup([
    event('a', { venue: 'Field', series: 'Desert Fest' }),
    event('b', { venue: 'Shrine', series: 'Desert Fest' }),
    event('c', { venue: 'Club' }),
    event('d', { venue: 'Barn' }),
  ]);
  const outdoor = (await createEntity(store, 'label', 'Outdoor', AT, 'Indoor/Outdoor')).entity;
  const indoor = (await createEntity(store, 'label', 'Indoor', AT, 'Indoor/Outdoor')).entity;
  const typo = (await createEntity(store, 'label', 'Outdor', AT)).entity;
  await addLink(store, series('desert fest'), outdoor.id, 'has_label', AT);
  await addLink(store, venue('shrine'), indoor.id, 'has_label', AT);
  await addLink(store, venue('club'), indoor.id, 'has_label', AT);
  const h = await health(store);

  const gaps = categoryGaps(h);
  const venueGap = gaps.find((g) => g.kind === 'venue')!;
  assert.equal(venueGap.group, 'Indoor/Outdoor');
  assert.deepEqual(venueGap.missing.map((v) => v.name), ['Barn', 'Field']);
  assert.equal(gaps.find((g) => g.kind === 'series'), undefined); // the one series has it

  const offers = linkedSuggestions(h);
  // Field has no indoor/outdoor: offered the series' Outdoor. Shrine is
  // Indoor already, and the series has the group, so nothing either way.
  assert.deepEqual(offers, [{ recordId: venue('field'), labelId: outdoor.id, becauseId: series('desert fest') }]);

  assert.deepEqual(rareLabels(h).map((r) => [r.label.name, r.uses]), [['Outdor', 0], ['Outdoor', 1]]);
  assert.ok(typo);
});

test('Data health: venues without a place and venues with offered cities', async () => {
  const store = await setup([
    event('a', { venue: 'Shrine', city: 'Los Angeles', region: 'CA', country: 'United States' }),
    event('b', { venue: 'Shrine', city: 'Pasadena', region: 'CA', country: 'United States' }),
    event('c', { venue: 'Barn' }),
  ]);
  const h = await health(store);
  assert.deepEqual(venuesWithoutPlace(h).map((v) => v.name), ['Barn']);
  const offered = placeOfferVenues(h.entities);
  assert.equal(offered.length, 1);
  assert.equal(offered[0].offers[0].city, 'Pasadena');
});
