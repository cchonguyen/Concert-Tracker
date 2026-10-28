import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRawEmails } from '../src/scan.ts';
import type { RawEmailMessage } from '../src/types.ts';

const mail = (subject: string, text: string, from = 'Ticketmaster <customer_support@email.ticketmaster.com>'): RawEmailMessage => ({
  id: subject,
  link: 'https://mail.google.com/mail/u/0/#all/x',
  from,
  subject,
  sentAt: '2022-03-09T12:00:00.000Z',
  text,
});

test('a Ticketmaster parking pass is not a proposal', () => {
  const out = readRawEmails([
    mail('You Got Tickets To Dodger Stadium Parking', ['Dodger Stadium Parking', 'Sat, Sep 10, 2022', 'Dodger Stadium — Los Angeles, CA', 'Order #123456'].join('\n')),
  ]);
  assert.equal(out.length, 0);
});

test('a show with no readable day is never a new proposal', () => {
  const out = readRawEmails([
    mail('You Got Tickets To Midnight Kids', ['Midnight Kids', 'Order #987654', 'Total: $20.00'].join('\n')),
  ]);
  assert.ok(out.every((p) => p.status !== 'new'));
});
