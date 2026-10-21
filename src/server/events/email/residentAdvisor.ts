import { fromDomain } from './text';
import { cityFromAddress, count, dateFields, isAddress, money, quoted, subjectAfter, valueAfter, venueFrom } from './read';
import { EmailReader, UnreadableEmail } from './types';

// "Your order for <event>": the event name, its dates ("Fri, 11 Dec - Sat,
// 12 Dec 2026"), the times, the venue and its address, then the tickets.
export const residentAdvisor: EmailReader = {
  seller: 'Resident Advisor',
  domain: 'ra.co',
  matches: (from) => fromDomain(from, 'ra.co'),
  read(email, lines) {
    const name = subjectAfter(email.subject, /^Your order for\s+(.+)$/i);
    if (!name) return null;
    // The first line naming the event is the greeting ("..., you're going to").
    const at = lines.findIndex((l, i) => i > 0 && l.replace(/\s+/g, ' ').toLowerCase() === name.toLowerCase());
    if (at < 0) throw new UnreadableEmail('The event card was not found.');
    const times = /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(lines[at + 2] ?? '') ? lines[at + 2] : '';
    const date = dateFields(`${lines[at + 1] ?? ''} ${times}`, email.sentAt);
    if (!date.startDate && !date.dateText) throw new UnreadableEmail('No event date after the event name.');
    const v = at + (times ? 3 : 2);
    const venue = isAddress(lines[v]) ? undefined : venueFrom(lines[v]);
    const address = lines.slice(v, v + 2).find(isAddress);
    const tickets = lines.slice(v, v + 3).find((l) => /^\d+\s*x\s/i.test(l));
    const order = lines.find((l) => /^(?:Order\s+)?RA\d[\w-]*$/.test(l));
    return {
      kind: 'order',
      name: quoted(name, lines[at]),
      ...date,
      venue,
      city: cityFromAddress(address),
      orderId: order?.replace(/^Order\s+/, ''),
      tickets: count(tickets),
      total: money(valueAfter(lines, 'Total')?.value),
    };
  },
};
