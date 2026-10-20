import { fromDomain } from './text';
import { cityFrom, dateFields, indexOfName, money, quoted, subjectAfter, venueFrom } from './read';
import { EmailReader, UnreadableEmail } from './types';

// "You Got Tickets To <event>": the event name, then its date, then
// "<venue> — <city>, <state>". The same layout since at least 2022.
export const ticketmaster: EmailReader = {
  seller: 'Ticketmaster',
  matches: (from) => fromDomain(from, 'ticketmaster.com'),
  read(email, lines) {
    const name = subjectAfter(email.subject, /^You Got Tickets To (.+)$/i);
    if (!name) return null;
    const at = indexOfName(lines, name);
    const dateLine = at >= 0 ? lines[at + 1] : undefined;
    const date = dateLine ? dateFields(dateLine, email.sentAt) : {};
    if (!date.startDate && !date.dateText) throw new UnreadableEmail('No event date after the event name.');
    const place = lines[at + 2]?.match(/^(.+?)\s+[—–]\s+(.+)$/);
    const order = lines.find((l) => /^Order #\s*\S/.test(l));
    return {
      kind: 'order',
      name: quoted(name, lines[at]),
      ...date,
      venue: place ? venueFrom(place[1]) : undefined,
      city: place ? cityFrom(place[2]) : undefined,
      orderId: order?.replace(/^Order #\s*/, ''),
      total: money(lines.find((l) => /^Total:/.test(l))),
    };
  },
};
