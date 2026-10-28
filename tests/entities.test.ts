import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { LoggedEvent } from '../src/server/events/types.ts';
import { EntityIndex, entityIdFor, linkEvent, placeOf, possibleDuplicates } from '../src/server/entities/link.ts';
import { backfillEntities, BACKFILL_SETTING, withEntityLinks } from '../src/server/entities/linkingStore.ts';
import { Entity } from '../src/server/entities/types.ts';
import { EntityIntegrityError } from '../src/server/entities/integrity.ts';

const AT = '2026-10-28T00:00:00.000Z';

const event = (over: Partial<LoggedEvent> = {}): LoggedEvent => ({
  id: 'e1',
  input: '',
  name: 'Night',
  sources: {},
  details: { status: 'resolved', candidates: [], notes: [] },
  seen: [],
  daysAttended: [],
  companions: [],
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const entity = (kind: Entity['kind'], name: string, over: Partial<Entity> = {}): Entity => ({
  id: entityIdFor(kind, name.toLowerCase()),
  kind,
  name,
  nameNormalized: name.toLowerCase(),
  attrs: {},
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const fileStore = async () => new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'entities-')));

test('entityIdFor is a stable version 5 UUID per kind and name', () => {
  const id = entityIdFor('venue', 'la historic park');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id, entityIdFor('venue', 'la historic park'));
  assert.notEqual(id, entityIdFor('series', 'la historic park'));
});

test('linkEvent points every name at a record without changing the names', () => {
  const index = new EntityIndex([], [], {}, () => AT);
  const linked = linkEvent(
    event({
      venue: 'LA Historic Park',
      city: 'Los Angeles',
      region: 'CA',
      country: 'US',
      series: 'HARD Summer',
      companions: ['Mike', '?'],
      seen: [{ key: 'above and beyond', name: 'Above & Beyond', from: 'you' }],
    }),
    index,
  );
  assert.equal(linked.venue, 'LA Historic Park');
  assert.equal(linked.refs!.venueId, entityIdFor('venue', 'la historic park'));
  assert.equal(linked.refs!.placeId, entityIdFor('place', 'los angeles ca us'));
  assert.equal(linked.refs!.seriesId, entityIdFor('series', 'hard summer'));
  assert.deepEqual(linked.refs!.companionIds, [entityIdFor('person', 'mike'), null]);
  assert.equal(linked.seen[0].artistId, entityIdFor('artist', 'above and beyond'));
  assert.equal(linked.seen[0].name, 'Above & Beyond');
  assert.deepEqual(
    index.created.map((e) => [e.kind, e.name]),
    [['venue', 'LA Historic Park'], ['place', 'Los Angeles'], ['series', 'HARD Summer'], ['person', 'Mike'], ['artist', 'Above & Beyond']],
  );
  assert.deepEqual(index.created.find((e) => e.kind === 'place')!.attrs, { city: 'Los Angeles', region: 'CA', country: 'US' });
});

test('names match after normalization, within one kind only', () => {
  const index = new EntityIndex([], [], {}, () => AT);
  const a = linkEvent(event({ id: 'a', venue: 'The Shrine', series: 'The Shrine' }), index);
  const b = linkEvent(event({ id: 'b', venue: 'the shrine!' }), index);
  assert.equal(a.refs!.venueId, b.refs!.venueId);
  assert.notEqual(a.refs!.venueId, a.refs!.seriesId);
  assert.equal(index.created.length, 2);
});

test('aliases are scoped by kind, and merged records resolve to their target', () => {
  const target = entity('artist', 'deadmau5');
  const old = entity('artist', 'old name', { mergedIntoId: target.id });
  const index = new EntityIndex([target, old], [{ entityId: target.id, kind: 'artist', aliasNormalized: 'joel zimmerman' }], {}, () => AT);
  assert.equal(index.find('artist', 'joel zimmerman')?.id, target.id);
  assert.equal(index.find('person', 'joel zimmerman'), undefined);
  assert.equal(index.find('artist', 'old name'), undefined, 'a merged record is not live under its own name');
  assert.equal(index.resolve('artist', 'Old Name')?.id, target.id, 'its old ID still leads to the target');
});

test('the lineup pipeline\'s learned spellings find the artist record', () => {
  const artist = entity('artist', 'above and beyond', { name: 'Above & Beyond' });
  const index = new EntityIndex([artist], [], { 'above beyond': 'Above & Beyond' }, () => AT);
  assert.equal(index.find('artist', 'above beyond')?.id, artist.id);
});

test('placeOf needs a city; state and country are part of the place', () => {
  assert.equal(placeOf({ country: 'US' }), null);
  assert.equal(placeOf({ city: 'Indio' })!.key, 'indio');
  assert.equal(placeOf({ city: 'Indio', region: 'CA' })!.key, 'indio ca');
});

test('possibleDuplicates groups look-alikes and leaves them unmerged', () => {
  const groups = possibleDuplicates([
    entity('venue', 'the shrine'),
    entity('venue', 'shrine'),
    entity('venue', 'echoplex'),
    entity('artist', 'shrine'),
    entity('place', 'indio ca', { name: 'Indio', attrs: { city: 'Indio', region: 'CA' } }),
    entity('place', 'indio', { name: 'Indio', attrs: { city: 'Indio' } }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.map((e) => `${e.kind}:${e.nameNormalized}`).sort()),
    [['venue:shrine', 'venue:the shrine'], ['place:indio', 'place:indio ca']],
  );
});

test('file store enforces live-name, merge, alias and link rules', async () => {
  const store = await fileStore();
  const venue = entity('venue', 'echoplex');
  const place = entity('place', 'los angeles', { attrs: { city: 'Los Angeles' } });
  await store.addEntities([venue, place]);

  await assert.rejects(store.addEntities([entity('venue', 'echoplex', { id: '00000000-0000-5000-8000-000000000001' })]), EntityIntegrityError);
  await assert.rejects(store.addEntities([entity('venue', 'x', { mergedIntoId: entityIdFor('venue', 'x') })]), /itself/);
  const chained = entity('venue', 'y', { mergedIntoId: entity('venue', 'z', { mergedIntoId: venue.id }).id });
  await assert.rejects(store.addEntities([entity('venue', 'z', { mergedIntoId: venue.id }), chained]), /flattened/);

  await store.addEntityAliases([{ entityId: venue.id, kind: 'venue', aliasNormalized: 'the echoplex' }]);
  await store.addEntityAliases([{ entityId: venue.id, kind: 'venue', aliasNormalized: 'the echoplex' }]);
  assert.equal((await store.listEntityAliases()).length, 1, 'adding the same alias twice keeps one');
  await assert.rejects(store.addEntityAliases([{ entityId: place.id, kind: 'place', aliasNormalized: 'x' }, { entityId: venue.id, kind: 'place', aliasNormalized: 'y' }]), /venue record/);
  const other = entity('venue', 'regent');
  await store.addEntities([other]);
  await assert.rejects(store.addEntityAliases([{ entityId: other.id, kind: 'venue', aliasNormalized: 'the echoplex' }]), /another record/);

  await store.addEntityLinks([{ fromId: venue.id, toId: place.id, role: 'in', createdAt: AT }]);
  await store.addEntityLinks([{ fromId: venue.id, toId: place.id, role: 'in', createdAt: AT }]);
  assert.equal((await store.listEntityLinks()).length, 1);
  await assert.rejects(store.addEntityLinks([{ fromId: venue.id, toId: venue.id, role: 'in', createdAt: AT }]), /itself/);
  await assert.rejects(store.addEntityLinks([{ fromId: place.id, toId: venue.id, role: 'in', createdAt: AT }]), /cannot be "in"/);

  await assert.rejects(
    store.putEvent(event({ refs: { venueId: place.id, placeId: null, seriesId: null, companionIds: [] } })),
    /place record as its venue/,
  );
  await assert.rejects(store.putEvent(event({ seen: [{ key: 'a', name: 'A', from: 'you', artistId: venue.id }] })), /venue record as its artist/);
});

test('the linking store links every save and creates each record once', async () => {
  const store = withEntityLinks(await fileStore());
  await store.putEvent(event({ id: 'a', venue: 'Echoplex', city: 'Los Angeles, CA', companions: ['Mike'] }));
  await store.putEvents([event({ id: 'b', venue: 'echoplex', city: 'Los Angeles', region: 'CA', country: 'United States', companions: ['mike'] })]);
  const [a, b] = [await store.getEvent('a'), await store.getEvent('b')];
  assert.equal(a!.city, 'Los Angeles');
  assert.equal(a!.refs!.venueId, b!.refs!.venueId);
  assert.equal(a!.refs!.placeId, b!.refs!.placeId, '"City, ST" is split (and its country filled) before the place is found');
  assert.deepEqual(a!.refs!.companionIds, b!.refs!.companionIds);
  assert.equal((await store.listEntities()).length, 3);
  assert.equal(a!.updatedAt, AT, 'linking does not touch updatedAt');

  await store.putEvent({ ...a!, venue: undefined });
  assert.equal((await store.getEvent('a'))!.refs!.venueId, null);
});

test('backfill links events saved before 0014 once, and bridges learned artist spellings', async () => {
  const plain = await fileStore();
  await plain.putEvents([
    event({ id: 'a', venue: 'Echoplex', seen: [{ key: 'above and beyond', name: 'Above & Beyond', from: 'you' }] }),
    event({ id: 'b', series: 'EDC' }),
  ]);
  await plain.putAliases({ 'above beyond': 'Above & Beyond', 'nobody here': 'Nobody' });
  const store = withEntityLinks(plain);

  const done = await backfillEntities(store, () => AT);
  assert.deepEqual(done, { events: 2, entities: 3, aliases: 1, at: AT });
  assert.ok((await store.getEvent('a'))!.refs!.venueId);
  assert.deepEqual(await store.listEntityAliases(), [
    { entityId: entityIdFor('artist', 'above and beyond'), kind: 'artist', aliasNormalized: 'above beyond' },
  ]);
  assert.ok(await store.getSetting(BACKFILL_SETTING));
  assert.equal(await backfillEntities(store, () => AT), null, 'runs once');
  assert.equal(await backfillEntities(plain, () => AT), null, 'does nothing without the linking store');
});
