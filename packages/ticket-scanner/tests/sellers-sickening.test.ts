import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRawEmails } from '../src/scan.ts';
import type { RawEmailMessage } from '../src/types.ts';

// Synthetic mail shaped like the 2026 layout. No real names, venues or orders.
const raw = (subject: string, dateLine: string, title: string, id = subject): RawEmailMessage => ({
  id,
  link: `https://mail.google.com/mail/u/0/#all/${id}`,
  from: 'Sickening Events <noreply@sickening.events>',
  subject,
  sentAt: '2026-08-16T19:24:02.000Z',
  text: '',
  html: [
    '<table><tr><td>Your tickets are ready!</td></tr>',
    `<tr><td><span>${dateLine}</span></td></tr>`,
    `<tr><td><a href="https://example.com/event">${title}</a></td></tr>`,
    '<tr><td>View Details</td></tr>',
    '<tr><td>Order ID</td></tr>',
    '<tr><td id="order-id">00000000-0000-0000-0000-000000000000</td></tr></table>',
  ].join('\n'),
});

test('Sickening.events: the 2026 date line and event title are read; no venue is invented', () => {
  const [p] = readRawEmails([
    raw('Ticket: Example Night', 'Oct  3, 2026 at 10:00 PM to Oct  4, 2026', 'Example Night'),
  ]);
  assert.equal(p.status, 'new');
  assert.equal(p.name?.value, 'Example Night');
  assert.equal(p.date?.value, '2026-10-03');
  assert.equal(p.venue, undefined);
  assert.equal(p.city, undefined);
});

test('Sickening.events: an order confirmation with the same card is read', () => {
  const [p] = readRawEmails([
    raw('Order Confirmation: Example Night', 'Oct  3, 2026 at 10:00 PM to Oct  4, 2026', 'Example Night'),
  ]);
  assert.equal(p.status, 'new');
  assert.equal(p.name?.value, 'Example Night');
  assert.equal(p.date?.value, '2026-10-03');
});

test('Sickening.events: a card with no date line is unreadable, not guessed', () => {
  const [p] = readRawEmails([
    raw('Ticket: Example Night', 'Doors open soon', 'Example Night'),
  ]);
  assert.equal(p.status, 'unreadable');
  assert.equal(p.date, undefined);
});

test('Sickening.events: complimentary ticket mail has no order card and is not read as a show', () => {
  const rows = readRawEmails([
    raw('Complimentary Ticket: Example Night', 'Oct  3, 2026 at 10:00 PM to Oct  4, 2026', 'Example Night'),
  ]);
  assert.equal(rows.length, 0);
});
