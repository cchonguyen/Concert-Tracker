import { deflateRawSync } from 'node:zlib';
import type { RawEmailMessage } from '../../src/types.ts';

// The 100-message synthetic golden corpus, built in code. Every show, venue,
// person and order number is made up. Each seller's layout follows the
// readers' own reference samples; noise (messy nested tables, inline styles,
// &nbsp;, split markup inside names, forward headers, add-on fees) is layered
// on top so the harness checks the readers against production-shaped mail.
//
// This is an invariant and regression harness, not an inbox benchmark: the
// layouts were written by the same hands as the readers, so passing it says
// the readers keep working on these shapes, not what share of a real inbox
// they catch.

export type Group = 'tier1' | 'boutique' | 'forwarded' | 'longtail' | 'trap';

export interface Expect {
  name: string;
  date: string;
  venue?: string;
  city?: string;
  price?: number | null; // null: no per-ticket price may be claimed
}

export interface Fixture {
  label: string;
  group: Group;
  email: RawEmailMessage;
  expect: Expect | null; // null: a trap, which must produce nothing
}

// ---- made-up shows -------------------------------------------------------

const ACTS = [
  'Velvet Tide', 'Moon Garden', 'Glass Harbor', 'Nightjar Collective', 'Saint Ember', 'Paper Comets', 'Low Orbit',
  'Hollow Pines', 'Neon Fable', 'Quiet Atlas', 'Copper Lanterns', 'Wild Meridian', 'Dusk Parade', 'Silver Vale',
  'Echo Ritual', 'Coral Static', 'Tidewater Kids', 'Lunar Arcade', 'Brass Monsoon', 'Fern & Fable', 'Kite Theory',
  'Opal Season', 'Static Bloom', 'North Satellite', 'Golden Hours Club', 'Midnight Orchard', 'Blue Fathom',
  'Harbor Lights Revue', 'Cinder Youth', 'Polar Garden',
];
const VENUES: Array<[venue: string, street: string, city: string, st: string, zip: string]> = [
  ['The Lantern Room', '1822 Sunset Blvd', 'Los Angeles', 'CA', '90026'],
  ['Harbor Hall', '628 Divisadero St', 'San Francisco', 'CA', '94117'],
  ['The Copper Door', '401 6th St', 'San Francisco', 'CA', '94103'],
  ['Mercury Ballroom', '618 S. Spring Street', 'Los Angeles', 'CA', '90014'],
  ['Union Pavilion', '2700 N Vermont Ave', 'Los Angeles', 'CA', '90027'],
  ['Northside Theatre', '1300 Main St', 'Seattle', 'WA', '98101'],
  ['The Velvet Attic', '55 Bedford Ave', 'Brooklyn', 'NY', '11211'],
  ['Granite Hall', '410 E 6th St', 'Austin', 'TX', '78701'],
  ['Lakeside Amphitheatre', '900 Lake Shore Dr', 'Chicago', 'IL', '60611'],
  ['The Foundry', '2100 Larimer St', 'Denver', 'CO', '80205'],
];

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface Show {
  i: number;
  name: string;
  venue: string;
  street: string;
  city: string;
  st: string;
  zip: string;
  date: string; // YYYY-MM-DD
  sentAt: string;
  y: number;
  m: number; // 0-11
  d: number;
  w: number; // weekday
  order: string;
  total: number;
  qty: number;
}

const DAY = 864e5;
function show(i: number, year: number): Show {
  const [venue, street, city, st, zip] = VENUES[i % VENUES.length];
  const start = Date.UTC(year, (i * 5) % 12, 1 + ((i * 7) % 27));
  const dt = new Date(start);
  const qty = 1 + (i % 3);
  return {
    i,
    name: ACTS[i % ACTS.length],
    venue, street, city, st, zip,
    date: dt.toISOString().slice(0, 10),
    sentAt: new Date(start - (20 + (i % 40)) * DAY).toISOString(),
    y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate(), w: dt.getUTCDay(),
    order: `${100000 + i * 7919}`,
    total: qty * (25 + (i % 6) * 10),
    qty,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const usd = (n: number) => `$${n.toFixed(2)}`;
const link = (id: string) => `https://mail.google.com/mail/u/0/#all/${id}`;

function mail(id: string, s: Show, over: Partial<RawEmailMessage> & Pick<RawEmailMessage, 'from' | 'subject'>): RawEmailMessage {
  return { id, link: link(id), sentAt: s.sentAt, ...over };
}

// ---- noise ---------------------------------------------------------------

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const STYLES = [
  'font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#222222;line-height:20px',
  'padding:0 24px 8px 24px;mso-line-height-rule:exactly;text-align:left',
  'font-size:13px;color:#6b6b6b;letter-spacing:.2px',
];

// One visible line per cell, inside two to four levels of layout tables with
// inline styles, spacer cells and a hidden preheader. Odd rows use &nbsp;
// between words; some names arrive split across inline spans or wrapped by
// newlines in the source, which a mail client shows as one line.
function messyHtml(rows: string[], seed: number): string {
  const depth = 2 + (seed % 3);
  const cell = (r: string, k: number) => {
    let t = esc(r);
    if ((k + seed) % 3 === 0) t = t.replace(/ /g, '&nbsp;');
    if ((k + seed) % 5 === 1 && t.includes(' ')) t = t.replace(' ', '</span>\n      <span style="font-weight:bold"> ').replace(/^/, '<span>') + '</span>';
    return `<tr><td style="${STYLES[(k + seed) % STYLES.length]}" class="mobile-pad">${t}</td></tr><tr><td height="8" style="font-size:0;line-height:0">&#8203;</td></tr>`;
  };
  let inner = rows.map(cell).join('\n');
  for (let i = 0; i < depth; i++) inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${STYLES[i % 3]}"><tbody>${inner}</tbody></table>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Order</title><style>@media only screen and (max-width:480px){.mobile-pad{padding:0 12px!important}}</style></head><body style="margin:0;padding:0"><div style="display:none;max-height:0;overflow:hidden">Your order is confirmed&zwnj;&nbsp;&zwnj;&nbsp;</div><!-- tracking pixel --><img src="https://t.example/o.gif" width="1" height="1" alt="">${inner}</body></html>`;
}

// HTML for most messages, plain text for every fourth, as Gmail hands over.
const body = (rows: string[], s: Show) => (s.i % 4 === 3 ? { text: rows.join('\n') } : { html: messyHtml(rows, s.i) });

// ---- Tier 1 layouts (from the readers' reference samples) -----------------

type Layout = (s: Show, id: string) => { email: RawEmailMessage; expect: Expect };

const TM_FROM = 'Ticketmaster <customer_support@email.ticketmaster.com>';
const ticketmaster: Layout = (s, id) => ({
  email: mail(id, s, {
    from: TM_FROM,
    subject: `You Got Tickets To ${s.name}`,
    ...body([`Order # 12-${s.order}/LA`, s.name, `${DOW[s.w]}, ${MON[s.m]} ${s.d}, ${s.y} · 8:00 PM`, `${s.venue} — ${s.city}, ${s.st}`, `Total: ${usd(s.total)}`], s),
  }),
  expect: { name: s.name, date: s.date, venue: s.venue, city: `${s.city}, ${s.st}` },
});

const liveNation: Layout = (s, id) => ({
  email: mail(id, s, {
    from: 'Live Nation <customer_support@replyto.livenation.com>',
    subject: `You Just Scored Tickets to ${s.name}`,
    ...body(['You Got the Tickets!', `Order # 28-${s.order}/NCA`, s.name, `${DOW[s.w]} · ${MON[s.m]} ${pad(s.d)}, ${s.y} · 8:00 PM`, `${s.venue} — ${s.city}, ${s.st}`, `Total: ${usd(s.total)}`], s),
  }),
  expect: { name: s.name, date: s.date, venue: s.venue, city: `${s.city}, ${s.st}` },
});

// No year anywhere; the weekday gives it.
const liveNationMobile: Layout = (s, id) => ({
  email: mail(id, s, {
    from: 'Live Nation <customer_support@replyto.livenation.com>',
    subject: 'View your mobile tickets for your upcoming event',
    ...body([`${s.name} with Special Guest Paper Comets`, `${DOW[s.w]}, ${MON[s.m]} ${pad(s.d)} @ ${s.venue}, ${s.city}, ${s.st}`, 'View Your Tickets'], s),
  }),
  expect: { name: `${s.name} with Special Guest Paper Comets`, date: s.date, venue: s.venue, city: `${s.city}, ${s.st}` },
});

const tixr: Layout = (s, id) => ({
  email: mail(id, s, {
    from: 'Tixr <noreply@tixr.com>',
    subject: `Order Confirmation: ${s.name}`,
    ...body(['Thanks for your order', s.name, s.venue, `${DOW[s.w]} ${MON[s.m]} ${s.d}, 10:00 PM`, `${s.qty} Items`, 'Order ID:', s.order, 'Total Including Fees:', usd(s.total)], s),
  }),
  expect: { name: s.name, date: s.date, venue: s.venue, price: s.total / s.qty },
});

const dice: Layout = (s, id) => ({
  email: mail(id, s, {
    from: 'DICE <hello@dice.fm>',
    subject: `Your tickets: ${s.name.toUpperCase()}`,
    ...body(['Venue details', 'Venue', s.venue, `${s.street}, ${s.city}, ${s.st} ${s.zip}, USA`, 'Date & time', `${DOW[s.w]} ${s.d} ${MON[s.m]},10:00 PM GMT-7`, 'Tickets', `${s.qty} x General Admission`, 'Total', usd(s.total)], s),
  }),
  expect: { name: s.name.toUpperCase(), date: s.date, venue: s.venue, city: `${s.city}, ${s.st}`, price: s.total / s.qty },
});

// Overnight: 22:00 to 05:00 the next morning is one night, not two days.
const residentAdvisor: Layout = (s, id) => {
  const next = new Date(Date.parse(s.date) + DAY);
  return {
    email: mail(id, s, {
      from: 'Resident Advisor <noreply@ra.co>',
      subject: `Your order for ${s.name}`,
      ...body([`${s.name}, you're going to`, s.name, `${DOW[s.w]}, ${s.d} ${MON[s.m]} - ${DOW[next.getUTCDay()]}, ${next.getUTCDate()} ${MON[next.getUTCMonth()]} ${next.getUTCFullYear()}`, '22:00 - 05:00', s.venue, `${s.street}, ${s.city}, ${s.st} ${s.zip}`, `${s.qty} x Early Bird`, `RA${s.order}`, 'Total', usd(s.total)], s),
    }),
    expect: { name: s.name, date: s.date, venue: s.venue, city: `${s.city}, ${s.st}` },
  };
};

const eventbrite: Layout = (s, id) => ({
  email: mail(id, s, {
    from: 'Eventbrite <orders@eventbrite.com>',
    subject: `Your Tickets for ${s.name}`,
    ...body([s.name, s.name, `${s.qty} x General Admission`, `Order total: ${usd(s.total)}`, `${DOW[s.w]}, ${MON[s.m]} ${s.d}, ${s.y} 8:00 PM - 11:00 PM PDT`, 'Add to', 'Google', 'Outlook', s.venue, `${s.street}, ${s.city}, ${s.st} ${s.zip}`, `#${s.order}0001 - ordered by you`], s),
  }),
  expect: { name: s.name, date: s.date, venue: s.venue, city: `${s.city}, ${s.st}` },
});

const eventbrite2015: Layout = (s, id) => ({
  email: mail(id, s, {
    from: 'Eventbrite <orders@eventbrite.com>',
    subject: `Order Confirmation for ${s.name}`,
    ...body([`Hi Sam , this is your order confirmation for ${s.name}`, 'Organized by Party People', 'Order Summary', `Order #: ${s.order}44`, 'About this event', `${DOW_FULL[s.w]}, ${MON_FULL[s.m]} ${s.d}, ${s.y} at 9:30 PM - ${DOW_FULL[(s.w + 1) % 7]}, ${MON_FULL[new Date(Date.parse(s.date) + DAY).getUTCMonth()]} ${new Date(Date.parse(s.date) + DAY).getUTCDate()}, ${new Date(Date.parse(s.date) + DAY).getUTCFullYear()} at 2:00 AM (PDT)`, s.venue, s.street, `${s.city}, ${s.st} ${s.zip}`, 'Add to my calendar:', 'Google'], s),
  }),
  expect: { name: s.name, date: s.date, venue: s.venue, city: `${s.city}, ${s.st}` },
});

const eventbrite2013: Layout = (s, id) => ({
  email: mail(id, s, {
    from: 'Eventbrite <orders@eventbrite.com>',
    subject: `Order Confirmation for ${s.name}`,
    ...body([`Your order for ${s.name} is complete!`, `${DOW_FULL[s.w]}, ${MON_FULL[s.m]} ${s.d}, ${s.y} at 8:00 PM (PDT)`, s.name, s.venue, s.street, `${s.city}, ${s.st} ${s.zip}`, `Order #: ${s.order}-2013`, 'TOTAL', usd(s.total)], s),
  }),
  expect: { name: s.name, date: s.date, venue: s.venue, city: `${s.city}, ${s.st}` },
});

const axsOrder: Layout = (s, id) => ({
  email: mail(id, s, {
    from: 'AXS Guest Services <guestservices@axs.com>',
    subject: `Thank you for your order for ${s.name} -  Artist Presale`,
    ...body([`Thank you for your order. Your confirmation number is ${s.order} . Please keep this number.`, `Order details for ${s.name} - Artist Presale at ${s.venue} scheduled on ${s.m + 1}/${s.d}/${s.y} 8:00 PM`, 'Grand Total:', usd(s.total)], s),
  }),
  expect: { name: s.name, date: s.date, venue: s.venue },
});

const axsTransfer: Layout = (s, id) => ({
  email: mail(id, s, {
    from: 'axs@axs.com',
    subject: 'Tickets Just Got Sent To You',
    ...body(['TICKETS JUST GOT SENT TO YOU', `Sam Lee transferred 2 tickets to you for ${s.name} at ${s.venue}, ${s.city}, ${s.st} on ${DOW_FULL[s.w]} ${s.m + 1}-${s.d}-${String(s.y).slice(2)} at 6:45 pm PDT.`], s),
  }),
  expect: { name: s.name, date: s.date, venue: s.venue, city: `${s.city}, ${s.st}` },
});

// Front Gate: the subject names the store; the show is in the body. One
// receipt lists a parking add-on, so no per-ticket price may be claimed.
const frontGateReceipt: Layout = (s, id) => ({
  email: mail(id, s, {
    from: 'Lights Out <order-support@frontgatetickets.com>',
    subject: `Your Insomniac Events Receipt - Order #${s.order}`,
    ...body([`Order #${s.order}`, 'Your order with Insomniac Events has been successfully processed.', 'Shipping Address', 'Sam Lee', s.name, `${DOW_FULL[s.w]}, ${MON_FULL[s.m]} ${s.d}, ${s.y}`, `at ${s.venue}`, s.street, `${s.city}, ${s.st}`, `- ${s.zip}`, 'Ticket', 'General Admission', String(s.qty), 'Preferred Parking: $40.00', `Total: ${usd(s.total + 40)}`], s),
  }),
  expect: { name: s.name, date: s.date, venue: s.venue, city: `${s.city}, ${s.st}` },
});

const frontGateTickets: Layout = (s, id) => ({
  email: mail(id, s, {
    from: 'order-support@frontgatetickets.com',
    subject: `Your Insomniac Events Digital Tickets : Order #${s.order}`,
    ...body(['Hey Sam,', `Order #${s.order}`, 'Order Details', s.name, 'Ages 18+ Only', 'General Admission (Tier 1)', `${DOW_FULL[s.w]}, ${MON_FULL[s.m]} ${s.d}, ${s.y}`, 'Show Time: 5:00PM', s.venue, s.street, `${s.city}, ${s.st} ${s.zip}`, '1 of 2', s.name, '2 of 2'], s),
  }),
  expect: { name: s.name, date: s.date, venue: s.venue, city: `${s.city}, ${s.st}` },
});

const ticketWebConfirmation: Layout = (s, id) => ({
  email: mail(id, s, {
    from: 'TicketWeb Orders <info@ticketweb.com>',
    subject: `Confirmed - you're going to ${s.name}!`,
    ...body(['Thank you for your purchase!', `Order Number: TW${s.order}`, 'ALL SALES ARE FINAL.', 'ORDER SUMMARY', 'Insomniac presents', s.name, `${DOW[s.w]} ${MON[s.m]} ${s.d}, ${s.y}`, 'Doors @ 10:00 PM', '(Time displayed is local to the venue)', 'AGE: 21 +', s.venue, s.street, `${s.city}, ${s.st} ${s.zip}`, 'Venue Directions', `${s.qty} Advance Tickets - Early Bird $10 $10.00`, usd(s.qty * 10), 'DELIVERY TYPE: TicketFast', 'Total Payment', `$ ${(s.qty * 14.95).toFixed(2)}`], s),
  }),
  expect: { name: s.name, date: s.date, venue: s.venue, city: `${s.city}, ${s.st}` },
});

const ticketWebDelivery: Layout = (s, id) => ({
  email: mail(id, s, {
    from: 'TicketWeb Orders <info@ticketweb.com>',
    subject: `Your tickets are here! You're going to ${s.name}!`,
    ...body([`YOU HAVE ${s.qty} TICKET(S)`, 'ATTACHED TO THIS EMAIL', `Order Confirmation Number: TW${s.order}`, 'Event Details:', s.name, s.venue, `${s.street}, ${s.city}, ${s.st}`, `${DOW[s.w]} ${MON[s.m]} ${s.d}, ${s.y} at 10:00 PM`, 'View Tickets'], s),
  }),
  expect: { name: s.name, date: s.date, venue: s.venue, city: `${s.city}, ${s.st}` },
});

// 50 messages: [layout, how many, first year]
const TIER1: Array<[string, Layout, number, number]> = [
  ['Ticketmaster', ticketmaster, 6, 2022],
  ['Live Nation order', liveNation, 4, 2019],
  ['Live Nation mobile tickets', liveNationMobile, 2, 2023],
  ['Tixr', tixr, 5, 2024],
  ['DICE', dice, 6, 2023],
  ['Resident Advisor (overnight)', residentAdvisor, 5, 2022],
  ['Eventbrite (2019 on)', eventbrite, 3, 2019],
  ['Eventbrite (2015-2018)', eventbrite2015, 3, 2015],
  ['Eventbrite (2013)', eventbrite2013, 2, 2013],
  ['AXS order', axsOrder, 4, 2024],
  ['AXS transfer', axsTransfer, 2, 2023],
  ['Front Gate receipt', frontGateReceipt, 2, 2025],
  ['Front Gate digital tickets', frontGateTickets, 2, 2025],
  ['TicketWeb confirmation', ticketWebConfirmation, 2, 2025],
  ['TicketWeb delivery', ticketWebDelivery, 2, 2025],
];

// ---- Tier 2 and 3: labelled-row layouts ------------------------------------

interface Labeled {
  seller: string;
  from: string;
  subject: (name: string) => string;
}
const BOUTIQUE: Labeled[] = [
  { seller: 'See Tickets', from: 'See Tickets <orders@seetickets.us>', subject: (n) => `Your See Tickets order for ${n}` },
  { seller: 'Shotgun', from: 'Shotgun <tickets@shotgun.live>', subject: (n) => `Your tickets for ${n}` },
  { seller: 'Posh', from: 'Posh <noreply@posh.vip>', subject: (n) => `You're going to ${n}!` },
  { seller: 'Etix', from: 'Etix <orders@etix.com>', subject: (n) => `Etix Order Confirmation - ${n}` },
  { seller: 'Universe', from: 'Universe <support@universe.com>', subject: (n) => `Order confirmed: ${n}` },
  { seller: 'ShowClix', from: 'ShowClix <orders@showclix.com>', subject: (n) => `ShowClix Order Confirmation: ${n}` },
  { seller: 'Prekindle', from: 'Prekindle <noreply@prekindle.com>', subject: (n) => `Prekindle Order Confirmation - ${n}` },
  { seller: 'VenuePilot', from: 'VenuePilot <tickets@venuepilot.com>', subject: (n) => `Your tickets for ${n}` },
  { seller: 'Seated', from: 'Seated <hello@seated.com>', subject: (n) => `You're going to ${n}!` },
  { seller: 'Fever', from: 'Fever <tickets@feverup.com>', subject: (n) => `Your tickets for ${n} are ready` },
  { seller: 'StubHub', from: 'StubHub <orders@stubhub.com>', subject: (n) => `Your StubHub order for ${n}` },
  { seller: 'SeatGeek', from: 'SeatGeek <orders@seatgeek.com>', subject: (n) => `Your SeatGeek order: ${n}` },
  { seller: 'Vivid Seats', from: 'Vivid Seats <orders@vividseats.com>', subject: (n) => `Vivid Seats Order Confirmation - ${n}` },
  { seller: 'TickPick', from: 'TickPick <orders@tickpick.com>', subject: (n) => `TickPick Order Confirmation: ${n}` },
  { seller: 'Cash or Trade', from: 'Cash or Trade <noreply@cashortrade.org>', subject: (n) => `Cash or Trade: You got tickets to ${n}` },
];

// Variant 0: "Label: value" rows; 1: label above value; 2: a multi-day
// festival with an end date and a merch add-on; 3: a ticket-type suffix in
// the subject and fees bundled into one total line.
function labeledMail(l: Labeled, s: Show, id: string, variant: number): { email: RawEmailMessage; expect: Expect } {
  const longDate = `${DOW[s.w]}, ${MON[s.m]} ${s.d}, ${s.y} 8:00 PM`;
  const end = new Date(Date.parse(s.date) + 2 * DAY);
  const festival = `${DOW[s.w]}, ${MON[s.m]} ${s.d}, ${s.y} - ${DOW[end.getUTCDay()]}, ${MON[end.getUTCMonth()]} ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
  const name = variant === 2 ? `${s.name} Festival` : s.name;
  const subjectName = variant === 3 ? `${name} - General Admission` : name;
  let rows: string[];
  if (variant === 1) {
    rows = ['Order Number', `${s.order}X`, 'Event', name, 'Date', longDate, 'Venue', s.venue, `${s.street}, ${s.city}, ${s.st} ${s.zip}`, 'Quantity', String(s.qty), 'Total', usd(s.total)];
  } else if (variant === 2) {
    rows = [`Order #: ${s.order}F`, `Event: ${name}`, `Date: ${festival}`, `Venue: ${s.venue}`, `Address: ${s.street}, ${s.city}, ${s.st} ${s.zip}`, `Quantity: ${s.qty}`, 'Festival T-shirt: $35.00', `Total: ${usd(s.total + 35)}`];
  } else {
    rows = [`Order #: ${s.order}A`, `Event: ${name}`, `Date: ${longDate}`, `Venue: ${s.venue}`, `Address: ${s.street}, ${s.city}, ${s.st} ${s.zip}`, `Quantity: ${s.qty}`, `Total (incl. fees): ${usd(s.total)}`];
  }
  return {
    email: mail(id, s, { from: l.from, subject: l.subject(subjectName), ...body(rows, s) }),
    expect: { name, date: s.date, venue: s.venue, city: `${s.city}, ${s.st}`, price: variant === 2 ? null : undefined },
  };
}

// ---- forwards ------------------------------------------------------------

type Client = 'gmail' | 'apple' | 'outlook' | 'outlook-rule' | 'yahoo';
const sentLine = (s: Show) => {
  const d = new Date(s.sentAt);
  return { day: d.getUTCDate(), m: d.getUTCMonth(), y: d.getUTCFullYear(), w: d.getUTCDay() };
};
function header(client: Client, from: string, subject: string, s: Show): string[] {
  const t = sentLine(s);
  switch (client) {
    case 'gmail':
      return ['---------- Forwarded message ---------', `From: ${from}`, `Date: ${DOW[t.w]}, ${MON[t.m]} ${t.day}, ${t.y} at 11:00 AM`, `Subject: ${subject}`, 'To: Sam Lee <sam@example.com>'];
    case 'apple':
      return ['Begin forwarded message:', `From: ${from}`, `Subject: ${subject}`, `Date: ${MON_FULL[t.m]} ${t.day}, ${t.y} at 11:00:00 AM PDT`, 'To: Sam Lee <sam@example.com>'];
    case 'outlook':
      return ['-----Original Message-----', `From: ${from}`, `Sent: ${DOW_FULL[t.w]}, ${MON_FULL[t.m]} ${t.day}, ${t.y} 11:00 AM`, 'To: Sam Lee', `Subject: ${subject}`];
    case 'outlook-rule':
      return ['________________________________', `From: ${from}`, `Sent: ${DOW_FULL[t.w]}, ${MON_FULL[t.m]} ${t.day}, ${t.y} 11:00 AM`, 'To: Sam Lee', `Subject: ${subject}`];
    case 'yahoo':
      return ['----- Forwarded Message -----', `From: ${from}`, 'To: Sam Lee <sam@example.com>', `Sent: ${DOW_FULL[t.w]}, ${MON_FULL[t.m]} ${t.day}, ${t.y}, 11:00:00 AM PDT`, `Subject: ${subject}`];
  }
}

function originalLines(e: RawEmailMessage): string[] {
  if (e.text) return e.text.split('\n');
  return (e.html ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|title|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<div style="display:none[^>]*>[\s\S]*?<\/div>/i, '')
    .replace(/<\/td>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8203;|&zwnj;/g, '')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// The forwarder writes a note above; the friend's own address is the sender.
// `stripped`: the phone kept only the original sender's name.
function forward(orig: RawEmailMessage, client: Client, s: Show, id: string, stripped = false, hops = 1): RawEmailMessage {
  const from = stripped ? orig.from.replace(/\s*<.*>$/, '') : orig.from;
  let lines = [...header(client, from, orig.subject, s), ...originalLines(orig)];
  let subject = orig.subject;
  for (let h = 0; h < hops; h++) {
    subject = `Fwd: ${subject}`;
    if (h > 0) lines = [...header('gmail', 'Alex Kim <alex@example.com>', subject.replace(/^Fwd: /, ''), s), ...lines];
    lines = [h === 0 ? 'look, we have tickets!' : 'fyi', ...lines];
  }
  return { id, link: link(id), from: 'Alex Kim <alex@example.com>', subject, sentAt: new Date(Date.parse(s.sentAt) + 90 * DAY).toISOString(), text: lines.join('\n') };
}

// ---- long tail: box offices, wallet passes, calendar invites, markup -------

function zip(entries: Record<string, string>, deflate: boolean): string {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [n, content] of Object.entries(entries)) {
    const name = Buffer.from(n);
    const raw = Buffer.from(content);
    const data = deflate ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    central.push(c, name);
    offset += local.length + name.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]).toString('base64');
}

const passOf = (s: Show) =>
  JSON.stringify({
    formatVersion: 1,
    description: 'Event ticket',
    relevantDate: `${s.date}T20:00:00-07:00`,
    eventTicket: {
      primaryFields: [{ key: 'event', label: 'EVENT', value: s.name }],
      secondaryFields: [{ key: 'venue', label: 'VENUE', value: s.venue }],
      auxiliaryFields: [{ key: 'doors', label: 'DOORS', value: '7:00 PM' }],
    },
  });

const ics = (s: Show) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `SUMMARY:${s.name}`, `DTSTART;TZID=America/Los_Angeles:${s.date.replace(/-/g, '')}T200000`, `LOCATION:${s.venue}\\, ${s.street}\\, ${s.city}\\, ${s.st} ${s.zip}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

function longTail(s: Show, id: string, kind: number): { email: RawEmailMessage; expect: Expect } {
  const base = { name: s.name, date: s.date, venue: s.venue };
  const box = `${s.venue} Box Office <boxoffice@${s.venue.toLowerCase().replace(/[^a-z]/g, '')}.example>`;
  switch (kind) {
    case 0: // headline layout
      return { email: mail(id, s, { from: box, subject: `Your tickets for ${s.name}`, text: [`Order #: BX-${s.order}`, `Your tickets for ${s.name} at ${s.venue}`, `Date: ${DOW[s.w]}, ${MON[s.m]} ${s.d}, ${s.y} 8:00 PM`, `Venue: ${s.venue}`, `${s.street}, ${s.city}, ${s.st} ${s.zip}`, `Tickets: ${s.qty}`, `Total: ${usd(s.total)}`].join('\n') }), expect: { ...base, city: `${s.city}, ${s.st}`, price: s.total / s.qty } };
    case 1: // labels above values, messy HTML
      return { email: mail(id, s, { from: box, subject: `Order confirmation - ${s.name}`, html: messyHtml(['Receipt', `Order #: BX-${s.order}`, 'Show', s.name, 'When', `${DOW_FULL[s.w]}, ${MON_FULL[s.m]} ${s.d}, ${s.y}`, 'Where', s.venue, 'Qty', String(s.qty), 'Total Paid', usd(s.total)], s.i) }), expect: base };
    case 2: // a promoter's plain receipt, parking on its own line
      return { email: mail(id, s, { from: `Lantern Presents <hello@lanternpresents.example>`, subject: `Your tickets: ${s.name}`, text: [`Receipt for order ${s.order}`, `You're going to ${s.name} at ${s.venue}`, `Date: ${MON[s.m]} ${s.d}, ${s.y}`, `Qty: ${s.qty}`, 'Parking: $20.00', `Total: ${usd(s.total + 20)}`].join('\n') }), expect: { ...base, price: null } };
    case 3: // wallet pass, stored
    case 4: // wallet pass, deflated
      return { email: mail(id, s, { from: box, subject: `Your tickets for ${s.name}`, text: `Your tickets are attached. Add them to Apple Wallet.\nOrder #: BX-${s.order}`, attachments: [{ filename: 'ticket.pkpass', mimeType: 'application/vnd.apple.pkpass', dataBase64: zip({ 'pass.json': passOf(s), 'manifest.json': '{}' }, kind === 4) }] }), expect: base };
    case 5: // wallet pass on an email whose body says nothing
      return { email: mail(id, s, { from: `DoorList <passes@doorlist.example>`, subject: 'Your wallet pass', text: 'Tap to add to Apple Wallet.', attachments: [{ filename: 'pass.pkpass', mimeType: 'application/vnd.apple.pkpass', dataBase64: zip({ 'pass.json': passOf(s) }, true) }] }), expect: base };
    case 6: // calendar invite
    case 7:
      return { email: mail(id, s, { from: box, subject: `Your tickets for ${s.name}`, text: `See you there!\nConfirmation #: C${s.order}`, attachments: [{ filename: 'invite.ics', mimeType: 'text/calendar', dataBase64: Buffer.from(ics(s)).toString('base64') }] }), expect: { ...base, city: `${s.city}, ${s.st}` } };
    case 8: // schema.org JSON-LD, the visible body a picture
      return {
        email: mail(id, s, {
          from: box,
          subject: `Order confirmation ${s.order}`,
          html: `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'http://schema.org', '@type': 'EventReservation', reservationNumber: s.order, reservationStatus: 'http://schema.org/ReservationConfirmed', reservationFor: { '@type': 'Event', name: s.name, startDate: `${s.date}T20:00:00-07:00`, location: { '@type': 'Place', name: s.venue, address: { '@type': 'PostalAddress', streetAddress: s.street, addressLocality: s.city, addressRegion: s.st, postalCode: s.zip, addressCountry: 'US' } } } }, null, 2)}</script></head><body><img src="https://cdn.example/banner.png" alt=""><p>Thanks for your order!</p></body></html>`,
        }),
        expect: { ...base, city: `${s.city}, ${s.st}` },
      };
    default: // schema.org microdata
      return {
        email: mail(id, s, {
          from: box,
          subject: `Your tickets for ${s.name}`,
          html: `<div itemscope itemtype="http://schema.org/EventReservation"><meta itemprop="reservationNumber" content="${s.order}"><link itemprop="reservationStatus" href="http://schema.org/Confirmed"><div itemprop="reservationFor" itemscope itemtype="http://schema.org/Event"><meta itemprop="name" content="${esc(s.name)}"><meta itemprop="startDate" content="${s.date}T19:30:00-07:00"><div itemprop="location" itemscope itemtype="http://schema.org/Place"><meta itemprop="name" content="${esc(s.venue)}"><div itemprop="address" itemscope itemtype="http://schema.org/PostalAddress"><meta itemprop="addressLocality" content="${s.city}"><meta itemprop="addressRegion" content="${s.st}"></div></div></div></div><p>See you at the show.</p>`,
        }),
        expect: { ...base, city: `${s.city}, ${s.st}` },
      };
  }
}

// ---- traps: not concerts, though each says "tickets" or "order" ------------

function traps(): Fixture[] {
  const s = show(99, 2025);
  const boarding = JSON.stringify({ formatVersion: 1, relevantDate: `${s.date}T08:00:00-07:00`, boardingPass: { transitType: 'PKTransitTypeAir', primaryFields: [{ key: 'origin', value: 'SFO' }] }, eventTicket: { primaryFields: [{ key: 'event', value: 'Flight 482' }] } });
  return [
    {
      label: 'trap: airline e-tickets and boarding pass',
      group: 'trap',
      expect: null,
      email: mail('trap-airline', s, { from: 'Skyway Airlines <noreply@skyway.example>', subject: 'Your order confirmation and e-tickets', text: `Order #: XK2931\nYour tickets for Flight 482 at Gate 12\nDate: ${DOW[s.w]}, ${MON[s.m]} ${s.d}, ${s.y} 8:00 AM\nGeneral admission to the lounge\nTotal: $320.00`, attachments: [{ filename: 'boarding.pkpass', mimeType: 'application/vnd.apple.pkpass', dataBase64: zip({ 'pass.json': boarding }, true) }] }),
    },
    {
      label: 'trap: movie tickets',
      group: 'trap',
      expect: null,
      email: mail('trap-movie', s, { from: 'AMC Theatres <tickets@amctheatres.example>', subject: 'Order confirmation: your tickets for Dune', html: messyHtml(['Order #: FD99182', 'Your tickets for Dune at AMC Metreon 16', `Date: ${DOW[s.w]}, ${MON[s.m]} ${s.d}, ${s.y} 8:00 PM`, 'Admission: 2 Adult', 'Venue: AMC Metreon 16', 'Total: $28.00'], 3) }),
    },
    {
      label: 'trap: hotel booking',
      group: 'trap',
      expect: null,
      email: mail('trap-hotel', s, { from: 'Harbor Inn <reservations@harborinn.example>', subject: 'Order confirmation: your stay', text: `Confirmation #: HI-55120\nEvent: Your stay at Harbor Inn\nCheck-in: ${DOW[s.w]}, ${MON[s.m]} ${s.d}, ${s.y}\nDate: ${DOW[s.w]}, ${MON[s.m]} ${s.d}, ${s.y}\nIncludes 2 museum admission tickets\nTotal: $412.00` }),
    },
    {
      label: 'trap: parking pass',
      group: 'trap',
      expect: null,
      email: mail('trap-parking', s, { from: 'ParkWhiz <receipts@parkwhiz.example>', subject: 'Your parking pass tickets - order confirmation', text: `Receipt #: PK7712\nYour tickets for Velvet Tide at Union Pavilion\nEvent: Velvet Tide\nDate: ${DOW[s.w]}, ${MON[s.m]} ${s.d}, ${s.y}\nParking pass, Lot B\nTotal: $30.00` }),
    },
    {
      label: 'trap: promo newsletter',
      group: 'trap',
      expect: null,
      email: mail('trap-promo', s, { from: 'Union Pavilion <news@unionpavilion.example>', subject: 'Tickets on sale Friday: Velvet Tide - general admission', html: messyHtml(['Tickets on sale Friday at 10 AM', 'Velvet Tide', `Date: ${DOW[s.w]}, ${MON[s.m]} ${s.d}, ${s.y}`, 'Venue: Union Pavilion', 'General admission $45', 'Unsubscribe'], 2) }),
    },
  ];
}

// ---- the corpus ----------------------------------------------------------

export function buildCorpus(): Fixture[] {
  const out: Fixture[] = [];
  let n = 0;
  for (const [label, layout, count, year] of TIER1) {
    for (let k = 0; k < count; k++) {
      const s = show(n, year + (k % 2));
      const { email, expect } = layout(s, `t1-${n}`);
      out.push({ label: `${label} #${k + 1}`, group: 'tier1', email, expect });
      n++;
    }
  }
  for (let k = 0; k < 20; k++) {
    const l = BOUTIQUE[k % BOUTIQUE.length];
    const s = show(n, 2024 + (k % 3));
    const { email, expect } = labeledMail(l, s, `b-${n}`, k < 15 ? k % 2 : 2 + (k % 2));
    out.push({ label: `${l.seller} #${Math.floor(k / BOUTIQUE.length) + 1}`, group: 'boutique', email, expect });
    n++;
  }
  // Forwards of Tier 1 and boutique mail across mail clients.
  const plan: Array<[Client, Layout | Labeled, boolean, number]> = [
    ['gmail', ticketmaster, false, 1],
    ['gmail', dice, false, 1],
    ['gmail', BOUTIQUE[1], false, 1],
    ['gmail', eventbrite, false, 2],
    ['apple', ticketmaster, true, 1],
    ['apple', dice, true, 1],
    ['apple', tixr, false, 1],
    ['apple', residentAdvisor, false, 1],
    ['outlook', axsOrder, false, 1],
    ['outlook', liveNation, false, 1],
    ['outlook-rule', ticketWebDelivery, false, 1],
    ['yahoo', ticketmaster, false, 1],
    ['yahoo', BOUTIQUE[10], false, 1],
    ['yahoo', frontGateTickets, false, 1],
    ['gmail', tixr, false, 3],
  ];
  for (const [client, src, stripped, hops] of plan) {
    const s = show(n, 2024);
    const made = typeof src === 'function' ? src(s, `orig-${n}`) : labeledMail(src, s, `orig-${n}`, 0);
    const label = typeof src === 'function' ? (TIER1.find(([, l]) => l === src)?.[0] ?? 'Tier 1') : src.seller;
    out.push({
      label: `forward (${client}${stripped ? ', name only' : ''}${hops > 1 ? `, ${hops} hops` : ''}) of ${label}`,
      group: 'forwarded',
      email: forward(made.email, client, s, `f-${n}`, stripped, hops),
      expect: { ...made.expect, price: undefined },
    });
    n++;
  }
  for (let k = 0; k < 10; k++) {
    const s = show(n, 2023 + (k % 3));
    const { email, expect } = longTail(s, `lt-${n}`, k);
    out.push({ label: `long tail #${k + 1}`, group: 'longtail', email, expect });
    n++;
  }
  out.push(...traps());
  return out;
}
