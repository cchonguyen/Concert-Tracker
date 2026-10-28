import { fromDomain } from '../text.ts';
import { dateFields, money, quoted, valueAfter } from '../read.ts';
import type { EmailReader, ReadEmail } from '../readerTypes.ts';
import { UnreadableEmail } from '../readerTypes.ts';

// Brown Paper Tickets "[Brown Paper Tickets] Order Confirmation": plain text
// under "2. Ticket Details", one block per ticket, each with "Event:" and
// "Start Date:" ("Sun Mar 03, 2024 5:00 PM"). The venue is not in the body,
// so it is left out. "Tickets Purchased:" counts the tickets; "Amount Paid:"
// is "Free" or a dollar total.
export const brownPaperTickets: EmailReader = {
  seller: 'Brown Paper Tickets',
  domain: 'brownpapertickets.com',
  matches: (from) => fromDomain(from, 'brownpapertickets.com'),
  read(email, lines) {
    if (!/^\[Brown Paper Tickets\] Order Confirmation$/i.test(email.subject.trim())) return null;
    const event = valueAfter(lines, 'Event:');
    const start = valueAfter(lines, 'Start Date:');
    if (!event || !start) throw new UnreadableEmail('No event and start date in the ticket details.');
    const date = dateFields(start.value, email.sentAt);
    if (!date.startDate && !date.dateText) throw new UnreadableEmail('No readable start date.');
    const count = Number(valueAfter(lines, 'Tickets Purchased:')?.value);
    const paid = valueAfter(lines, 'Amount Paid:')?.value;
    return {
      kind: 'order',
      name: quoted(event.value, lines[event.at]),
      ...date,
      orderId: valueAfter(lines, 'Confirmation Number:')?.value,
      tickets: Number.isInteger(count) && count > 0 ? count : undefined,
      total: paid && /^\$/.test(paid) ? money(paid) : undefined,
    } satisfies ReadEmail;
  },
};
