import type { RawEmailMessage } from '../../src/types.ts';

// Synthetic emails in each seller's layout: made-up orders, no real mail.
// The real 100-message anonymized corpus is not here yet; see README.

export const mail = (over: Partial<RawEmailMessage> & Pick<RawEmailMessage, 'from' | 'subject'>): RawEmailMessage => ({
  id: over.subject,
  link: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(over.subject)}`,
  sentAt: '2024-06-01T18:00:00Z',
  ...over,
});

export interface Fixture {
  label: string;
  email: RawEmailMessage;
  expect: { name: string; date: string; venue?: string; city?: string } | null; // null: must produce no show
}

const ticketmasterMail = mail({
  from: 'Ticketmaster <customer_support@email.ticketmaster.com>',
  subject: 'You Got Tickets To Porter Robinson',
  html: `<html><head><title>Your order</title><style>.x{}</style></head><body>
    <!-- preheader -->
    <table><tr><td>Porter Robinson</td></tr>
    <tr><td>Sat, Oct 5, 2024 &middot; 8:00 PM</td></tr>
    <tr><td>Greek Theatre &mdash; Los Angeles, CA</td></tr>
    <tr><td>Order # 12-34567/LA</td></tr>
    <tr><td>Total: $142.50</td></tr></table></body></html>`,
});

const boxOffice = mail({
  from: 'The Independent Box Office <tickets@theindependent.example>',
  subject: 'Your tickets for Moon Garden',
  sentAt: '2025-03-01T18:00:00Z',
  text: 'Order #: MG-55821\nYour tickets for Moon Garden at The Independent\nDate: Fri, Apr 4, 2025 8:00 PM\nVenue: The Independent\n628 Divisadero St, San Francisco, CA 94117\nTickets: 2\nTotal: $60.00',
});

export const CONCERTS: Fixture[] = [
  { label: 'Ticketmaster', email: ticketmasterMail, expect: { name: 'Porter Robinson', date: '2024-10-05', venue: 'Greek Theatre', city: 'Los Angeles, CA' } },
  {
    label: 'Tixr',
    email: mail({
      from: 'Tixr <noreply@tixr.com>',
      subject: 'Order Confirmation: Night Owls',
      sentAt: '2026-07-01T18:00:00Z',
      text: 'Thanks for your order\nNight Owls\nThe Shrine\nSat Aug 29, 10:00 PM\n2 Items\nOrder ID:\n998877\nTotal Including Fees: $88.00',
    }),
    expect: { name: 'Night Owls', date: '2026-08-29', venue: 'The Shrine' },
  },
  {
    label: 'DICE',
    email: mail({
      from: 'DICE <hello@dice.fm>',
      subject: 'Your tickets: MAURICE',
      sentAt: '2026-09-01T18:00:00Z',
      text: 'Venue details\nVenue\nLos Globos\n3040 Sunset Blvd, Los Angeles, CA 90026, USA\nDate & time\nSat 17 Oct,10:00 PM GMT-7\nTickets\n1 x General Admission\nTotal\n$25.00',
    }),
    expect: { name: 'MAURICE', date: '2026-10-17', venue: 'Los Globos', city: 'Los Angeles, CA' },
  },
  {
    label: 'Resident Advisor',
    email: mail({
      from: 'Resident Advisor <noreply@ra.co>',
      subject: 'Your order for Deep Space',
      sentAt: '2026-10-01T18:00:00Z',
      text: "Deep Space, you're going to\nDeep Space\nFri, 11 Dec - Sat, 12 Dec 2026\n22:00 - 05:00\nThe Warehouse\n100 Main St, San Francisco, CA 94102\n2 x Early Bird\nRA123456\nTotal\n$40.00",
    }),
    expect: { name: 'Deep Space', date: '2026-12-11', venue: 'The Warehouse', city: 'San Francisco, CA' },
  },
  {
    label: 'Eventbrite',
    email: mail({
      from: 'Eventbrite <orders@eventbrite.com>',
      subject: 'Your Tickets for Summer Showcase',
      sentAt: '2019-05-01T18:00:00Z',
      text: 'Summer Showcase\nSummer Showcase\n1 x General Admission\nOrder total: $15.00\nSat, Jun 8, 2019 8:00 PM - 11:00 PM PDT\nAdd to\nGoogle\nOutlook\nThe Echo\n1822 Sunset Blvd, Los Angeles, CA 90026\n#1234567890 - ordered by you',
    }),
    expect: { name: 'Summer Showcase', date: '2019-06-08', venue: 'The Echo' },
  },
  {
    label: 'Eventbrite 2013 layout',
    email: mail({
      from: 'Eventbrite <orders@eventbrite.com>',
      subject: 'Order Confirmation for Garage Night',
      sentAt: '2013-09-06T18:00:00Z',
      text: 'Your order for Garage Night is complete!\nSaturday, September 14, 2013 at 10:00 PM - Sunday, September 15, 2013 at 6:00 AM (PDT)\nGarage Night\nThe Basement\n401 6th St\nSan Francisco, CA 94103\nOrder #: 1000000001-200000001\nTOTAL\n$12.00',
    }),
    expect: { name: 'Garage Night', date: '2013-09-14', venue: 'The Basement', city: 'San Francisco, CA' },
  },
  {
    label: 'AXS order',
    email: mail({
      from: 'AXS Guest Services <guestservices@axs.com>',
      subject: 'Thank you for your order for Night Bloom -  Artist Presale',
      sentAt: '2026-07-29T18:00:00Z',
      text: 'Thank you for your order. Your confirmation number is 10000004 . Please keep this number.\nOrder details for Night Bloom - Artist Presale at El Rey Theatre scheduled on 10/1/2026 8:00 PM\nGrand Total:\n$36.50',
    }),
    expect: { name: 'Night Bloom', date: '2026-10-01', venue: 'El Rey Theatre' },
  },
  {
    label: 'AXS transfer ("You Received Tickets")',
    email: mail({
      from: 'axs@axs.com',
      subject: 'Tickets Just Got Sent To You',
      sentAt: '2023-09-21T02:00:00Z',
      text: 'TICKETS JUST GOT SENT TO YOU\nSam Lee transferred 2 tickets to you for Lantern Fest at The Greek Theatre, Los Angeles, CA on Friday 9-22-23 at 6:45 pm PDT.',
    }),
    expect: { name: 'Lantern Fest', date: '2023-09-22', venue: 'The Greek Theatre', city: 'Los Angeles, CA' },
  },
  {
    label: 'Gmail forward of Ticketmaster',
    email: mail({
      from: 'Sam Lee <sam@example.com>',
      subject: 'Fwd: You Got Tickets To Porter Robinson',
      sentAt: '2024-09-01T18:00:00Z',
      text: [
        'look at this',
        '---------- Forwarded message ---------',
        'From: Ticketmaster <customer_support@email.ticketmaster.com>',
        'Date: Sat, Jun 1, 2024 at 11:00 AM',
        'Subject: You Got Tickets To Porter Robinson',
        'To: Sam Lee <sam@example.com>',
        'Porter Robinson',
        'Sat, Oct 5, 2024 · 8:00 PM',
        'Greek Theatre — Los Angeles, CA',
        'Order # 12-34567/LA',
        'Total: $142.50',
      ].join('\n'),
    }),
    expect: { name: 'Porter Robinson', date: '2024-10-05', venue: 'Greek Theatre', city: 'Los Angeles, CA' },
  },
  { label: 'Independent box office (Layer 4)', email: boxOffice, expect: { name: 'Moon Garden', date: '2025-04-04', venue: 'The Independent' } },
];

// Mail that is not a show: no proposal with status "new" may come from it.
export const TRAPS: Fixture[] = [
  {
    label: 'newsletter',
    email: mail({ from: 'Ticketmaster <news@email.ticketmaster.com>', subject: 'Tickets on sale now: Summer Tour', text: 'Tickets on sale now!\nGet yours before they sell out.\nUnsubscribe' }),
    expect: null,
  },
  {
    label: 'presale announcement',
    email: mail({ from: 'Venue Updates <hello@somevenue.example>', subject: 'Your presale code for Night Bloom', text: 'Your presale code is ABC123\nTickets on sale Friday at 10 AM.\nUnsubscribe' }),
    expect: null,
  },
  {
    label: 'boarding pass',
    email: mail({ from: 'Airline <noreply@airline.example>', subject: 'Your tickets and boarding pass', text: 'Order #: XK2931\nFlight 482\nDate: Fri, Apr 4, 2025 8:00 AM\nVenue: Gate 12\nTotal: $320.00' }),
    expect: null,
  },
  {
    label: 'movie ticket',
    email: mail({ from: 'Fandango <tickets@fandango.example>', subject: 'Your tickets for Dune', text: 'Order #: FD99182\nYour tickets for Dune at AMC Metreon 16\nDate: Fri, Apr 4, 2025 8:00 PM\nVenue: AMC Metreon 16\nTotal: $28.00' }),
    expect: null,
  },
  {
    label: 'parking-only receipt',
    email: mail({ from: 'Parking <receipts@parkme.example>', subject: 'Your parking pass receipt', text: 'Receipt #: PK7712\nParking pass for Greek Theatre\nDate: Sat, Oct 5, 2024\nTotal: $30.00' }),
    expect: null,
  },
];
