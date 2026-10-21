import { fromDomain } from './text';
import { cityFrom, cityFromAddress, dateFields, money, quoted, subjectAfter, venueFrom, withoutTicketType } from './read';
import { EmailReader, ReadEmail, UnreadableEmail } from './types';

// Front Gate sells for promoters (Insomniac, EDC, Lost In Dreams), so the
// subject names the store, not the show; the show is in the body.
// - "Your <store> Receipt - Order #N": sent again after each layaway
//   payment. The item name, its full date (none before the dates are set),
//   "at <venue>", the street, then "City, ST".
// - "Your <store> Digital Tickets : Order #N": "Order Details", then per
//   ticket the item name, the date, "Show Time", the venue and its address.
// Shipping notices, payment reminders and account mail are not read.

const SUBJECT = /^Your .+? (Receipt - Order|Digital Tickets\s*:\s*Order) #(\d+)$/i;

export const frontGate: EmailReader = {
  seller: 'Front Gate',
  matches: (from) => fromDomain(from, 'frontgatetickets.com'),
  read(email, lines) {
    const subject = subjectAfter(email.subject, SUBJECT);
    if (!subject) return null;
    const orderId = email.subject.match(SUBJECT)![2];
    const read = /receipt/i.test(subject) ? receipt(lines, email.sentAt) : tickets(lines, email.sentAt);
    return { kind: 'order', orderId, ...read };
  },
};

function named(line: string): ReadEmail['name'] {
  return quoted(withoutTicketType(line), line);
}

function receipt(lines: string[], sentAt: string): Omit<ReadEmail, 'kind'> {
  // The item, its date, then "at <venue>"; a pass sold before its dates
  // were set has no date line.
  const venueAt = lines.findIndex((l, i) => i > 0 && /^at\s/i.test(l));
  if (venueAt < 0) throw new UnreadableEmail('No event on the receipt.');
  const dated = Boolean(dateFields(lines[venueAt - 1], sentAt).startDate);
  const nameAt = dated ? venueAt - 2 : venueAt - 1;
  if (nameAt < 0) throw new UnreadableEmail('No event on the receipt.');
  return {
    name: named(lines[nameAt]),
    ...(dated ? dateFields(lines[venueAt - 1], sentAt) : {}),
    venue: venueFrom(lines[venueAt].replace(/^at\s+/i, '')),
    city: lines
      .slice(venueAt + 1, venueAt + 4)
      .map((l) => cityFrom(l))
      .find(Boolean),
    total: money(lines.find((l) => /^Total:/i.test(l))),
  };
}

function tickets(lines: string[], sentAt: string): Omit<ReadEmail, 'kind'> {
  const at = lines.findIndex((l) => /^order details$/i.test(l));
  if (at < 0) throw new UnreadableEmail('The ticket card was not found.');
  const d = lines.slice(at + 2, at + 6).findIndex((l) => dateFields(l, sentAt).startDate);
  if (d < 0) throw new UnreadableEmail('No event date on the ticket.');
  const dateAt = at + 2 + d;
  const v = /^show time/i.test(lines[dateAt + 1] ?? '') ? dateAt + 2 : dateAt + 1;
  const of = lines.map((l) => l.match(/^\d+ of (\d+)$/)?.[1]).filter(Boolean);
  return {
    name: named(lines[at + 1]),
    ...dateFields(lines[dateAt], sentAt),
    venue: cityFromAddress(lines[v]) ? undefined : venueFrom(lines[v]),
    city: lines
      .slice(v, v + 3)
      .map((l) => cityFromAddress(l))
      .find(Boolean),
    tickets: of.length ? Number(of[of.length - 1]) : undefined,
  };
}
