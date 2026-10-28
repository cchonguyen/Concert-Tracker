import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRawEmails } from '../src/scan.ts';

// Synthetic 2019-on order card, HTML only: the date sits under the event name
// and the venue under the date. No real names or orders.
const html = `<html><body>
<p>Charlie, you've got tickets!</p>
<h2>Example Brewery Night</h2>
<p>2 x Tickets</p>
<p>Order total: $24.48</p>
<p>Friday, November 5, 2021 from 5:00 PM to 10:00 PM (PDT)</p>
<p>Add to</p>
<p>Google</p>
<p>Example Brewing</p>
<p>123 Example St, Sample City, CA 94600</p>
<p>Order: #1234567890</p>
</body></html>`;

test('Eventbrite: a 2019-on order card in HTML is read with its date, venue and city', () => {
  const [p] = readRawEmails([
    {
      id: 'eb-card',
      link: 'https://mail.google.com/mail/u/0/#all/eb-card',
      from: 'Eventbrite <noreply@order.eventbrite.com>',
      subject: 'Your Tickets for Example Brewery Night',
      sentAt: '2021-10-28T01:00:00.000Z',
      html,
    },
  ]);
  assert.equal(p.status, 'new');
  assert.equal(p.name?.value, 'Example Brewery Night');
  assert.equal(p.date?.value, '2021-11-05');
  assert.equal(p.venue?.value, 'Example Brewing');
  assert.equal(p.city?.value, 'Sample City, CA');
});

test('Eventbrite: a shuttle sold for a show is not a proposal', () => {
  const out = readRawEmails([
    {
      id: 'eb-shuttle',
      link: 'https://mail.google.com/mail/u/0/#all/eb-shuttle',
      from: 'Eventbrite <noreply@order.eventbrite.com>',
      subject: 'Order Confirmation for Shuttles to Example Venue - 10/21/2022 - Example Act',
      sentAt: '2022-10-20T01:00:00.000Z',
      text: 'Order: #1234567890\nTotal: $20.00',
    },
  ]);
  assert.equal(out.length, 0);
});
