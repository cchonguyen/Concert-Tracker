import { fromDomain } from '../text.ts';
import { dateFields, quoted, subjectAfter, valueAfter } from '../read.ts';
import type { EmailReader, ReadEmail } from '../readerTypes.ts';
import { UnreadableEmail } from '../readerTypes.ts';

// Sickening.events "Ticket: <event>" and "Order Confirmation: <event>" (2026).
// The HTML part has the date line ("Oct 3, 2026 at 10:00 PM to Oct 4, 2026")
// directly above the event name. No venue or address appears in this layout,
// so the venue is left out. "Complimentary Ticket:" mail has no order card
// and is not read.
const DATE_LINE = /^[A-Z][a-z]{2} \d{1,2}, \d{4} at \d{1,2}:\d{2} [AP]M to [A-Z][a-z]{2} \d{1,2}, \d{4}/;

export const sickeningEvents: EmailReader = {
  seller: 'Sickening.events',
  domain: 'sickening.events',
  matches: (from) => fromDomain(from, 'sickening.events'),
  read(email, lines) {
    const name = subjectAfter(email.subject, /^(?:Ticket|Order Confirmation):\s+(.+)$/i);
    if (!name) return null;
    const at = lines.findIndex((l) => DATE_LINE.test(l));
    if (at < 0) throw new UnreadableEmail('No date line in the ticket card.');
    const date = dateFields(lines[at], email.sentAt);
    if (!date.startDate) throw new UnreadableEmail('No readable start date.');
    const order = valueAfter(lines, 'Order ID');
    return {
      kind: 'order',
      name: quoted(name.trim(), lines.find((l) => l.includes(name.trim())) ?? name.trim()),
      ...date,
      orderId: order?.value,
    } satisfies ReadEmail;
  },
};
