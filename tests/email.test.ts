import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { readEmailDate, yearFromWeekday } from '../src/server/events/email/dates.ts';
import { eventFromImport, findLogged, mergeImports, readEmails, reviewList } from '../src/server/events/email/imports.ts';
import { emailLines, htmlToLines } from '../src/server/events/email/text.ts';
import { RawEmail } from '../src/server/events/email/types.ts';
import { importsRouter } from '../src/server/events/importRoutes.ts';
import { newEvent } from '../src/server/events/service.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { PipelineDeps } from '../src/server/lineup/pipeline.ts';
import { fakeFetcher } from './fakes.ts';

// Synthetic emails in each seller's layout: made-up orders, no real mail.

const NOW = new Date('2026-10-20T12:00:00Z');

const mail = (over: Partial<RawEmail> & Pick<RawEmail, 'from' | 'subject'>): RawEmail => ({
  id: over.subject,
  link: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(over.subject)}`,
  sentAt: '2024-06-01T18:00:00Z',
  ...over,
});

const ticketmaster = mail({
  from: 'Ticketmaster <customer_support@email.ticketmaster.com>',
  subject: 'You Got Tickets To Porter Robinson',
  sentAt: '2024-06-01T18:00:00Z',
  html: `<html><head><title>Your order</title><style>.x{}</style></head><body>
    <!-- preheader -->
    <table><tr><td>Porter Robinson</td></tr>
    <tr><td>Sat, Oct 5, 2024 &middot; 8:00 PM</td></tr>
    <tr><td>Greek Theatre &mdash; Los Angeles, CA</td></tr>
    <tr><td>Order # 12-34567/LA</td></tr>
    <tr><td>Total: $142.50</td></tr></table></body></html>`,
});

const tixr = mail({
  from: 'Tixr <noreply@tixr.com>',
  subject: 'Order Confirmation: Night Owls',
  sentAt: '2026-07-01T18:00:00Z',
  text: 'Thanks for your order\nNight Owls\nThe Shrine\nSat Aug 29, 10:00 PM\n2 Items\nOrder ID:\n998877\nTotal Including Fees: $88.00',
});

const dice = mail({
  from: 'DICE <hello@dice.fm>',
  subject: 'Your tickets: MAURICE',
  sentAt: '2026-09-01T18:00:00Z',
  text: 'Venue details\nVenue\nLos Globos\n3040 Sunset Blvd, Los Angeles, CA 90026, USA\nDate & time\nSat 17 Oct,10:00 PM GMT-7\nTickets\n1 x General Admission\nTotal\n$25.00',
});

const ra = mail({
  from: 'Resident Advisor <noreply@ra.co>',
  subject: 'Your order for Deep Space',
  sentAt: '2026-10-01T18:00:00Z',
  text: "Deep Space, you're going to\nDeep Space\nFri, 11 Dec - Sat, 12 Dec 2026\n22:00 - 05:00\nThe Warehouse\n100 Main St, San Francisco, CA 94102\n2 x Early Bird\nRA123456\nTotal\n$40.00",
});

const eventbrite = mail({
  from: 'Eventbrite <orders@eventbrite.com>',
  subject: 'Your Tickets for Summer Showcase',
  sentAt: '2019-05-01T18:00:00Z',
  text: 'Summer Showcase\nSummer Showcase\n1 x General Admission\nOrder total: $15.00\nSat, Jun 8, 2019 8:00 PM - 11:00 PM PDT\nAdd to\nGoogle\nOutlook\nThe Echo\n1822 Sunset Blvd, Los Angeles, CA 90026\n#1234567890 - ordered by you',
});

test('email: HTML becomes the lines you see, with entities decoded and markup dropped', () => {
  assert.deepEqual(htmlToLines(ticketmaster.html!).slice(0, 3), [
    'Porter Robinson',
    'Sat, Oct 5, 2024 · 8:00 PM',
    'Greek Theatre — Los Angeles, CA',
  ]);
  assert.deepEqual(emailLines({ ...ticketmaster, html: undefined, text: 'Ticketmaster' }), ['Ticketmaster']);
});

test('email: each seller reader copies only what its email states, with the words', () => {
  const { outcomes, ignored } = readEmails([ticketmaster, tixr, dice, ra, eventbrite]);
  assert.equal(ignored, 0);
  const read: Record<string, any> = Object.fromEntries(outcomes.map((o) => [o.seller, 'read' in o ? o.read : o.unreadable]));

  assert.deepEqual(read.Ticketmaster, {
    kind: 'order',
    name: { value: 'Porter Robinson', quote: 'Porter Robinson' },
    startDate: { value: '2024-10-05', quote: 'Sat, Oct 5, 2024' },
    endDate: undefined,
    venue: { value: 'Greek Theatre', quote: 'Greek Theatre' },
    city: { value: 'Los Angeles, CA', quote: 'Los Angeles, CA' },
    orderId: '12-34567/LA',
    total: '$142.50',
  });
  assert.equal(read.Tixr.startDate.value, '2026-08-29');
  assert.equal(read.Tixr.venue.value, 'The Shrine');
  assert.equal(read.Tixr.orderId, '998877');
  assert.equal(read.Tixr.tickets, 2);

  assert.equal(read.DICE.startDate.value, '2026-10-17');
  assert.equal(read.DICE.venue.value, 'Los Globos');
  assert.equal(read.DICE.city.value, 'Los Angeles, CA');
  assert.equal(read.DICE.tickets, 1);

  // Ends at 5 AM the next morning: one night, not a two-day event.
  assert.equal(read['Resident Advisor'].startDate.value, '2026-12-11');
  assert.equal(read['Resident Advisor'].endDate, undefined);
  assert.equal(read['Resident Advisor'].venue.value, 'The Warehouse');
  assert.equal(read['Resident Advisor'].city.value, 'San Francisco, CA');
  assert.equal(read['Resident Advisor'].orderId, 'RA123456');

  assert.equal(read.Eventbrite.startDate.value, '2019-06-08');
  assert.equal(read.Eventbrite.venue.value, 'The Echo');
  assert.equal(read.Eventbrite.orderId, '1234567890');
  assert.equal(read.Eventbrite.total, '$15.00');
});

test('email: ads and senders without a reader are ignored; a ticket email in an unknown layout is kept as unreadable', () => {
  const ad = mail({ from: 'Ticketmaster <news@email.ticketmaster.com>', subject: 'Presale this Friday', text: 'Get tickets' });
  const stranger = mail({ from: 'Friend <a@example.com>', subject: 'You Got Tickets To Nothing', text: 'hi' });
  const broken = mail({ from: 'DICE <hello@dice.fm>', subject: 'Your tickets: Mystery Night', text: 'Something new' });
  const { outcomes, ignored } = readEmails([ad, stranger, broken]);
  assert.equal(ignored, 2);
  assert.equal(outcomes.length, 1);
  assert.ok('unreadable' in outcomes[0]);
});

test('email dates: a missing year is the one where the weekday fits, within a year of sending', () => {
  assert.equal(yearFromWeekday(8, 29, 6, '2026-07-01T00:00:00Z'), 2026);
  // Sent in December for early January: the next year.
  assert.equal(yearFromWeekday(1, 2, 6, '2026-12-20T00:00:00Z'), 2027);
  // The weekday does not fit this year or next: no year.
  assert.equal(yearFromWeekday(8, 29, 0, '2026-07-01T00:00:00Z'), undefined);
  // 29 February only exists in a leap year, and the weekday must still fit.
  assert.equal(readEmailDate('Thu Feb 29', '2023-11-01T00:00:00Z')?.startDate, '2024-02-29');
  assert.equal(readEmailDate('Fri Feb 29', '2023-11-01T00:00:00Z')?.startDate, undefined);
  // No weekday and no year: the words are kept, the date is not guessed.
  assert.deepEqual(readEmailDate('Aug 29, 10:00 PM', '2026-07-01T00:00:00Z'), { quote: 'Aug 29' });
  // A stated year whose weekday disagrees is not trusted.
  assert.equal(readEmailDate('Sun, Oct 5, 2024', '2024-06-01T00:00:00Z')?.startDate, undefined);
});

test('email dates: ranges keep the end date unless the night ends the next morning', () => {
  assert.deepEqual(readEmailDate('Fri, Oct 16 - Sun, Oct 18, 2026', '2026-06-01T00:00:00Z'), {
    startDate: '2026-10-16',
    endDate: '2026-10-18',
    quote: 'Fri, Oct 16 - Sun, Oct 18, 2026',
  });
  // Across the year end: the start takes the year before the end's.
  assert.equal(readEmailDate('Dec 31 - Jan 1 2027 2:00 PM', '2026-06-01T00:00:00Z')?.startDate, '2026-12-31');
  assert.equal(readEmailDate('Sat, 17 Oct 2026 10:00 PM - Sun, 18 Oct 2026 4:00 AM', '2026-06-01T00:00:00Z')?.endDate, undefined);
  assert.equal(readEmailDate('Sat, 17 Oct 2026 2:00 PM - Sun, 18 Oct 2026 11:00 PM', '2026-06-01T00:00:00Z')?.endDate, '2026-10-18');
});

test('email imports: one row per show; resends merge, refunds flag the show even when they arrive first', () => {
  const refund = mail({ from: 'DICE <hello@dice.fm>', subject: 'Refund requested: MAURICE', sentAt: '2026-09-05T18:00:00Z', text: 'Your refund' });
  const resend = { ...dice, id: 'dice-resend' };

  const first = mergeImports([], readEmails([refund]).outcomes, [], NOW);
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'flag');
  assert.deepEqual(reviewList(first), []);

  const rows = mergeImports(first, readEmails([dice, resend, ticketmaster]).outcomes, [], NOW);
  const maurice = rows.find((r) => r.name === 'MAURICE')!;
  assert.equal(maurice.status, 'new');
  assert.deepEqual(maurice.flags, ['refunded']);
  assert.deepEqual(maurice.messages.map((m) => m.id).sort(), ['Your tickets: MAURICE', 'Refund requested: MAURICE', 'dice-resend'].sort());
  assert.equal(maurice.sources.venue?.quote, 'Los Globos');
  assert.equal(maurice.sources.venue?.link, dice.link);

  // Importing the same mail again changes nothing.
  const all = [...first, ...rows.filter((r) => !first.includes(r))];
  assert.deepEqual(mergeImports(all, readEmails([dice, resend, ticketmaster, refund]).outcomes, [], NOW), []);
});

test('email imports: a show already in your log is matched, by date and a contained name', () => {
  const logged = { ...newEvent('Porter Robinson - Smile! :D World Tour', NOW), startDate: '2024-10-05' };
  const [row] = mergeImports([], readEmails([ticketmaster]).outcomes, [logged], NOW);
  assert.equal(row.eventId, logged.id);
  assert.equal(findLogged({ ...row, startDate: '2024-10-06' }, [logged]), undefined);
});

test('email imports: an added event cites its email and quote and leaves personal fields empty', () => {
  const [row] = mergeImports([], readEmails([ticketmaster]).outcomes, [], NOW);
  const event = eventFromImport(row, NOW);
  assert.equal(event.name, 'Porter Robinson');
  assert.equal(event.startDate, '2024-10-05');
  assert.deepEqual(event.sources.venue, { sourceType: 'email', sourceUrl: ticketmaster.link, quote: 'Greek Theatre' });
  assert.equal(event.ticketPrice, undefined);
  assert.equal(event.rating, undefined);
  assert.deepEqual(event.seen, []);
  assert.equal(event.details.status, 'resolved');
});

async function server(t: { after: (fn: () => void) => void }) {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'imports-')));
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
  app.use(express.json({ limit: '25mb' }));
  app.use('/api', importsRouter(deps));
  const listening = app.listen(0);
  await new Promise((resolve) => listening.once('listening', resolve));
  t.after(() => listening.close());
  const base = `http://127.0.0.1:${(listening.address() as AddressInfo).port}/api`;
  const call = (route: string, body?: unknown, token?: string) =>
    fetch(`${base}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { store, call };
}

test('import routes: posting mail needs the import token', async (t) => {
  const { call } = await server(t);
  const saved = process.env.IMPORT_TOKEN;
  t.after(() => (saved === undefined ? delete process.env.IMPORT_TOKEN : (process.env.IMPORT_TOKEN = saved)));

  delete process.env.IMPORT_TOKEN;
  assert.equal((await call('/imports/email', { emails: [] }, 'anything')).status, 503);
  process.env.IMPORT_TOKEN = 'right-token';
  assert.equal((await call('/imports/email', { emails: [] })).status, 401);
  assert.equal((await call('/imports/email', { emails: [] }, 'wrong-token')).status, 401);
  assert.equal((await call('/imports/email', { emails: [{ id: 'x' }] }, 'right-token')).status, 400);
  const ok = await call('/imports/email', { emails: [ticketmaster, dice] }, 'right-token');
  assert.deepEqual(await ok.json(), { read: 2, unreadable: 0, ignored: 0, changed: 2 });
});

test('import routes: nothing is saved until you tick it; future shows wait; skips can be undone', async (t) => {
  const { store, call } = await server(t);
  process.env.IMPORT_TOKEN = 'right-token';
  t.after(() => delete process.env.IMPORT_TOKEN);
  await call('/imports/email', { emails: [ticketmaster, dice, ra] }, 'right-token');
  assert.deepEqual(await store.listEvents(), []);

  const { imports } = await (await call('/imports')).json();
  const id = (name: string) => imports.find((r: any) => r.name === name).id;

  const added = await (await call('/imports/add', { ids: [id('Porter Robinson'), id('Deep Space')] })).json();
  assert.deepEqual(added.events.map((e: any) => e.name), ['Porter Robinson']);
  const events = await store.listEvents();
  assert.deepEqual(events.map((e) => e.name), ['Porter Robinson']);

  // Adding again does not duplicate it.
  assert.deepEqual((await (await call('/imports/add', { ids: [id('Porter Robinson')] })).json()).events, []);

  const skipped = await (await call('/imports/skip', { ids: [id('MAURICE')] })).json();
  assert.equal(skipped.imports[0].status, 'skipped');
  const restored = await (await call('/imports/skip', { ids: [id('MAURICE')], restore: true })).json();
  assert.equal(restored.imports[0].status, 'new');
  assert.equal((await store.listEvents()).length, 1);
});
