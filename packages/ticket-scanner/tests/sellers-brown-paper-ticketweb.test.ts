import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRawEmails } from '../src/scan.ts';
import type { RawEmailMessage } from '../src/types.ts';

// Synthetic mail shaped like the real layouts. No real names, venues or orders.
const raw = (from: string, subject: string, text: string, id = subject): RawEmailMessage => ({
  id,
  link: `https://mail.google.com/mail/u/0/#all/${id}`,
  from,
  subject,
  sentAt: '2025-05-07T12:00:00.000Z',
  text,
});

const bpt = (event: string, start: string, count: number) =>
  raw(
    'Brown Paper Tickets <noreply-bpt@brownpapertickets.com>',
    '[Brown Paper Tickets] Order Confirmation',
    [
      'Confirmation Number: 12345678',
      'Tickets Purchased: ' + count,
      'Amount Paid: Free',
      '',
      '2. Ticket Details',
      `Ticket 1 (#A000000001)`,
      `Event: ${event}`,
      `Start Date: ${start}`,
      'Ticket Price: Free (General)',
    ].join('\n'),
    event,
  );

test('Brown Paper Tickets: event, start date and ticket count are read', () => {
  const [p] = readRawEmails([bpt('Example Night Market', 'Sun Mar 03, 2024 5:00 PM', 2)]);
  assert.equal(p.status, 'new');
  assert.equal(p.name?.value, 'Example Night Market');
  assert.equal(p.date?.value, '2024-03-03');
  assert.equal(p.orderNumber, '12345678');
});

test('TicketWeb: an act name that wraps onto a second line is read whole', () => {
  const text = [
    'Thank you for your purchase, Charlie!',
    'Order Number:   ABC123XYZ',
    'ORDER SUMMARY',
    'Lost in Dreams ft.',
    'Secret Lineup',
    'Fri May 9, 2025',
    '10:00 PM (Doors @ 10:00 PM)',
    'Bloom',
    'Suite 100 - 919 Fourth Ave',
    'San Diego, CA 92101',
    'Venue Directions',
    '2    Advanced Tickets $0.00',
    'DELIVERY TYPE: TicketFast',
  ].join('\n');
  const [p] = readRawEmails([raw('TicketWeb <info@ticketweb.com>', "Confirmed - you're going to Secret Lineup!", text)]);
  assert.equal(p.status, 'new');
  assert.equal(p.name?.value, 'Lost in Dreams ft. Secret Lineup');
  assert.equal(p.date?.value, '2025-05-09');
  assert.equal(p.venue?.value, 'Bloom');
  assert.equal(p.city?.value, 'San Diego, CA');
});
