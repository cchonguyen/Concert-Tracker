import { dispatch } from './helpers/testApp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { fakeFetcher } from './fakes.ts';
import { PipelineDeps } from '../src/server/lineup/pipeline.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { importsRouter } from '../src/server/events/importRoutes.ts';
import { newEvent } from '../src/server/events/service.ts';
import { ticketFactsFor } from '../src/server/events/email/ticketFacts.ts';
import { EmailImport } from '../src/server/events/email/types.ts';

const NOW = new Date('2026-10-23T12:00:00Z');

const row = (over: Partial<EmailImport>): EmailImport => ({
  id: 'r1',
  key: 'k1',
  status: 'added',
  seller: 'Ticketmaster',
  sources: {},
  messages: [],
  flags: [],
  eventId: 'e1',
  orderIds: ['ABC-123456'],
  tickets: 2,
  total: '$90.00',
  ticketPrice: 45,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

test('no import for the event gives null', () => {
  assert.equal(ticketFactsFor([row({ eventId: 'other' })], 'e1'), null);
  assert.equal(ticketFactsFor([], 'e1'), null);
});

test('a skipped, new or unreadable import is ignored', () => {
  const imports = [row({ id: 'a', status: 'skipped' }), row({ id: 'b', status: 'new' }), row({ id: 'c', status: 'unreadable' })];
  assert.equal(ticketFactsFor(imports, 'e1'), null);
});

test('the most recently updated import wins', () => {
  const older = row({ id: 'old', seller: 'AXS', tickets: 1, updatedAt: '2026-01-01T00:00:00.000Z' });
  const newer = row({ id: 'new', seller: 'Eventbrite', tickets: 4, updatedAt: '2026-03-01T00:00:00.000Z' });
  assert.deepEqual(ticketFactsFor([older, newer], 'e1'), { seller: 'Eventbrite', orderLast4: '3456', tickets: 4 });
});

test('a merged import (status added with the event id) counts', () => {
  assert.deepEqual(ticketFactsFor([row({ seller: 'Dice', orderIds: undefined, tickets: undefined })], 'e1'), { seller: 'Dice' });
});

test('order last 4 strips punctuation and keeps the last four characters', () => {
  assert.equal(ticketFactsFor([row({ orderIds: ['ab-12 34-zz'] })], 'e1')?.orderLast4, '34zz');
  assert.equal(ticketFactsFor([row({ orderIds: ['ORD-99/4471'] })], 'e1')?.orderLast4, '4471');
});

test('a short order number is omitted', () => {
  assert.deepEqual(ticketFactsFor([row({ orderIds: ['A-12'] })], 'e1'), { seller: 'Ticketmaster', tickets: 2 });
  assert.deepEqual(ticketFactsFor([row({ orderIds: ['AB-12'] })], 'e1'), { seller: 'Ticketmaster', orderLast4: 'AB12', tickets: 2 });
});

test('zero, negative or fractional tickets are omitted', () => {
  assert.deepEqual(ticketFactsFor([row({ tickets: 0 })], 'e1'), { seller: 'Ticketmaster', orderLast4: '3456' });
  assert.deepEqual(ticketFactsFor([row({ tickets: -2 })], 'e1'), { seller: 'Ticketmaster', orderLast4: '3456' });
  assert.deepEqual(ticketFactsFor([row({ tickets: 1.5 })], 'e1'), { seller: 'Ticketmaster', orderLast4: '3456' });
});

test('a blank seller is omitted', () => {
  assert.deepEqual(ticketFactsFor([row({ seller: '   ' })], 'e1'), { orderLast4: '3456', tickets: 2 });
});

test('seller is trimmed', () => {
  assert.equal(ticketFactsFor([row({ seller: '  Live Nation ' })], 'e1')?.seller, 'Live Nation');
});

test('all three missing gives null', () => {
  assert.equal(ticketFactsFor([row({ seller: '', orderIds: ['x'], tickets: 0 })], 'e1'), null);
});

test('never returns total, price or other import fields', () => {
  const facts = ticketFactsFor([row({ total: '$90.00', ticketPrice: 45, name: 'Show', venue: 'Hall' })], 'e1');
  assert.deepEqual(Object.keys(facts ?? {}).sort(), ['orderLast4', 'seller', 'tickets']);
});

test('GET /imports/facts/:eventId returns the facts of the email the event came from', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'facts-')));
  const deps: PipelineDeps = {
    store,
    fetcher: fakeFetcher({}).fetcher,
    adapters: [],
    lateAdapters: [],
    gemini: null,
    quota: null,
    search: null,
    now: () => NOW,
  };
  const app = express();
  app.use('/api', importsRouter(deps));
  await store.putEvents([{ ...newEvent('Audien at Avalon', NOW), id: 'e1' }]);
  await store.putImports([row({ id: 'r1', eventId: 'e1' })]);

  const got = await dispatch(app, { method: 'GET', url: '/api/imports/facts/e1' });
  assert.equal(got.status, 200);
  assert.deepEqual(JSON.parse(got.body), { facts: { seller: 'Ticketmaster', orderLast4: '3456', tickets: 2 } });

  const none = await dispatch(app, { method: 'GET', url: '/api/imports/facts/nope' });
  assert.deepEqual(JSON.parse(none.body), { facts: null });
});
