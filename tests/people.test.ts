import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { LoggedEvent } from '../src/server/events/types.ts';
import { withEntityLinks } from '../src/server/entities/linkingStore.ts';
import { entityIdFor } from '../src/server/entities/link.ts';
import { ManageError, undoEntry, updatePerson } from '../src/server/entities/manage.ts';
import { displayNames, nameForms, personParts } from '../src/services/people.ts';

const AT = '2026-10-28T00:00:00.000Z';

const event = (id: string, companions: string[]): LoggedEvent => ({
  id,
  input: '',
  name: `Night ${id}`,
  sources: {},
  details: { status: 'resolved', candidates: [], notes: [] },
  seen: [],
  daysAttended: [],
  companions,
  createdAt: AT,
  updatedAt: AT,
});

const people = (...names: Array<string | [string, Record<string, unknown>]>) =>
  names.map((n, i) => (typeof n === 'string' ? { id: `p${i}`, name: n } : { id: `p${i}`, name: n[0], attrs: n[1] }));

test('the parts you set win; before that the first word is the first name', () => {
  assert.deepEqual(personParts('Mary Kate Olsen'), { first: 'Mary', last: 'Kate Olsen' });
  assert.deepEqual(personParts('Mike'), { first: 'Mike' });
  assert.deepEqual(personParts('Mary Kate Olsen', { first: 'Mary Kate', last: 'Olsen' }), { first: 'Mary Kate', last: 'Olsen' });
  assert.deepEqual(personParts('Cher', { first: ' Cher ', last: '' }), { first: 'Cher' });
});

test('full, First L. and initials', () => {
  assert.deepEqual(nameForms('Mike Rivera'), { full: 'Mike Rivera', short: 'Mike R.', initials: 'MR' });
  assert.deepEqual(nameForms('Mike'), { full: 'Mike', short: 'Mike', initials: 'M' });
  assert.deepEqual(nameForms('Zoë ōtani'), { full: 'Zoë ōtani', short: 'Zoë Ō.', initials: 'ZŌ' });
  assert.deepEqual(nameForms('Mary Kate Olsen', { first: 'Mary Kate', last: 'Olsen' }).short, 'Mary Kate O.');
});

test('a shorter form that two people share stays one step longer for both', () => {
  const names = displayNames(people('Mike Rivera', 'Mike Reyes', 'Sam Lee'));
  assert.deepEqual(names.get('p0'), { full: 'Mike Rivera', short: 'Mike Rivera', initials: 'Mike Rivera' });
  assert.deepEqual(names.get('p1'), { full: 'Mike Reyes', short: 'Mike Reyes', initials: 'Mike Reyes' });
  assert.deepEqual(names.get('p2'), { full: 'Sam Lee', short: 'Sam L.', initials: 'SL' });
});

test('initials that collide fall back to First L., which can still differ', () => {
  const names = displayNames(people('Mike Rivera', 'Maya Ross'));
  assert.equal(names.get('p0')!.short, 'Mike R.');
  assert.equal(names.get('p0')!.initials, 'Mike R.');
  assert.equal(names.get('p1')!.initials, 'Maya R.');
});

test('a short form equal to someone else\'s name goes longer only for that one', () => {
  const names = displayNames(people('Mike Rivera', 'Mike R.'));
  assert.equal(names.get('p0')!.short, 'Mike Rivera');
  assert.equal(names.get('p1')!.short, 'Mike R.');
});

test('a single name keeps its one initial unless it collides', () => {
  const names = displayNames(people('Mike', 'Sam', 'Max'));
  assert.equal(names.get('p1')!.initials, 'S');
  assert.equal(names.get('p0')!.initials, 'Mike');
  assert.equal(names.get('p2')!.initials, 'Max');
});

async function setup(events: LoggedEvent[]) {
  const store = withEntityLinks(new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'people-'))));
  await store.putEvents(events);
  return store;
}

test('setting first and last name renames the person everywhere, and undo puts it back', async () => {
  const store = await setup([event('a', ['Mike', 'Sam']), event('b', ['Mike'])]);
  const id = entityIdFor('person', 'mike');
  const entry = await updatePerson(store, id, { first: 'Mike', last: ' Rivera ', note: 'Met at EDC' }, AT);
  assert.equal(entry.operation, 'rename');
  assert.deepEqual((await store.getEvent('a'))!.companions, ['Mike Rivera', 'Sam']);
  assert.deepEqual((await store.getEvent('b'))!.companions, ['Mike Rivera']);
  const person = (await store.listEntities()).find((e) => e.id === id)!;
  assert.equal(person.name, 'Mike Rivera');
  assert.deepEqual(person.attrs, { first: 'Mike', last: 'Rivera', note: 'Met at EDC' });
  assert.ok((await store.listEntityAliases()).some((a) => a.entityId === id && a.aliasNormalized === 'mike'));

  await undoEntry(store, entry.id);
  assert.deepEqual((await store.getEvent('a'))!.companions, ['Mike', 'Sam']);
  const undone = (await store.listEntities()).find((e) => e.id === id)!;
  assert.equal(undone.name, 'Mike');
  assert.deepEqual(undone.attrs, {});
});

test('a note alone changes only the record', async () => {
  const store = await setup([event('a', ['Mike Rivera'])]);
  const id = entityIdFor('person', 'mike rivera');
  const entry = await updatePerson(store, id, { first: 'Mike', last: 'Rivera', note: 'Bass player' }, AT);
  assert.equal(entry.operation, 'details');
  assert.equal(entry.events.length, 0);
  const again = await updatePerson(store, id, { first: 'Mike', last: 'Rivera' }, AT);
  assert.equal((await store.listEntities()).find((e) => e.id === id)!.attrs.note, undefined);
  await undoEntry(store, again.id);
  assert.equal((await store.listEntities()).find((e) => e.id === id)!.attrs.note, 'Bass player');
});

test('person details are checked', async () => {
  const store = await setup([event('a', ['Mike', 'Sam Lee'])]);
  const id = entityIdFor('person', 'mike');
  await assert.rejects(updatePerson(store, id, { first: ' ' }), ManageError);
  await assert.rejects(updatePerson(store, id, { first: 'Mike', note: 'x'.repeat(2001) }), ManageError);
  await assert.rejects(updatePerson(store, id, { first: 'Sam', last: 'Lee' }), (err: ManageError) => err.status === 409);
  await assert.rejects(updatePerson(store, entityIdFor('venue', 'nowhere'), { first: 'X' }), ManageError);
});
