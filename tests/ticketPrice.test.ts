import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GmailApi, GmailMessage } from '../src/server/events/email/gmail.ts';
import { eventFromImport, mergeImports, pricesFromImports, readEmails, ticketPriceOf } from '../src/server/events/email/imports.ts';
import { GMAIL_SETTING, SCAN_SETTING, ScanSetting, scanStep } from '../src/server/events/email/scan.ts';
import { EmailImport, RawEmail, ReadEmail } from '../src/server/events/email/types.ts';
import { applyPatch } from '../src/server/events/service.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';

// Synthetic emails in each seller's layout: made-up orders, no real mail.

const NOW = new Date('2026-10-20T12:00:00Z');
const read = (email: RawEmail): ReadEmail => (readEmails([email]).outcomes[0] as any).read;
const order = (over: Partial<ReadEmail>): ReadEmail => ({ kind: 'order', name: { value: 'Show', quote: 'Show' }, ...over });

test('ticket price: an email total in dollars over its ticket count, quoted', () => {
  assert.deepEqual(ticketPriceOf(order({ total: '$29.90', tickets: 2 })), { value: 14.95, quote: '$29.90 for 2 tickets' });
  assert.deepEqual(ticketPriceOf(order({ total: '$1,759.96', tickets: 3 })), { value: 586.65, quote: '$1,759.96 for 3 tickets' });
  assert.deepEqual(ticketPriceOf(order({ total: 'FREE', tickets: 1 })), { value: 0, quote: 'FREE for 1 ticket' });
  // No count, or a currency the price cannot say: nothing.
  assert.equal(ticketPriceOf(order({ total: '$42.50' })), undefined);
  assert.equal(ticketPriceOf(order({ total: '€336.14', tickets: 2 })), undefined);
});

test('ticket price: totals on the line after their label, and counts from seats and order tables', () => {
  const tixr = read({
    id: 't',
    from: 'Tixr <no-reply@tixr.com>',
    subject: 'Order Confirmation: Sunset Social',
    sentAt: '2026-03-17T18:00:00Z',
    text: 'Order Confirmation\nSunset Social\nThe Midway\nSat Jun 20, 10:00 PM\n2 Items\nTicket Info\n$ 97.08\n2x\nGA\nProcessing Fees:\n+ $ 22.90\nTotal Including Fees:\n$ 119.98',
  });
  assert.deepEqual([tixr.total, tixr.tickets], ['$119.98', 2]);

  const ticketmaster = read({
    id: 'tm',
    from: 'Ticketmaster <customer_support@email.ticketmaster.com>',
    subject: 'You Got Tickets To Robyn',
    sentAt: '2022-03-09T03:00:00Z',
    text: 'Robyn\nSat · Sep 10, 2022 · 8:00 PM\nThe Forum — Inglewood, CA\nSec 141, Row R, Seat 5 - 8\nOrder # 12-34567/LA\nTotal: $400.00',
  });
  assert.deepEqual([ticketmaster.total, ticketmaster.tickets], ['$400.00', 4]);

  const receipt = (items: string) =>
    read({
      id: 'fg',
      from: 'Front Gate Tickets <order-support@frontgatetickets.com>',
      subject: 'Your Insomniac Events Receipt - Order #172000001',
      sentAt: '2026-02-05T00:00:00Z',
      text: `Night Owl Park Party\nSaturday, March 21, 2026\nat Grand Park LA\n200 N Grand Ave\nLos Angeles, CA\n${items}\nTotal:\n$130.26`,
    });
  const one = receipt('Ticket\nQuantity\nPrice\nGeneral Admission (Tier 1)\n2\n$130.26\nEvent Subtotal: $130.26');
  assert.deepEqual([one.total, one.tickets], ['$130.26', 2]);
  // A shuttle, or a pass with add-ons, says nothing about one ticket.
  const shuttle = receipt('Ticket\nQuantity\nPrice\nTropicana: Depart: 8:30PM / Return: 3AM\n1\n$239.00\nEvent Subtotal: $259.00');
  assert.deepEqual([shuttle.total, shuttle.tickets], [undefined, undefined]);
  const addOn = receipt('Quantity\nPrice\n3-Day GA\n4\n$1396.00\nEvent Subtotal: $1759.96\nQuantity\nPrice\nMagnet\n4\n$0.00\nEvent Subtotal: $0.00');
  assert.deepEqual([addOn.total, addOn.tickets], [undefined, undefined]);

  const axs = read({
    id: 'axs',
    from: 'AXS <guestservices@axs.com>',
    subject: 'Thank you for your order for Starjunk 95',
    sentAt: '2026-01-16T18:00:00Z',
    text: 'Your confirmation number is 22734053 .\nOrder details for Starjunk 95 at Fonda Theatre scheduled on 5/2/2026 9:00 PM\nQuantity\nType\nSection\nRow\nSeats\nPrice\nTotal\n2\nRegular\nGA Floor 1\n$25.00\n$50.00\nMethod of Delivery: AXS Mobile ID\nSub Total:\n$50.00\nService Fees:\n$23.52\nGrand Total:\n$73.52',
  });
  assert.deepEqual([axs.total, axs.tickets], ['$73.52', 2]);
});

const row = (over: Partial<EmailImport>): EmailImport => ({
  id: 'r1',
  key: 'show|2026-05-01',
  status: 'added',
  seller: 'DICE',
  name: 'Show',
  startDate: '2026-05-01',
  sources: { ticketPrice: { messageId: 'm1', link: 'https://mail.example/m1', quote: '$40.00 for 2 tickets' } },
  messages: [],
  flags: [],
  ticketPrice: 20,
  eventId: 'e1',
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  ...over,
});

test('ticket price: an imported show carries it; an event without one takes it; yours is never replaced', () => {
  const event = eventFromImport(row({ status: 'new', eventId: undefined }), NOW);
  assert.equal(event.ticketPrice, 20);
  assert.deepEqual(event.sources.ticketPrice, { sourceType: 'email', sourceUrl: 'https://mail.example/m1', quote: '$40.00 for 2 tickets' });
  assert.equal(event.rating, undefined);

  const typed = { ...event, id: 'e1', ticketPrice: undefined, sources: {} };
  const [priced] = pricesFromImports([row({})], [typed], NOW);
  assert.equal(priced.ticketPrice, 20);
  assert.equal(priced.sources.ticketPrice?.sourceType, 'email');

  // A price you typed, or one you cleared, stays yours.
  assert.deepEqual(pricesFromImports([row({})], [{ ...typed, ticketPrice: 35 }], NOW), []);
  const cleared = applyPatch(priced, { ticketPrice: null }, NOW);
  assert.equal(cleared.ticketPrice, undefined);
  assert.deepEqual(pricesFromImports([row({})], [cleared], NOW), []);
  // Rows you left out give nothing.
  assert.deepEqual(pricesFromImports([row({ status: 'skipped' })], [typed], NOW), []);
});

test('ticket price: Check email reads orders already on the list once more for their price, then stops', async () => {
  const store = new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'price-')));
  await store.putSetting(GMAIL_SETTING, { refreshToken: 'refresh-1', connectedAt: NOW.toISOString() });
  const mail: GmailMessage = {
    id: 'd1',
    link: 'https://mail.google.com/mail/?authuser=0#all/d1',
    from: 'DICE <hello@dice.fm>',
    subject: 'Your tickets: MAURICE',
    sentAt: '2026-09-01T10:00:00Z',
    receivedAt: Date.parse('2026-09-01T10:00:00Z'),
    text: 'Venue details\nVenue\nLos Globos\n3040 Sunset Blvd, Los Angeles, CA 90026, USA\nDate & time\nSat 17 Oct,10:00 PM GMT-7\nTickets\n2 x General Admission\nTotal\n$40.00',
  };
  // Imported and added before prices were read.
  const [old] = mergeImports([], readEmails([mail]).outcomes, [], NOW);
  const event = eventFromImport(old, NOW);
  delete old.ticketPrice;
  delete old.sources.ticketPrice;
  await store.putImports([{ ...old, status: 'added', eventId: event.id }]);
  await store.putEvents([{ ...event, ticketPrice: undefined, sources: { startDate: event.sources.startDate } }]);
  await store.putSetting<ScanSetting>(SCAN_SETTING, { scannedThrough: mail.sentAt, recent: { d1: mail.sentAt }, sellers: {}, forwards: { recent: {} } });

  const reads: string[] = [];
  const gmail: GmailApi = {
    authUrl: () => '',
    connect: async () => ({ refreshToken: 'refresh-1' }),
    listIds: async () => [],
    getMessage: async (_token, id) => {
      reads.push(id);
      return mail;
    },
  };
  const step = await scanStep(store, gmail, NOW);
  assert.deepEqual([step.read, step.remaining], [1, 0]);
  const [saved] = await store.listEvents();
  assert.equal(saved.ticketPrice, 20);
  assert.equal(saved.sources.ticketPrice?.quote, '$40.00 for 2 tickets');
  assert.equal((await store.listImports())[0].ticketPrice, 20);

  await scanStep(store, gmail, NOW);
  assert.deepEqual(reads, ['d1']); // not read a third time
  assert.equal((await store.getSetting<ScanSetting>(SCAN_SETTING))!.prices?.done, true);
});
