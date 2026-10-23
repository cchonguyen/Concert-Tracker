import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { mergeIntoEvent, unmergeFromEvent } from '../src/server/events/email/imports.ts';
import { EmailImport } from '../src/server/events/email/types.ts';
import { importsRouter } from '../src/server/events/importRoutes.ts';
import { applyPatch, newEvent } from '../src/server/events/service.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { PipelineDeps } from '../src/server/lineup/pipeline.ts';
import { fakeFetcher } from './fakes.ts';

// "Same as one of mine": an email's show merged into an event you entered.
// Made-up rows, no real mail.

const NOW = new Date('2026-10-23T12:00:00Z');
const src = (quote: string) => ({ messageId: 'm1', link: 'https://mail.example/m1', quote });

const row = (over: Partial<EmailImport> = {}): EmailImport => ({
  id: 'r1',
  key: 'audien|2024-07-13',
  status: 'new',
  seller: 'TicketWeb',
  name: 'Audien',
  startDate: '2024-07-13',
  venue: 'Avalon Hollywood',
  city: 'Hollywood, CA',
  ticketPrice: 29.95,
  sources: {
    name: src('Audien'),
    startDate: src('Sat Jul 13, 2024'),
    venue: src('Avalon Hollywood'),
    city: src('1735 Vine St., Hollywood, CA'),
    ticketPrice: src('$59.90 for 2 tickets'),
  },
  messages: [{ id: 'm1', subject: 'Your TicketWeb Tickets Have Arrived!', sentAt: '2024-07-11T05:00:00Z', kind: 'order' }],
  flags: [],
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  ...over,
});

test('merge: fills only empty fields, each from the email, and keeps what you entered', () => {
  const typed = { ...newEvent('Audien at Avalon 2024', NOW), id: 'e1' };
  assert.equal(typed.venue, 'Avalon');
  const { event, filled, kept } = mergeIntoEvent(row(), typed, NOW);
  assert.deepEqual(filled.sort(), ['city', 'startDate', 'ticketPrice']);
  assert.equal(event.name, typed.name); // your name stays
  assert.equal(event.venue, 'Avalon'); // yours, though the email says otherwise
  assert.deepEqual(kept, [{ field: 'venue', yours: 'Avalon', email: 'Avalon Hollywood' }]);
  assert.equal(event.startDate, '2024-07-13');
  assert.deepEqual(event.sources.startDate, { sourceType: 'email', sourceUrl: 'https://mail.example/m1', quote: 'Sat Jul 13, 2024' });
  assert.deepEqual([event.city, event.region], ['Hollywood', 'CA']);
  assert.equal(event.ticketPrice, 29.95);
});

test('merge: a date, a year or a price you gave is never replaced; the same value is not a conflict', () => {
  const dated = { ...newEvent('Audien', NOW), id: 'e1', startDate: '2024-07-12', year: 2024, venue: 'avalon hollywood', ticketPrice: 40 };
  const a = mergeIntoEvent(row(), dated, NOW);
  assert.equal(a.event.startDate, '2024-07-12');
  assert.equal(a.event.ticketPrice, 40);
  assert.deepEqual(
    a.kept.map((k) => k.field),
    ['startDate', 'ticketPrice'],
  );
  const otherYear = { ...newEvent('Audien', NOW), id: 'e2', year: 2023 };
  const b = mergeIntoEvent(row(), otherYear, NOW);
  assert.equal(b.event.startDate, undefined);
  assert.deepEqual(b.kept[0], { field: 'startDate', yours: '2023', email: '2024-07-13' });
  // A price you cleared stays cleared.
  const cleared = applyPatch({ ...newEvent('Audien', NOW), id: 'e3' }, { ticketPrice: null }, NOW);
  assert.equal(mergeIntoEvent(row(), cleared, NOW).event.ticketPrice, undefined);
});

test('undo: clears what the merge filled, but not a field you changed since', () => {
  const typed = { ...newEvent('Audien', NOW), id: 'e1' };
  const { event, filled } = mergeIntoEvent(row(), typed, NOW);
  const edited = applyPatch(event, { venue: 'Avalon' }, NOW);
  const back = unmergeFromEvent({ ...row(), mergedFields: filled }, edited, NOW);
  assert.equal(back.venue, 'Avalon'); // your edit after the merge
  assert.equal(back.startDate, undefined);
  assert.deepEqual([back.city, back.region], [undefined, undefined]);
  assert.equal(back.ticketPrice, undefined);
  assert.equal(back.sources.startDate, undefined);
});

async function server(t: { after: (fn: () => void) => void }) {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'merge-')));
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
  app.use(express.json());
  app.use('/api', importsRouter(deps));
  const listening = app.listen(0);
  await new Promise((resolve) => listening.once('listening', resolve));
  t.after(() => listening.close());
  const base = `http://127.0.0.1:${(listening.address() as AddressInfo).port}/api`;
  const call = (route: string, body: unknown) =>
    fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { store, call };
}

test('merge routes: merge links the email to your event without a new one; undo puts it back on the list', async (t) => {
  const { store, call } = await server(t);
  const typed = { ...newEvent('Audien at Avalon', NOW), id: 'e1' };
  await store.putEvents([typed]);
  await store.putImports([row()]);

  const res = await (await call('/imports/merge', { id: 'r1', eventId: 'e1' })).json();
  assert.deepEqual(res.filled.sort(), ['city', 'startDate', 'ticketPrice']);
  assert.equal(res.import.status, 'added');
  assert.equal(res.import.eventId, 'e1');
  const events = await store.listEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].startDate, '2024-07-13');
  assert.equal(events[0].venue, 'Avalon');

  // Merging it again, or into an event you don't have, is refused.
  assert.equal((await call('/imports/merge', { id: 'r1', eventId: 'e1' })).status, 400);

  const undone = await (await call('/imports/unmerge', { id: 'r1' })).json();
  assert.equal(undone.import.status, 'new');
  assert.equal(undone.import.eventId, undefined);
  const [after] = await store.listEvents();
  assert.equal(after.startDate, undefined);
  assert.equal(after.venue, 'Avalon');
  assert.equal((await call('/imports/merge', { id: 'r1', eventId: 'nope' })).status, 400);
});
