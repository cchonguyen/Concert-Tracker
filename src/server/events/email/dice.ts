import { fromDomain } from './text';
import { cityFromAddress, count, dateFields, money, quoted, subjectAfter, valueAfter, venueFrom } from './read';
import { EmailReader, UnreadableEmail } from './types';

// "Your tickets: <event>": labelled rows (Venue, Date & time, Tickets,
// Total), the date without a year ("Sat 17 Oct,10:00 PM GMT-7").
// "Refund requested: <event>" marks the tickets as refunded.
export const dice: EmailReader = {
  seller: 'DICE',
  domain: 'dice.fm',
  matches: (from) => fromDomain(from, 'dice.fm'),
  read(email, lines) {
    const refund = subjectAfter(email.subject, /^Refund[a-z ]*:\s*(.+)$/i);
    if (refund) return { kind: 'refund', name: quoted(refund, email.subject) };
    const name = subjectAfter(email.subject, /^Your tickets:\s*(.+)$/i);
    if (!name) return null;
    const when = valueAfter(lines, 'Date & time');
    if (!when) throw new UnreadableEmail('No "Date & time" row.');
    const venue = valueAfter(lines, 'Venue');
    const tickets = valueAfter(lines, 'Tickets');
    return {
      kind: 'order',
      name: quoted(name),
      ...dateFields(when.value, email.sentAt),
      venue: venueFrom(venue?.value),
      city: venue ? cityFromAddress(lines[venue.at + 1]) : undefined,
      tickets: count(tickets?.value),
      total: money(valueAfter(lines, 'Total')?.value),
    };
  },
};
