import type { EmailImport } from './types';

// The ticket facts an event's detail shows from the email import it came from
// (or was merged into). Only these three: never the total, price, names or messages.
export interface TicketFacts {
  seller?: string;
  orderLast4?: string;
  tickets?: number;
}

const time = (v: string) => {
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
};

export function ticketFactsFor(imports: EmailImport[], eventId: string): TicketFacts | null {
  const candidates = imports.filter((r) => r.eventId === eventId && r.status === 'added');
  if (!candidates.length) return null;
  const row = [...candidates].sort((a, b) => time(b.updatedAt) - time(a.updatedAt))[0];

  const facts: TicketFacts = {};
  const seller = typeof row.seller === 'string' ? row.seller.trim() : '';
  if (seller) facts.seller = seller;

  const order = (row.orderIds ?? []).find((id) => typeof id === 'string' && id.trim() !== '');
  if (order !== undefined) {
    const alnum = order.replace(/[^A-Za-z0-9]/g, '');
    if (alnum.length >= 4) facts.orderLast4 = alnum.slice(-4);
  }

  if (typeof row.tickets === 'number' && Number.isInteger(row.tickets) && row.tickets > 0) facts.tickets = row.tickets;

  return facts.seller || facts.orderLast4 || facts.tickets !== undefined ? facts : null;
}
