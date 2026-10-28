import { fromDomain } from '../text.ts';
import { cityFrom, cityFromAddress, count, dateFields, money, quoted, valueAfter, venueFrom } from '../read.ts';
import type { EmailReader, ReadEmail } from '../readerTypes.ts';
import { UnreadableEmail } from '../readerTypes.ts';

// TicketWeb sends two ticket emails per order (reminders, "Event Update"
// and changed-event notices are not read):
// - The confirmation ("Confirmed - you're going to <event>!", before 2025
//   "Your TicketWeb Order Confirmation for Order# <id>"): under "ORDER
//   SUMMARY", an optional "<promoter> presents" line, the event, a date
//   with its year, then the venue above its street and "City, ST 90028".
// - The tickets ("Your tickets are here! You're going to <event>!", before
//   2025 "Your TicketWeb Tickets for Order# <id> Have Arrived!"): under
//   "Event Details:", the event, the venue, "street, City, ST" and the date.
const CONFIRMATION = /^(?:Confirmed - you're going to\b|Your TicketWeb Order Confirmation\b)/i;
const DELIVERY = /^(?:Your tickets are here!|Your TicketWeb Tickets for Order#)/i;

export const ticketWeb: EmailReader = {
  seller: 'TicketWeb',
  domain: 'ticketweb.com',
  search: 'subject:("you\'re going to" OR "Order Confirmation" OR "Have Arrived")',
  matches: (from) => fromDomain(from, 'ticketweb.com'),
  read(email, lines) {
    const subject = email.subject.replace(/\s+/g, ' ').trim();
    if (CONFIRMATION.test(subject)) return confirmation(lines, email.sentAt);
    if (DELIVERY.test(subject)) return delivery(lines, email.sentAt);
    return null;
  },
};

function confirmation(lines: string[], sentAt: string): ReadEmail {
  const summary = lines.findIndex((l) => /^ORDER SUMMARY$/i.test(l));
  if (summary < 0) throw new UnreadableEmail('The order summary was not found.');
  let at = summary + 1;
  if (/\bpresents$/i.test(lines[at] ?? '')) at++;
  // An act name can wrap onto the next line ("Lost in Dreams ft." / "Secret Lineup").
  const wraps = /(?:\bft\.|\bfeat\.|\bfeaturing|\bwith|&)$/i.test(lines[at] ?? '');
  const name = wraps ? `${lines[at]} ${lines[at + 1] ?? ''}`.trim() : lines[at];
  at += wraps ? 2 : 1;
  const date = dateFields(lines[at] ?? '', sentAt);
  if (!name || (!date.startDate && !date.dateText)) throw new UnreadableEmail('No event date under the event name.');
  // The venue is the line above its street, which is above "City, ST 90028".
  const end = lines.findIndex((l, i) => i > at && /^Venue Directions$/i.test(l));
  const address = lines.findIndex((l, i) => i > at && (end < 0 || i < end) && cityFromAddress(l));
  const tickets = lines
    .slice(end + 1, lines.findIndex((l, i) => i > end && /^DELIVERY TYPE:/i.test(l)))
    .filter((l) => /^\d+\s.*\btickets?\b/i.test(l))
    .reduce((n, l) => n + (count(l) ?? 0), 0);
  return {
    kind: 'order',
    name: quoted(name),
    ...date,
    venue: address >= 2 ? venueFrom(lines[address - 2]) : undefined,
    city: address >= 0 ? cityFromAddress(lines[address]) : undefined,
    orderId: valueAfter(lines, 'Order Number:')?.value,
    tickets: end >= 0 && tickets ? tickets : undefined,
    total: totalPayment(lines),
  };
}

// "Subtotal / Service Fee / Delivery Fee / Total Payment", then their values
// in the same order.
function totalPayment(lines: string[]): string | undefined {
  const label = lines.findIndex((l) => /^Total Payment$/i.test(l));
  const first = lines.findIndex((l) => /^Subtotal$/i.test(l));
  if (label < 0 || first < 0 || first > label) return undefined;
  return money(lines[label + 1 + (label - first)]);
}

function delivery(lines: string[], sentAt: string): ReadEmail {
  const details = lines.findIndex((l) => /^Event Details:$/i.test(l));
  if (details < 0) throw new UnreadableEmail('The event details were not found.');
  const [name, venue, address, when] = lines.slice(details + 1, details + 5);
  const date = dateFields(when ?? '', sentAt);
  if (!name || (!date.startDate && !date.dateText)) throw new UnreadableEmail('No event date in the event details.');
  const parts = (address ?? '').split(',').map((p) => p.trim());
  const city = parts.length >= 3 ? cityFrom(parts.slice(-2).join(', ')) : undefined;
  return {
    kind: 'order',
    name: quoted(name),
    ...date,
    venue: venueFrom(venue),
    city: city && quoted(city.value, address!),
    orderId: valueAfter(lines, 'Order Confirmation Number:')?.value,
    tickets: Number(lines.find((l) => /^YOU HAVE \d+ TICKET/i.test(l))?.match(/\d+/)?.[0]) || undefined,
  };
}
