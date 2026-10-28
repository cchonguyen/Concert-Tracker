import { fromDomain } from '../text.ts';
import { cityFrom, cityFromAddress, count, dateFields, hasAddOn, labeled, money, quoted, subjectAfter, venueFrom, withoutTicketType } from '../read.ts';
import type { EmailKind, EmailReader } from '../readerTypes.ts';
import { UnreadableEmail } from '../readerTypes.ts';

// A seller whose confirmation is a subject that names the event plus a block
// of labelled rows ("Date: ...", "Venue" / "The Chapel"). The boutique and
// resale readers are configurations of this one reader.
//
// These layouts were written from the sellers' public help pages and sample
// receipts, not from real mail in this project, so they are a starting
// point: replace a layout's labels as soon as a real message disagrees.
export interface LabeledLayout {
  seller: string;
  domains: string[];
  order: RegExp[]; // subjects of an order; group 1 is the event
  refund?: RegExp[];
  cancelled?: RegExp[];
  transferredAway?: RegExp[];
  date: string[];
  venue: string[];
  address?: string[];
  total: string[];
  quantity: string[];
  orderNumber: string[];
}

const DEFAULTS = {
  date: ['Date', 'When', 'Event Date', 'Date & Time', 'Date and Time'],
  venue: ['Venue', 'Where', 'Location'],
  address: ['Address', 'Venue Address'],
  total: ['Total', 'Order Total', 'Total Paid', 'Grand Total', 'Total Charged'],
  quantity: ['Quantity', 'Qty', 'Tickets', 'Number of Tickets'],
  orderNumber: ['Order #', 'Order Number', 'Order ID', 'Confirmation #', 'Confirmation Number'],
};

export function labeledReader(layout: Partial<LabeledLayout> & Pick<LabeledLayout, 'seller' | 'domains' | 'order'>): EmailReader {
  const l = { ...DEFAULTS, ...layout } as LabeledLayout;
  const flags: Array<[EmailKind, RegExp[] | undefined]> = [
    ['refund', l.refund],
    ['cancelled', l.cancelled],
    ['transferred_away', l.transferredAway],
  ];
  return {
    seller: l.seller,
    domain: l.domains[0],
    matches: (from) => l.domains.some((d) => fromDomain(from, d)),
    read(email, lines) {
      for (const [kind, res] of flags) {
        for (const re of res ?? []) {
          const name = subjectAfter(email.subject, re);
          if (name) return { kind, name: quoted(name, email.subject) };
        }
      }
      const raw = l.order.map((re) => subjectAfter(email.subject, re)).find(Boolean);
      if (!raw) return null;
      const name = withoutTicketType(raw);
      const when = labeled(lines, l.date);
      if (!when) throw new UnreadableEmail('No date row.');
      const date = dateFields(when.value, email.sentAt);
      if (!date.startDate && !date.dateText) throw new UnreadableEmail('No readable event date.');
      const venueRow = labeled(lines, l.venue);
      const at = venueRow ? lines.indexOf(venueRow.quote) : -1;
      const addressRow = labeled(lines, l.address!);
      const city = cityFromAddress(addressRow?.value) ?? (at >= 0 ? cityFromAddress(lines[at + 1]) ?? cityFrom(lines[at + 1]) : undefined);
      const qty = labeled(lines, l.quantity);
      const order = labeled(lines, l.orderNumber);
      return {
        kind: 'order',
        name: quoted(name, email.subject),
        ...date,
        venue: venueFrom(venueRow?.value),
        city,
        orderId: order?.value.match(/^[A-Z0-9-]{4,}$/i)?.[0],
        tickets: hasAddOn(lines) ? undefined : count(qty?.value) ?? (qty && /^\d+$/.test(qty.value) ? Number(qty.value) : undefined),
        total: money(labeled(lines, l.total)?.value),
      };
    },
  };
}

