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

// Synthetic 2013 card: the date is under "About this event", and the venue and
// its address are one line split by <BR>.
test('Eventbrite: a 2013 card with <BR>-packed venue and address is read', () => {
  const [p] = readRawEmails([
    {
      id: 'eb-2013',
      link: 'https://mail.google.com/mail/u/0/#all/eb-2013',
      from: 'Eventbrite <orders@eventbrite.com>',
      subject: 'Your Tickets for Example Party',
      sentAt: '2013-11-10T04:30:21Z',
      text: [
        'Hi Charlie, this is your order confirmation for',
        'Example Party',
        'Order Summary',
        'Order #: 111222333',
        'About this event',
        'Saturday, November 9, 2013 at 10:00 PM - Sunday, November 10, 2013 at 6:00 AM (PST)',
        'The Example Hall<BR>401 Sample Street<BR>San Francisco, CA 94708',
      ].join('\n'),
    },
  ]);
  assert.equal(p.status, 'new');
  assert.equal(p.date?.value, '2013-11-09');
  assert.equal(p.venue?.value, 'The Example Hall');
  assert.equal(p.city?.value, 'San Francisco, CA');
});
