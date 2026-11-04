import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { LoggedEvent } from '../src/server/events/types.ts';
import { withEntityLinks } from '../src/server/entities/linkingStore.ts';
import { entityIdFor } from '../src/server/entities/link.ts';
import {
  addAlias,
  addLink,
  applyEntityChangePlan,
  createEntity,
  ManageError,
  mergeEntity,
  planEntityMerge,
  planEntityRename,
  removeAlias,
  removeLink,
  renameEntity,
  undoEntry,
} from '../src/server/entities/manage.ts';
import { LineupStore } from '../src/server/lineup/store/types.ts';

const AT = '2026-10-28T00:00:00.000Z';
const LATER = '2026-10-29T00:00:00.000Z';

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

const act = (name: string, over: Record<string, unknown> = {}) => ({
  key: name.toLowerCase(),
  name,
  from: 'you' as const,
  ...over,
});

async function setup(events: LoggedEvent[]): Promise<LineupStore> {
  const store = withEntityLinks(new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'manage-'))));
  await store.putEvents(events);
  return store;
}

const id = (kind: Parameters<typeof entityIdFor>[0], name: string) => entityIdFor(kind, name);
const get = async (store: LineupStore, eventId: string) => (await store.getEvent(eventId))!;

const rejects = async (fn: () => Promise<unknown>, status: number, conflict?: string) => {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof ManageError, String(err));
    assert.equal(err.status, status);
    if (conflict) assert.equal(err.conflict?.id, conflict);
    return true;
  });
};

test('rename rewrites the name on every event and keeps the old one as an AKA', async () => {
  const store = await setup([
    event('a', { venue: 'LA Historic Park' }),
    event('b', { venue: 'la historic park' }),
    event('c', { venue: 'Shrine' }),
  ]);
  const venue = id('venue', 'la historic park');
  const entry = await renameEntity(store, venue, 'Los Angeles Historic Park', LATER);

  assert.equal(entry.operation, 'rename');
  assert.equal(entry.events.length, 2);
  assert.equal((await get(store, 'a')).venue, 'Los Angeles Historic Park');
  assert.equal((await get(store, 'b')).venue, 'Los Angeles Historic Park');
  assert.equal((await get(store, 'b')).sources.venue?.sourceType, 'user');
  assert.equal((await get(store, 'b')).updatedAt, LATER);
  assert.equal((await get(store, 'c')).venue, 'Shrine');
  // Same record, new name, still linked.
  const record = (await store.listEntities()).find((e) => e.id === venue)!;
  assert.equal(record.name, 'Los Angeles Historic Park');
  assert.equal((await get(store, 'a')).refs?.venueId, venue);
  assert.deepEqual(
    (await store.listEntityAliases()).filter((a) => a.entityId === venue).map((a) => a.aliasNormalized),
    ['la historic park'],
  );
  // A new event typed with the old name finds the same record.
  await store.putEvent(event('d', { venue: 'LA Historic Park' }));
  assert.equal((await get(store, 'd')).refs?.venueId, venue);
});

test('entity rename planning is read-only and apply consumes that exact plan', async () => {
  const store = await setup([event('a', { venue: 'Old Hall' })]);
  const venue = id('venue', 'old hall');
  const beforeEvents = await store.listEvents();
  const beforeEntities = await store.listEntities();
  const planned = await planEntityRename(store, venue, 'New Hall', LATER);
  assert.deepEqual(await store.listEvents(), beforeEvents);
  assert.deepEqual(await store.listEntities(), beforeEntities);
  assert.equal(planned.plan.events.length, 1);
  const applied = await applyEntityChangePlan(store, planned);
  assert.equal(applied.operation, 'rename');
  assert.equal((await get(store, 'a')).venue, 'New Hall');
});

test('entity merge planning is read-only and apply consumes that exact plan', async () => {
  const store = await setup([
    event('source-event', { venue: 'Old Hall' }),
    event('target-event', { venue: 'New Hall' }),
  ]);
  const source = id('venue', 'old hall');
  const target = id('venue', 'new hall');
  const beforeEvents = await store.listEvents();
  const beforeEntities = await store.listEntities();
  const beforeAliases = await store.listEntityAliases();
  const beforeLinks = await store.listEntityLinks();
  const beforeHistory = await store.listEntityHistory(100);

  const planned = await planEntityMerge(store, source, target, LATER);

  assert.deepEqual(await store.listEvents(), beforeEvents);
  assert.deepEqual(await store.listEntities(), beforeEntities);
  assert.deepEqual(await store.listEntityAliases(), beforeAliases);
  assert.deepEqual(await store.listEntityLinks(), beforeLinks);
  assert.deepEqual(await store.listEntityHistory(100), beforeHistory);
  assert.equal(planned.plan.operation, 'merge');
  assert.equal(planned.plan.events.length, 1);
  assert.equal(planned.plan.events[0].id, 'source-event');

  const applied = await applyEntityChangePlan(store, planned);

  assert.equal(applied.operation, 'merge');
  assert.equal(applied.createdAt, LATER);
  assert.equal(applied.events.length, 1);
  assert.equal(applied.events[0].id, 'source-event');
  assert.equal((await get(store, 'source-event')).venue, 'New Hall');
  assert.equal((await get(store, 'source-event')).refs?.venueId, target);
  assert.equal((await store.listEntities()).find((entity) => entity.id === source)?.mergedIntoId, target);
  assert.equal((await store.listEntityHistory(100)).length, beforeHistory.length + 1);
});

test('rename to a name another record has is refused with that record to merge into', async () => {
  const store = await setup([event('a', { venue: 'Shrine' }), event('b', { venue: 'Shrine Expo Hall' })]);
  await rejects(() => renameEntity(store, id('venue', 'shrine expo hall'), 'shrine'), 409, id('venue', 'shrine'));
  await addAlias(store, id('venue', 'shrine'), 'The Shrine');
  await rejects(() => renameEntity(store, id('venue', 'shrine expo hall'), 'The Shrine'), 409, id('venue', 'shrine'));
  await rejects(() => renameEntity(store, id('venue', 'shrine'), '  !! '), 400);
});

test('rename an artist moves its key and its B2B partners follow', async () => {
  const store = await setup([
    event('a', {
      seen: [act('Deadmau5', { b2b: ['kaskade'], set: 'dj' }), act('Kaskade', { b2b: ['deadmau5'], set: 'dj' })],
    }),
  ]);
  await renameEntity(store, id('artist', 'deadmau5'), 'deadmau5 (live)');
  const seen = (await get(store, 'a')).seen;
  assert.equal(seen[0].name, 'deadmau5 (live)');
  assert.equal(seen[0].key, 'deadmau5 live');
  assert.equal(seen[0].artistId, id('artist', 'deadmau5'));
  assert.deepEqual(seen[1].b2b, ['deadmau5 live']);
  assert.deepEqual(seen[0].b2b, ['kaskade']);
});

test('merge folds one record into another, its events, AKAs and links', async () => {
  const store = await setup([
    event('a', { venue: 'Shrine Expo Hall', city: 'Los Angeles', country: 'United States' }),
    event('b', { venue: 'Shrine Expo', city: 'Los Angeles', country: 'United States' }),
  ]);
  const into = id('venue', 'shrine expo hall');
  const source = id('venue', 'shrine expo');
  const place = id('place', 'los angeles united states');
  await addAlias(store, source, 'Shrine Auditorium Expo');
  // Both venues were put in Los Angeles when first saved with it.
  assert.equal((await store.listEntityLinks()).length, 2);
  const entry = await mergeEntity(store, source, into);

  assert.equal(entry.operation, 'merge');
  const entities = await store.listEntities();
  assert.equal(entities.find((e) => e.id === source)!.mergedIntoId, into);
  assert.equal((await get(store, 'b')).venue, 'Shrine Expo Hall');
  assert.equal((await get(store, 'b')).refs?.venueId, into);
  const aliases = (await store.listEntityAliases()).filter((a) => a.entityId === into).map((a) => a.aliasNormalized).sort();
  assert.deepEqual(aliases, ['shrine auditorium expo', 'shrine expo']);
  assert.deepEqual(
    (await store.listEntityLinks()).map((l) => [l.fromId, l.toId, l.role]),
    [[into, place, 'in']],
  );
  // Typed again, the old name lands on the target.
  await store.putEvent(event('c', { venue: 'Shrine Expo' }));
  assert.equal((await get(store, 'c')).refs?.venueId, into);
  // A merged record can't be changed or merged into.
  await rejects(() => renameEntity(store, source, 'x'), 409);
  await rejects(() => mergeEntity(store, into, source), 409);
});

test('merge flattens: records merged into the source move to the target', async () => {
  const store = await setup([event('a', { series: 'EDC' }), event('b', { series: 'EDC LV' }), event('c', { series: 'EDC Las Vegas' })]);
  await mergeEntity(store, id('series', 'edc'), id('series', 'edc lv'));
  await mergeEntity(store, id('series', 'edc lv'), id('series', 'edc las vegas'));
  const entities = await store.listEntities();
  assert.equal(entities.find((e) => e.id === id('series', 'edc'))!.mergedIntoId, id('series', 'edc las vegas'));
  assert.equal(entities.find((e) => e.id === id('series', 'edc lv'))!.mergedIntoId, id('series', 'edc las vegas'));
  for (const e of ['a', 'b', 'c']) assert.equal((await get(store, e)).series, 'EDC Las Vegas');
  await rejects(() => mergeEntity(store, id('series', 'edc las vegas'), id('venue', 'x')), 404);
});

test('merging artists on one event keeps one act with both sets of marks', async () => {
  const store = await setup([
    event('a', {
      seen: [
        act('Joel Zimmerman', { favourite: true, b2b: ['kaskade'], set: 'live' }),
        act('Kaskade', { b2b: ['joel zimmerman'], set: 'live' }),
        act('deadmau5', { from: 'lineup', role: 'headliner', roleFrom: 'lineup' }),
      ],
    }),
  ]);
  await mergeEntity(store, id('artist', 'joel zimmerman'), id('artist', 'deadmau5'));
  const seen = (await get(store, 'a')).seen;
  assert.equal(seen.length, 2);
  const [merged, kaskade] = seen;
  assert.equal(merged.name, 'deadmau5');
  assert.equal(merged.key, 'deadmau5');
  assert.equal(merged.from, 'you');
  assert.equal(merged.favourite, true);
  assert.equal(merged.role, 'headliner');
  assert.equal(merged.set, 'live');
  assert.deepEqual(merged.b2b, ['kaskade']);
  assert.deepEqual(kaskade.b2b, ['deadmau5']);
});

test('merging people drops the second mention of the same person', async () => {
  const store = await setup([event('a', { companions: ['Mike', 'Sam', 'Michael'] })]);
  await mergeEntity(store, id('person', 'michael'), id('person', 'mike'));
  assert.deepEqual((await get(store, 'a')).companions, ['Mike', 'Sam']);
});

test('merging places rewrites city, state and country', async () => {
  const store = await setup([
    event('a', { city: 'LA', region: 'California', country: 'United States' }),
    event('b', { city: 'Los Angeles', region: 'California', country: 'United States' }),
  ]);
  const source = id('place', 'la california united states');
  const into = id('place', 'los angeles california united states');
  await rejects(() => addAlias(store, into, 'LA'), 400);
  await mergeEntity(store, source, into);
  const a = await get(store, 'a');
  assert.equal(a.city, 'Los Angeles');
  assert.equal(a.refs?.placeId, into);
});

test('AKA add and remove, and an AKA another record has is a conflict', async () => {
  const store = await setup([event('a', { companions: ['Mike', 'Sam'] })]);
  const mike = id('person', 'mike');
  await addAlias(store, mike, 'Michael');
  await rejects(() => addAlias(store, mike, 'michael'), 400);
  await rejects(() => addAlias(store, mike, 'Mike'), 400);
  await rejects(() => addAlias(store, id('person', 'sam'), 'Michael'), 409, mike);
  await rejects(() => addAlias(store, id('person', 'sam'), 'Mike'), 409, mike);
  await removeAlias(store, mike, 'MICHAEL');
  assert.equal((await store.listEntityAliases()).length, 0);
  await rejects(() => removeAlias(store, mike, 'Michael'), 404);
});

test('organizations are added by hand and host series', async () => {
  const store = await setup([event('a', { series: 'EDC Las Vegas', venue: 'Speedway' })]);
  const { entity } = await createEntity(store, 'organization', 'Insomniac');
  await rejects(() => createEntity(store, 'organization', 'insomniac'), 409, entity.id);
  await rejects(() => createEntity(store, 'venue', 'Somewhere'), 400);
  const series = id('series', 'edc las vegas');
  await addLink(store, series, entity.id, 'hosted_by');
  await rejects(() => addLink(store, series, entity.id, 'hosted_by'), 400);
  await rejects(() => addLink(store, id('venue', 'speedway'), entity.id, 'hosted_by'), 400);
  assert.equal((await store.listEntityLinks()).length, 1);
  await removeLink(store, series, entity.id, 'hosted_by');
  assert.equal((await store.listEntityLinks()).length, 0);
  // Adding is in the history but can't be undone.
  const history = await store.listEntityHistory(10);
  const created = history.find((h) => h.operation === 'create')!;
  await rejects(() => undoEntry(store, created.id), 400);
});

test('a venue is in one place: linking a second moves it', async () => {
  const store = await setup([event('a', { venue: 'Shrine', city: 'Los Angeles' }), event('b', { city: 'Pasadena' })]);
  const venue = id('venue', 'shrine');
  // Put in Los Angeles when first saved with it.
  await rejects(() => addLink(store, venue, id('place', 'los angeles'), 'in'), 400);
  await addLink(store, venue, id('place', 'pasadena'), 'in');
  assert.equal((await get(store, 'a')).city, 'Pasadena');
  assert.deepEqual(
    (await store.listEntityLinks()).map((l) => l.toId),
    [id('place', 'pasadena')],
  );
});

test('undo a merge puts records, AKAs, links and event names back', async () => {
  const store = await setup([
    event('a', { venue: 'Shrine Expo', city: 'Los Angeles' }),
    event('b', { venue: 'Shrine Expo Hall' }),
  ]);
  const source = id('venue', 'shrine expo');
  const into = id('venue', 'shrine expo hall');
  // The source venue was put in Los Angeles when first saved with it.
  assert.equal((await store.listEntityLinks()).length, 1);
  const before = {
    entities: await store.listEntities(),
    aliases: await store.listEntityAliases(),
    links: await store.listEntityLinks(),
  };
  const entry = await mergeEntity(store, source, into);
  const result = await undoEntry(store, entry.id);
  assert.equal(result.restored, 1);
  assert.deepEqual(result.skipped, []);
  const a = await get(store, 'a');
  assert.equal(a.venue, 'Shrine Expo');
  assert.equal(a.refs?.venueId, source);
  assert.equal(a.sources.venue, undefined);
  const strip = (list: Array<{ updatedAt?: string }>) => list.map(({ updatedAt: _u, ...rest }) => rest);
  assert.deepEqual(strip(await store.listEntities()), strip(before.entities));
  assert.deepEqual(await store.listEntityAliases(), before.aliases);
  assert.deepEqual(await store.listEntityLinks(), before.links);
  assert.ok((await store.getEntityHistory(entry.id))!.undoneAt);
  await rejects(() => undoEntry(store, entry.id), 409);
});

test('undo leaves events you changed since, and waits for later changes to be undone first', async () => {
  const store = await setup([event('a', { venue: 'LA Historic Park' }), event('b', { venue: 'LA Historic Park' })]);
  const venue = id('venue', 'la historic park');
  const first = await renameEntity(store, venue, 'Los Angeles Historic Park');
  const second = await addAlias(store, venue, 'State Historic Park');
  await rejects(() => undoEntry(store, first.id), 409);
  await undoEntry(store, second.id);

  // You changed event b's venue by hand after the rename.
  await store.putEvent({ ...(await get(store, 'b')), venue: 'Shrine' });
  const result = await undoEntry(store, first.id);
  assert.equal(result.restored, 1);
  assert.deepEqual(result.skipped, [{ id: 'b', name: 'Night b' }]);
  assert.equal((await get(store, 'a')).venue, 'LA Historic Park');
  assert.equal((await get(store, 'b')).venue, 'Shrine');
  assert.equal((await store.listEntities()).find((e) => e.id === venue)!.name, 'LA Historic Park');
});

test('undo of an artist merge brings back both acts', async () => {
  const store = await setup([
    event('a', { seen: [act('Joel Zimmerman', { favourite: true }), act('deadmau5', { set: 'dj' })] }),
  ]);
  const before = (await get(store, 'a')).seen;
  const entry = await mergeEntity(store, id('artist', 'joel zimmerman'), id('artist', 'deadmau5'));
  assert.equal((await get(store, 'a')).seen.length, 1);
  await undoEntry(store, entry.id);
  assert.deepEqual((await get(store, 'a')).seen, before);
});
