import { dispatch } from './helpers/testApp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { withEntityLinks } from '../src/server/entities/linkingStore.ts';
import { peopleRouter } from '../src/server/entities/people.ts';
import type { LoggedEvent } from '../src/server/events/types.ts';
import { createVault } from '../src/services/vault.ts';
import { dehydrateBody, hydrateEvent, PeopleBook, type PeopleServer } from '../src/services/vaultPeople.ts';

// The browser's people book against the real /api/people routes and a real (file) store.

const ev = (id: string, patch: Partial<LoggedEvent> = {}): LoggedEvent => ({
  id, input: id, name: id, sources: {}, details: { status: 'resolved', candidates: [], notes: [] },
  seen: [], daysAttended: [], companions: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...patch,
});
const MATERIAL = { vaultSalt: 'c2FsdHNhbHRzYWx0c2FsdA==', kdfAlg: 'PBKDF2-SHA256', pbkdf2Iterations: 1000, passphraseSalt: 'cGFzc3NhbHRwYXNzc2FsdA==', wrappedByPassphrase: 'w1:aXZpdml2aXZpdml2:Y2lwaGVydGV4dGNpcGhlcnRleHQ=', wrappedByRecovery: 'w1:aXZpdml2aXZpdml2:cmVjb3ZlcnljaXBoZXJ0ZXh0' };

async function fixture() {
  const base = withEntityLinks(new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'people-'))));
  const store = base.forUser!({ userId: 'u-ann', role: 'member' });
  await store.putSetting('vault', MATERIAL);
  const app = express();
  app.use(express.json());
  app.use('/api', peopleRouter(store));
  const send = async (route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const r = await dispatch(app, { method, url: `/api${route}`, headers: { 'content-type': 'application/json' }, body });
    const json = r.json<any>();
    if (r.status < 200 || r.status > 299) throw new Error(json.error);
    return json;
  };
  const api: PeopleServer = {
    list: () => send('/people'),
    put: (id, body) => send(`/people/${id}`, body, 'PUT'),
    merge: (id, into) => send(`/people/${id}/merge`, { into }),
    convert: (id, to) => send(`/people/${id}/convert`, { to }),
    finish: () => send('/people/finish', {}),
  };
  const v = await createVault('people passphrase', 1000);
  let n = 0;
  const book = () => new PeopleBook(v.keys, api, () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`);
  return { store, api, v, book };
}

test('people book: a typed name finds its person by token, or makes one; the server never sees a name', async () => {
  const f = await fixture();
  const book = f.book();
  await book.load();
  const jen = await book.idFor('Jen');
  assert.equal(await book.idFor('  jen '), jen);
  assert.notEqual(await book.idFor('Sam'), jen);
  assert.equal(await book.idFor('!!!'), null);
  // A fresh page load (a new book) finds the same people.
  const again = f.book();
  await again.load();
  assert.equal(await again.idFor('JEN'), jen);
  assert.equal(again.nameOf(jen!), 'Jen');
  const stored = JSON.stringify([await f.store.listEntities(), await f.store.listEntityAliases()]);
  assert.ok(!/Jen|Sam/.test(stored));
});

test('people book: events go to the server as ids and come back as names; locked, they say so', async () => {
  const f = await fixture();
  const book = f.book();
  await book.load();
  const body = await dehydrateBody({ companions: ['Jen', 'Sam', 'jen'] }, book);
  assert.deepEqual(body.companions, []);
  assert.equal(body.personIds!.length, 2);
  await f.store.putEvent(ev('e1', { personIds: body.personIds }));
  const stored = (await f.store.getEvent('e1'))!;
  assert.deepEqual(stored.companions, []);
  const shown = hydrateEvent(stored, book);
  assert.deepEqual(shown.companions, ['Jen', 'Sam']);
  assert.deepEqual(shown.refs?.companionIds, body.personIds);
  assert.deepEqual(hydrateEvent(stored, null).companions, []);
  assert.equal(hydrateEvent(stored, null).peopleLocked, true);
  assert.equal(hydrateEvent(ev('e2'), null).peopleLocked, undefined); // no people: nothing is hidden
  await assert.rejects(dehydrateBody({ companions: ['Jen'] }, null), /Unlock your vault/);
  assert.deepEqual(await dehydrateBody({ companions: [] }, null), { companions: [] });
});

test('people book: rename keeps the old name working, an alias cannot take another person\'s name, merge repoints events', async () => {
  const f = await fixture();
  const book = f.book();
  await book.load();
  const jen = (await book.idFor('Jen'))!;
  const sam = (await book.idFor('Sam'))!;
  await book.rename(jen, 'Jennifer');
  assert.equal(book.nameOf(jen), 'Jennifer');
  assert.equal(await book.idFor('Jen'), jen); // the old name is an AKA now
  await assert.rejects(book.rename(sam, 'Jennifer'), /already called/);
  await assert.rejects(book.addAlias(sam, 'Jen'), /already called/);
  await book.addAlias(sam, 'Sammy');
  await book.setDetails(sam, { note: 'from work' });
  await f.store.putEvents([ev('e1', { personIds: [jen, sam] }), ev('e2', { personIds: [sam] })]);
  await book.merge(sam, jen);
  assert.deepEqual((await f.store.getEvent('e1'))!.personIds, [jen]);
  assert.deepEqual((await f.store.getEvent('e2'))!.personIds, [jen]);
  assert.equal(await book.idFor('Sammy'), jen);
  assert.equal(await book.idFor('Sam'), jen);
  assert.deepEqual(book.get(jen)!.details.aliases?.sort(), ['Jen', 'Sam', 'Sammy']);
  // After a reload everything still reads back.
  const fresh = f.book();
  await fresh.load();
  assert.equal(fresh.nameOf(sam), 'Jennifer');
  assert.equal(fresh.get(jen)!.details.note, undefined);
});

test('people book: turning the vault on converts the plain people and erases their names', async () => {
  const f = await fixture();
  // Plain people from before the vault (the setting is set first here, but the events keep their names).
  await f.store.putEvents([ev('e1', { companions: ['Jen', 'Sam'] }), ev('e2', { companions: ['Jen'] })]);
  const book = f.book();
  const plain = await book.load();
  assert.deepEqual(plain.map((p) => p.name).sort(), ['Jen', 'Sam']);
  await book.convertPlain(plain);
  assert.deepEqual((await f.api.list()).plain, []);
  const events = (await f.store.listEvents()).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(events.map((e) => e.companions), [[], []]);
  assert.deepEqual(events.map((e) => hydrateEvent(e, book).companions), [['Jen', 'Sam'], ['Jen']]);
  assert.ok(!/Jen|Sam/.test(JSON.stringify([await f.store.listEntities(), await f.store.listEntityAliases(), events])));
});

test('Manage: encrypted people are listed by name with their AKAs; locked, they are named as such', async () => {
  const { openPeople, setPeopleHooks } = await import('../src/services/lineupApi.ts');
  const f = await fixture();
  const book = f.book();
  await book.load();
  const jen = (await book.idFor('Jen'))!;
  await book.addAlias(jen, 'Jenny B');
  await book.setDetails(jen, { first: 'Jen', last: 'Bell', note: 'from work' });
  const served = (await f.store.listEntities()).concat([{ id: 'v1', kind: 'venue', name: 'Forum', nameNormalized: 'forum', attrs: {}, createdAt: '', updatedAt: '' }]);
  const data = { entities: served, aliases: await f.store.listEntityAliases(), links: [], duplicates: [] };
  setPeopleHooks({ book });
  const open = openPeople(data);
  const person = open.entities.find((e) => e.id === jen)!;
  assert.deepEqual([person.name, person.attrs], ['Jen', { first: 'Jen', last: 'Bell', note: 'from work' }]);
  assert.deepEqual(open.aliases.filter((a) => a.entityId === jen).map((a) => a.aliasNormalized), ['jenny b']); // no tokens shown
  assert.equal(open.entities.find((e) => e.id === 'v1')!.name, 'Forum');
  setPeopleHooks({ book: null });
  assert.equal(openPeople(data).entities.find((e) => e.id === jen)!.name, 'Locked person');
  setPeopleHooks(null);
});
