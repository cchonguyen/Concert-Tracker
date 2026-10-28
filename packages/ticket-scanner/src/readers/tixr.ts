import { fromDomain } from '../text.ts';
import { count, dateFields, indexOfName, moneyAfter, quoted, subjectAfter, valueAfter, venueFrom } from '../read.ts';
import type { EmailReader } from '../readerTypes.ts';
import { UnreadableEmail } from '../readerTypes.ts';

// "Order Confirmation: <event>" and "Tickets for: <event>" (tickets ready):
// a card with the event name, the venue, and a date without a year
// ("Sat Aug 29, 10:00 PM").
export const tixr: EmailReader = {
  seller: 'Tixr',
  domain: 'tixr.com',
  matches: (from) => fromDomain(from, 'tixr.com'),
  read(email, lines) {
    const name = subjectAfter(email.subject, /^(?:Order Confirmation|Tickets for):\s*(.+)$/i);
    if (!name) return null;
    const at = indexOfName(lines, name);
    if (at < 0) throw new UnreadableEmail('The event card was not found.');
    const date = dateFields(lines[at + 2] ?? '', email.sentAt);
    if (!date.startDate && !date.dateText) throw new UnreadableEmail('No event date on the event card.');
    const order = valueAfter(lines, 'Order ID:');
    return {
      kind: 'order',
      name: quoted(name, lines[at]),
      ...date,
      venue: venueFrom(lines[at + 1]),
      orderId: order?.value,
      tickets: count(lines[at + 3]),
      total: moneyAfter(lines, /^Total Including Fees:/i),
    };
  },
};
