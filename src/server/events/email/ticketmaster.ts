import { fromDomain } from './text';
import { cityFrom, dateFields, indexOfName, money, quoted, subjectAfter, venueFrom } from './read';
import { EmailReader, RawEmail, ReadEmail, UnreadableEmail } from './types';

// "You Got Tickets To <event>": the event name, then its date, then
// "<venue> — <city>, <state>". The same layout since at least 2022 (Live
// Nation's "You Just Scored Tickets to" since 2019).
export const ticketmaster: EmailReader = {
  seller: 'Ticketmaster',
  domain: 'ticketmaster.com',
  matches: (from) => fromDomain(from, 'ticketmaster.com'),
  read(email, lines) {
    const name = subjectAfter(email.subject, /^You Got Tickets To (.+)$/i);
    return name ? gotTickets(email, lines, name) : null;
  },
};

// The order card Ticketmaster and Live Nation share.
export function gotTickets(email: RawEmail, lines: string[], name: string): ReadEmail {
  const at = indexOfName(lines, name);
  const dateLine = at >= 0 ? lines[at + 1] : undefined;
  const date = dateLine ? dateFields(dateLine, email.sentAt) : {};
  if (!date.startDate && !date.dateText) throw new UnreadableEmail('No event date after the event name.');
  const place = lines[at + 2]?.match(/^(.+?)\s+[—–]\s+(.+)$/);
  const order = lines.find((l) => /^Order #\s*\S/.test(l));
  const tickets = seats(lines);
  return {
    kind: 'order',
    name: quoted(name, lines[at]),
    ...date,
    venue: place ? venueFrom(place[1]) : undefined,
    city: place ? cityFrom(place[2]) : undefined,
    orderId: order?.replace(/^Order #\s*/, ''),
    total: money(lines.find((l) => /^Total:/.test(l))),
    ...(tickets ? { tickets } : {}),
  };
}

// "Sec 141LG, Row R, Seat 5 - 8" is four tickets; general admission names
// no seats, so no count.
function seats(lines: string[]): number | undefined {
  const rows = [...new Set(lines)].map((l) => l.match(/^Sec .+, Row .+, Seats? (\d+)(?:\s*-\s*(\d+))?$/i)).filter((m) => m);
  if (rows.length !== 1) return undefined;
  const [, from, to] = rows[0]!;
  const n = to ? Number(to) - Number(from) + 1 : 1;
  return n > 0 ? n : undefined;
}
