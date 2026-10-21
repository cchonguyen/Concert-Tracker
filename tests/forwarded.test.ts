import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrapForward } from '../src/server/events/email/forwarded.ts';
import { readEmails } from '../src/server/events/email/imports.ts';
import { emailLines } from '../src/server/events/email/text.ts';
import { RawEmail } from '../src/server/events/email/types.ts';

// Shapes copied from real forwards: Gmail's header in a gmail_quote div,
// iPhone Mail's in a cite blockquote with bold names.
const tixrBody = `<div>Order Confirmation</div><div>Zedd Pride Weekend Block Party</div><div>The Midway</div>
  <div>Sun Jun 28, 2:00 PM</div><div>2 Items</div><div>Order ID:</div><div>998877</div><div>Total Including Fees: $88.00</div>`;

const gmailForward = (from: string, date: string, subject: string, body: string) =>
  `<div dir="ltr"><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername" dir="auto">${from.split('<')[0].trim()}</strong> <span dir="auto">&lt;${from.match(/<(.+)>/)![1]}&gt;</span><br>Date: ${date}<br>Subject: ${subject}<br>To: &lt;justin@example.com&gt;<br></div><br><br>${body}</div></div>`;

const forward = (over: Partial<RawEmail>): RawEmail => ({
  id: 'fwd-1',
  link: 'https://mail.google.com/mail/?authuser=0#all/fwd-1',
  from: 'Justin <justin@example.com>',
  subject: 'Fwd: Order Confirmation: Zedd Pride Weekend Block Party',
  sentAt: '2026-02-28T23:52:45Z',
  ...over,
});

test('forwards: a Gmail forward is read by the original seller, dated from the original', () => {
  const email = forward({ html: gmailForward('Tixr <no-reply@tixr.com>', 'Tue, Feb 17, 2026 at 10:27 AM', 'Order Confirmation: Zedd Pride Weekend Block Party', tixrBody) });
  const fwd = unwrapForward(email, emailLines(email))!;
  assert.equal(fwd.email.from, 'Tixr <no-reply@tixr.com>');
  assert.equal(fwd.email.subject, 'Order Confirmation: Zedd Pride Weekend Block Party');
  assert.equal(fwd.email.sentAt, '2026-02-17T12:00:00.000Z');
  assert.equal(fwd.email.id, 'fwd-1');
  assert.equal(fwd.lines[0], 'Order Confirmation');

  const [out] = readEmails([email]).outcomes as any[];
  assert.equal(out.seller, 'Tixr');
  assert.equal(out.read.name.value, 'Zedd Pride Weekend Block Party');
  assert.equal(out.read.startDate.value, '2026-06-28');
  assert.equal(out.read.venue.value, 'The Midway');
  assert.equal(out.email.link, email.link); // the review row opens the forward you received
});

test('forwards: iPhone Mail and a forward of a forward use the innermost header', () => {
  const iphone = forward({
    html: `<div>Sent from my iPhone</div><div><br><blockquote type="cite">Begin forwarded message:<br><br></blockquote></div>
      <blockquote type="cite"><div><b>From:</b> Tien &lt;tien@example.com&gt;<br><b>Date:</b> February 7, 2026 at 4:11:00 PM PST<br><b>To:</b> justin@example.com<br><b>Subject:</b> Fwd: Order Confirmation: Zedd Pride Weekend Block Party<br></div></blockquote>
      <div>---------- Forwarded message ---------<br>From: Tixr &lt;no-reply@tixr.com&gt;<br>Date: Tue, Feb 3, 2026, 3:52 PM<br>Subject: Order Confirmation: Zedd Pride Weekend Block Party<br>To: &lt;tien@example.com&gt;<br></div>${tixrBody}`,
  });
  const fwd = unwrapForward(iphone, emailLines(iphone))!;
  assert.equal(fwd.email.from, 'Tixr <no-reply@tixr.com>');
  assert.equal(fwd.email.sentAt, '2026-02-03T12:00:00.000Z');
  assert.equal((readEmails([iphone]).outcomes[0] as any).read.startDate.value, '2026-06-28');
});

test('forwards: no readable Date line means the forward is listed as unreadable, not dated from when it was forwarded', () => {
  const email = forward({ html: gmailForward('Tixr <no-reply@tixr.com>', 'sometime', 'Order Confirmation: Zedd Pride Weekend Block Party', tixrBody) });
  const [out] = readEmails([email]).outcomes as any[];
  assert.equal(out.seller, 'Tixr');
  assert.match(out.unreadable, /when the original was sent/);
});

test('forwards: personal mail and forwards from sellers without a reader are ignored', () => {
  const chat = forward({ subject: 'dinner?', text: 'are we still on for tonight' });
  const ticketweb = forward({
    subject: 'Fwd: Your TicketWeb Tickets Have Arrived!',
    html: gmailForward('TicketWeb Orders <info@ticketweb.com>', 'Wed, Sep 4, 2024 at 10:02 PM', 'Your TicketWeb Tickets Have Arrived!', '<div>Event Details:</div>'),
  });
  assert.deepEqual(readEmails([chat, ticketweb]), { outcomes: [], ignored: 2 });
});

test('AXS box office: the date line under the event is read when there is one', () => {
  const email: RawEmail = {
    id: 'axs-1',
    from: '<guestservices@boxoffice.axs.com>',
    subject: 'Thank you for your order for Dom Dolla',
    sentAt: '2024-06-05T19:55:00Z',
    text: 'ORDER CONFIRMATION\nThanks for your order - your confirmation number is\n#1000008 .\nTICKET DETAILS\nDom Dolla 2024 - 2nd Show Added\nSaturday, October 19, 2024 4:00 PM\nItem\nOrder Total:\n$282.00',
  };
  const read = (readEmails([email]).outcomes[0] as any).read;
  assert.equal(read.name.value, 'Dom Dolla 2024 - 2nd Show Added');
  assert.deepEqual(read.startDate, { value: '2024-10-19', quote: 'Saturday, October 19, 2024' });
});
