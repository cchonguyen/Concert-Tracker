import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeImports, readEmails } from '../src/server/events/email/imports.ts';
import { RawEmail } from '../src/server/events/email/types.ts';

// Synthetic emails in Live Nation's and TicketWeb's layouts: made-up
// orders, no real mail.

const NOW = new Date('2026-10-20T12:00:00Z');

const mail = (over: Partial<RawEmail> & Pick<RawEmail, 'from' | 'subject' | 'text'>): RawEmail => ({
  id: over.subject,
  sentAt: '2024-06-01T18:00:00Z',
  ...over,
});
const read = (email: RawEmail) => (readEmails([email]).outcomes[0] as any)?.read;
const values = (r: any) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v && typeof v === 'object' ? (v as any).value : v]));

const LN = 'Live Nation <customer_support@replyto.livenation.com>';
const TW = 'TicketWeb Orders <info@ticketweb.com>';

test('Live Nation: the order card, in the 2019 and current date styles', () => {
  const now = read(
    mail({
      from: LN,
      subject: 'You Just Scored Tickets to Porter Robinson',
      sentAt: '2024-07-16T18:00:00Z',
      text: 'You Got the Tickets!\nOrder # 12-34567/LA1\nPorter Robinson\nSat · Dec 07, 2024 · 8:00 PM\nHollywood Palladium — Hollywood, California\nTotal: $83.50',
    }),
  );
  assert.deepEqual(values(now), {
    kind: 'order',
    name: 'Porter Robinson',
    startDate: '2024-12-07',
    endDate: undefined,
    venue: 'Hollywood Palladium',
    city: 'Hollywood, CA',
    orderId: '12-34567/LA1',
    total: '$83.50',
  });
  const old = read(
    mail({
      from: LN,
      subject: 'You Just Scored Tickets to Robyn',
      sentAt: '2019-02-20T18:00:00Z',
      text: 'Order # 28-11111/NCA\nRobyn\nSat • Oct 05 2019 • 8:00 PM\nThe Masonic — San Francisco, CA\nTotal: $99.00',
    }),
  );
  assert.equal(old.startDate.value, '2019-10-05');
  assert.equal(old.venue.value, 'The Masonic');
});

test('Live Nation: the mobile-tickets email gives the event, its date without a year, the venue and city', () => {
  const r = read(
    mail({
      from: LN,
      subject: 'View your mobile tickets for your upcoming event',
      sentAt: '2023-02-25T15:00:00Z',
      text: 'Robyn - Honey Tour with Special Guest Kindness\nFri, Mar 03 @ The Wiltern, Los Angeles, CA\nView Your Tickets',
    }),
  );
  assert.equal(r.name.value, 'Robyn - Honey Tour with Special Guest Kindness');
  assert.deepEqual(r.startDate, { value: '2023-03-03', quote: 'Fri, Mar 03' });
  assert.deepEqual(r.venue, { value: 'The Wiltern', quote: 'Fri, Mar 03 @ The Wiltern, Los Angeles, CA' });
  assert.equal(r.city.value, 'Los Angeles, CA');
});

test('Live Nation: ads from the same domain are not read', () => {
  const ad = mail({ from: 'Live Nation <noreply@email.livenation.com>', subject: 'Concert Week is here', text: '$25 tickets' });
  assert.deepEqual(readEmails([ad]), { outcomes: [], ignored: 1 });
});

const confirmation = (subject: string, presents = '') =>
  mail({
    from: TW,
    subject,
    sentAt: '2025-04-29T17:00:00Z',
    text: `Thank you for your purchase!\nOrder Number: MTEST1234\nDate of Purchase: Tue Apr 29, 2025\nALL SALES ARE FINAL.\nORDER SUMMARY\n${presents}Night Shift\nThu Jun 12, 2025\nDoors @ 10:00 PM\n(Time displayed is local to the venue)\nAGE: 21 +\nExchange LA\n618 S. Spring Street\nLos Angeles, CA 90014\nVenue Directions\n2 Advance Tickets - Early Bird $10 $10.00\n$20.00\nDELIVERY TYPE: TicketFast\nPaid with:\nSubtotal\nService Fee\nDelivery Fee\nTotal Payment\n$ 20.00\n$ 9.90\n$ 0.00\n$ 29.90`,
  });

test('TicketWeb: the confirmation, in the current and pre-2025 subjects, with or without a promoter line', () => {
  for (const email of [
    confirmation("Confirmed - you're going to Night Shift!", 'Insomniac presents\n'),
    confirmation('Your TicketWeb Order Confirmation for Order# MTEST1234 (THIS IS NOT YOUR TICKET)'),
  ]) {
    assert.deepEqual(values(read(email)), {
      kind: 'order',
      name: 'Night Shift',
      startDate: '2025-06-12',
      endDate: undefined,
      venue: 'Exchange LA',
      city: 'Los Angeles, CA',
      orderId: 'MTEST1234',
      tickets: 2,
      total: '$29.90',
    });
  }
});

const delivery = mail({
  from: TW,
  subject: "Your tickets are here! You're going to Night Shift: K-Pop Edition!",
  sentAt: '2025-06-10T05:00:00Z',
  text: 'YOU HAVE 2 TICKET(S)\nATTACHED TO THIS EMAIL\nOrder Confirmation Number: MTEST1234\nEvent Details:\nNight Shift: K-Pop Edition\nExchange LA\n618 S. Spring Street, Los Angeles, CA\nThu Jun 12, 2025 at 10:00 PM\nView Tickets',
});

test('TicketWeb: the tickets email, and it joins its confirmation by order number', () => {
  const r = read(delivery);
  assert.equal(r.name.value, 'Night Shift: K-Pop Edition');
  assert.equal(r.startDate.value, '2025-06-12');
  assert.equal(r.venue.value, 'Exchange LA');
  assert.deepEqual(r.city, { value: 'Los Angeles, CA', quote: '618 S. Spring Street, Los Angeles, CA' });
  assert.equal(r.orderId, 'MTEST1234');
  assert.equal(r.tickets, 2);

  const rows = mergeImports([], readEmails([confirmation("Confirmed - you're going to Night Shift!"), delivery]).outcomes, [], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Night Shift');
  assert.equal(rows[0].messages.length, 2);
});

test('TicketWeb: reminders, event updates and changed-event notices are not read', () => {
  const emails = [
    'Event Reminder: Night Shift is coming up in 2 days! (THIS IS NOT YOUR TICKET)',
    'Event Update: Night Shift at Exchange LA on Thu Jun 12, 2025 at 10:00 PM',
    'IMPORTANT - Your upcoming event at Exchange LA has changed',
  ].map((subject) => mail({ from: TW, subject, text: 'Event Details:\nNight Shift' }));
  assert.deepEqual(readEmails(emails), { outcomes: [], ignored: 3 });
});
