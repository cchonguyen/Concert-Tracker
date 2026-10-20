import { fromDomain } from './text';
import { cityFromAddress, count, dateFields, money, quoted, same, subjectAfter, venueFrom } from './read';
import { EmailReader, UnreadableEmail } from './types';

// "Your Tickets for <event>" (2019) and "Order Confirmation for <event>"
// (2026): the event name, the tickets and total, the full date, calendar
// links, then the venue and its address.
const CALENDAR = /^(add to|google|outlook|ical|yahoo|·|\(?view on map\)?)$/i;

export const eventbrite: EmailReader = {
  seller: 'Eventbrite',
  matches: (from) => fromDomain(from, 'eventbrite.com'),
  read(email, lines) {
    const name = subjectAfter(email.subject, /^(?:Your Tickets for|Order Confirmation for)\s+(.+)$/i);
    if (!name) return null;
    // The last line naming the event is the order card (the first can be a heading).
    const at = lines.reduce((last, l, i) => (same(l, name) ? i : last), -1);
    if (at < 0) throw new UnreadableEmail('The order card was not found.');
    const d = lines.slice(at + 1, at + 6).findIndex((l) => dateFields(l, email.sentAt).startDate);
    if (d < 0) throw new UnreadableEmail('No event date on the order card.');
    const dateAt = at + 1 + d;
    let v = dateAt + 1;
    while (v < lines.length && CALENDAR.test(lines[v])) v++;
    const address = lines.slice(v, v + 4).find((l) => cityFromAddress(l));
    const order = lines.find((l) => /^#\d+/.test(l));
    return {
      kind: 'order',
      name: quoted(name, lines[at]),
      ...dateFields(lines[dateAt], email.sentAt),
      venue: address === lines[v] ? undefined : venueFrom(lines[v]),
      city: cityFromAddress(address),
      orderId: order?.match(/^#(\d+)/)?.[1],
      tickets: count(lines.slice(at + 1, dateAt).find((l) => /^\d+\s*x\s/i.test(l))),
      total: money(lines.slice(at + 1, dateAt).find((l) => /^Order total:/i.test(l))),
    };
  },
};
