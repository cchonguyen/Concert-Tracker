import { dispatch } from './helpers/testApp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

test('email: Eventbrite orders from 2013 and 2015 to 2018 are read too', () => {
  const y2013 = mail({
    from: 'Eventbrite <orders@eventbrite.com>',
    subject: 'Order Confirmation for Garage Night',
    sentAt: '2013-09-06T18:00:00Z',
    text: 'Your order for Garage Night is complete!\nSaturday, September 14, 2013 at 10:00 PM - Sunday, September 15, 2013 at 6:00 AM (PDT)\nGarage Night\nThe Basement\n401 6th St\nSan Francisco, CA 94103\nOrder #: 1000000001-200000001\nTOTAL\n$12.00',
  });
  const y2015 = mail({
    from: 'Eventbrite <orders@eventbrite.com>',
    subject: 'Your Tickets for Costume Party',
    sentAt: '2015-10-04T18:00:00Z',
    text: 'Hi Sam , this is your order confirmation for Costume Party\nOrganized by Party People\nOrder Summary\nOrder #: 100000002\nAbout this event\nSaturday, October 17, 2015 at 9:30 PM - Sunday, October 18, 2015 at 2:00 AM (PDT)\nRickshaw Stop\n155 Fell St\nSan Francisco, CA 94102\nAdd to my calendar:\nGoogle',
  });
  // The organizer shares the event's name; the order card is the one with a date.
  const organizer = mail({
    from: 'Eventbrite <noreply@order.eventbrite.com>',
    subject: 'Your Tickets for Grave Rave',
    sentAt: '2023-04-25T18:00:00Z',
    text: 'Go to My Tickets\nGrave Rave\n5 x Tickets\nOrder total: Free\nSaturday, April 29, 2023 at 9:00 PM - Sunday, April 30, 2023 at 2:00 AM (PT)\nAdd to\nGoogle\nOrigin\n1538 Fillmore Street\nSan Francisco, CA 94115\nGrave Rave\nFollow\n#1000000003 - April 25, 2023',
  });
  const [a, b, c] = readEmails([y2013, y2015, organizer]).outcomes.map((o) => ('read' in o ? o.read : assert.fail(o.unreadable)));
  assert.deepEqual(
    [a.startDate?.value, a.endDate, a.venue?.value, a.city?.value, a.orderId, a.total],
    ['2013-09-14', undefined, 'The Basement', 'San Francisco, CA', '1000000001-200000001', '$12.00'],
  );
  assert.equal(a.name.quote, 'Garage Night');
  assert.deepEqual(
    [b.startDate?.value, b.venue?.value, b.city?.value, b.orderId],
    ['2015-10-17', 'Rickshaw Stop', 'San Francisco, CA', '100000002'],
  );
  assert.equal(b.name.quote, 'Hi Sam , this is your order confirmation for Costume Party');
  assert.deepEqual([c.startDate?.value, c.venue?.value, c.tickets, c.orderId], ['2023-04-29', 'Origin', 5, '1000000003']);
});

test('email: AXS orders, deliveries and transfers from friends are read; resale mail is not', () => {
  const ordered = mail({
    from: 'AXS Guest Services <guestservices@axs.com>',
    subject: 'Thank you for your order for Night Bloom -  Artist Presale',
    sentAt: '2026-07-29T18:00:00Z',
    text: 'Thank you for your order. Your confirmation number is 10000004 . Please keep this number.\nOrder details for Night Bloom - Artist Presale at El Rey Theatre scheduled on 10/1/2026 8:00 PM\nGrand Total:\n$36.50',
  });
  const delivered = mail({
    from: 'guestservices@axs.com',
    subject: 'Your tickets were delivered to your account!',
    sentAt: '2026-07-29T18:01:00Z',
    text: 'YOUR TICKETS ARE HERE!\nThu Oct 1, 2026 - 8:00 PM\nNight Bloom - Admissions\nEl Rey, Los Angeles, CA\nHere is how to use your tickets:',
  });
  const oldTransfer = mail({
    from: 'axs@axs.com',
    subject: 'Tickets Just Got Sent To You',
    sentAt: '2023-09-21T02:00:00Z',
    text: 'TICKETS JUST GOT SENT TO YOU\nSam Lee transferred 2 tickets to you for Lantern Fest at The Greek Theatre, Los Angeles, CA on Friday 9-22-23 at 6:45 pm PDT.',
  });
  const wrongDay = mail({
    ...oldTransfer,
    id: 'wrong-day',
    text: oldTransfer.text!.replace('Friday', 'Monday'),
  });
  const resale = mail({
    from: 'axs@axs.com',
    subject: 'Your Tickets are No Longer for Sale',
    text: 'You deleted your ticket listing for the following event:\nLantern Fest at The Greek Theatre',
  });
  const noEvent = mail({
    from: 'axs@axs.com',
    subject: 'Your tickets were delivered to your account!',
    text: 'YOUR TICKETS ARE HERE\nGood news – your tickets are in your account.',
  });

  const { outcomes, ignored } = readEmails([ordered, delivered, oldTransfer, wrongDay, resale, noEvent]);
  assert.equal(ignored, 2);
  const [o, d, t, w] = outcomes.map((x) => ('read' in x ? x.read : assert.fail(x.unreadable)));
  assert.deepEqual(
    [o.name.value, o.startDate?.value, o.venue?.value, o.city, o.orderId, o.total],
    ['Night Bloom', '2026-10-01', 'El Rey Theatre', undefined, '10000004', '$36.50'],
  );
  assert.equal(o.name.quote, 'Order details for Night Bloom - Artist Presale at El Rey Theatre scheduled on 10/1/2026 8:00 PM');
  assert.deepEqual(
    [d.name.value, d.startDate?.value, d.venue?.value, d.city?.value],
    ['Night Bloom', '2026-10-01', 'El Rey', 'Los Angeles, CA'],
  );
  assert.deepEqual(
    [t.name.value, t.startDate?.value, t.venue?.value, t.city?.value, t.tickets],
    ['Lantern Fest', '2023-09-22', 'The Greek Theatre', 'Los Angeles, CA', 2],
  );
  // The weekday does not fit the date: no date.
  assert.equal(w.startDate, undefined);

  // The order and the delivery are one show; the delivery adds the city.
  const rows = mergeImports([], readEmails([ordered, delivered]).outcomes, [], NOW);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].venue, rows[0].city, rows[0].messages.length], ['El Rey Theatre', 'Los Angeles, CA', 2]);
});

test('email: Front Gate receipts and tickets name the show in the body; one order is one show', () => {
  const receipt = (id: string, order: string, item: string, date: string) =>
    mail({
      id,
      from: 'Lights Out <order-support@frontgatetickets.com>',
      subject: `Your Insomniac Events Receipt - Order #${order}`,
      sentAt: '2025-03-12T18:00:00Z',
      text: `Order #${order}\nYour order with Insomniac Events has been successfully processed.\nShipping Address\nSam Lee\n${item}\n${date}\nat LA State Historic Park\n1245 North Spring Street\nLos Angeles, CA\n- 90012\nTicket\nGeneral Admission\n2\nTotal: $130.04`.replace(
        '\n\n',
        '\n',
      ),
    });
  const tickets = mail({
    from: 'order-support@frontgatetickets.com',
    subject: 'Your Insomniac Events Digital Tickets : Order #100000005',
    sentAt: '2025-06-26T18:00:00Z',
    text: 'Hey Sam,\nOrder #100000005\nOrder Details\nGarrix Live (Saturday)\nAges 18+ Only\nGeneral Admission (Tier 1)\nSaturday, June 28, 2025\nShow Time: 5:00PM\nLos Angeles State Historic Park\n1245 North Spring Street\nLos Angeles, CA 90012\n1 of 2\nGarrix Live (Saturday)\n2 of 2',
  });
  const first = receipt('r1', '100000006', 'Garrix Live - Second Show Added!', 'Saturday, June 28, 2025');
  const second = receipt('r2', '100000005', 'Garrix Live - Second Show Added!', 'Saturday, June 28, 2025');
  const undated = receipt('r3', '100000007', '2027 Desert Fest - Second Weekend Passes (May 21-23)', '');
  const reminder = mail({
    from: 'order-support@frontgatetickets.com',
    subject: 'Order Update: Your next layaway payment is upcoming',
    text: 'Your next automatic payment',
  });

  const { outcomes, ignored } = readEmails([first, second, tickets, undated, reminder]);
  assert.equal(ignored, 1);
  const read = outcomes.map((x) => ('read' in x ? x.read : assert.fail(x.unreadable)));
  assert.deepEqual(
    [read[0].name.value, read[0].startDate?.value, read[0].venue?.value, read[0].city?.value, read[0].orderId],
    ['Garrix Live - Second Show Added!', '2025-06-28', 'LA State Historic Park', 'Los Angeles, CA', '100000006'],
  );
  assert.deepEqual(
    [read[2].name.value, read[2].venue?.value, read[2].city?.value, read[2].tickets],
    ['Garrix Live (Saturday)', 'Los Angeles State Historic Park', 'Los Angeles, CA', 2],
  );
  // A pass sold before its dates were set: the show, no date.
  assert.deepEqual(
    [read[3].name.value, read[3].name.quote, read[3].startDate],
    ['2027 Desert Fest', '2027 Desert Fest - Second Weekend Passes (May 21-23)', undefined],
  );

  // The tickets name the show differently, but their order is already on the row.
  const rows = mergeImports([], outcomes, [], NOW);
  const garrix = rows.filter((r) => r.startDate === '2025-06-28');
  assert.equal(garrix.length, 1);
  assert.deepEqual(garrix[0].orderIds, ['100000006', '100000005']);
  assert.equal(garrix[0].messages.length, 3);
});

test('email imports: an email once unreadable leaves the review list when a reader learns its layout', () => {
  const old = mail({
    from: 'Eventbrite <orders@eventbrite.com>',
    subject: 'Your Tickets for Costume Party',
    sentAt: '2015-10-04T18:00:00Z',
    text: 'Something new',
  });
  const before = mergeImports([], readEmails([old]).outcomes, [], NOW);
  assert.equal(reviewList(before)[0].status, 'unreadable');
  const learned = {
    ...old,
    text: 'Hi Sam , this is your order confirmation for Costume Party\nAbout this event\nSaturday, October 17, 2015 at 9:30 PM\nRickshaw Stop\nSan Francisco, CA 94102',
  };
  const after = [...before, ...mergeImports(before, readEmails([learned]).outcomes, [], NOW)];
  assert.deepEqual(
    reviewList(after).map((r) => [r.status, r.name]),
    [['new', 'Costume Party']],
  );
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

test('email imports: a refund marks only the show it followed when the same name recurs', () => {
  const april = mail({ ...dice, id: 'dice-april', subject: 'Your tickets: MAURICE', sentAt: '2025-03-25T18:00:00Z', text: dice.text!.replace('Sat 17 Oct', 'Sat 05 Apr') });
  const refund = mail({ from: 'DICE <hello@dice.fm>', subject: 'Refund requested: MAURICE', sentAt: '2026-09-05T18:00:00Z', text: 'Your refund' });
  const rows = mergeImports([], readEmails([refund, april, dice]).outcomes, [], NOW);
  const byDate = Object.fromEntries(rows.filter((r) => r.status === 'new').map((r) => [r.startDate, r.flags]));
  assert.deepEqual(byDate, { '2025-04-05': [], '2026-10-17': ['refunded'] });
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
  const call = (route: string, body?: unknown, token?: string) =>
    dispatch(app, {
      method: body === undefined ? 'GET' : 'POST',
      url: `/api${route}`,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body,
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

test('import routes: nothing is saved until you tick it; future shows are added as upcoming; skips can be undone', async (t) => {
  const { store, call } = await server(t);
  process.env.IMPORT_TOKEN = 'right-token';
  t.after(() => delete process.env.IMPORT_TOKEN);
  await call('/imports/email', { emails: [ticketmaster, dice, ra] }, 'right-token');
  assert.deepEqual(await store.listEvents(), []);

  const { imports } = await (await call('/imports')).json();
  const id = (name: string) => imports.find((r: any) => r.name === name).id;

  const added = await (await call('/imports/add', { ids: [id('Porter Robinson'), id('Deep Space')] })).json();
  assert.deepEqual(added.events.map((e: any) => e.name), ['Porter Robinson', 'Deep Space']);
  // The show still ahead waits for you to say you went; the past one counts.
  assert.deepEqual(added.events.map((e: any) => e.attendance), [undefined, 'planned']);
  const events = await store.listEvents();
  assert.deepEqual(events.map((e) => e.name).sort(), ['Deep Space', 'Porter Robinson']);

  // Adding again does not duplicate it.
  assert.deepEqual((await (await call('/imports/add', { ids: [id('Porter Robinson')] })).json()).events, []);

  const skipped = await (await call('/imports/skip', { ids: [id('MAURICE')] })).json();
  assert.equal(skipped.imports[0].status, 'skipped');
  const restored = await (await call('/imports/skip', { ids: [id('MAURICE')], restore: true })).json();
  assert.equal(restored.imports[0].status, 'new');
  assert.equal((await store.listEvents()).length, 2);
});

test('email: a name wrapped by a newline in the HTML source stays one line', () => {
  assert.deepEqual(htmlToLines('<table><tr><td><span>Velvet</span>\n  <span>Tide</span></td></tr><tr><td>The Echo</td></tr></table>'), ['Velvet Tide', 'The Echo']);
});
