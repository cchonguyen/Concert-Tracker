// Layer 4: a reader for ticket mail no seller reader covers (box offices,
// regional promoters, boutique sellers). Plain code over labeled lines; no
// model. A message passes only with an order anchor, and every value is
// copied from a line of the message.

import { cityFromAddress, cityFrom, dateFields, money, quoted, valueAfter, venueFrom } from './read.ts';
import type { ReadEmail } from './readerTypes.ts';
import { UnreadableEmail } from './readerTypes.ts';
import type { RawEmailMessage } from './types.ts';

// Words that show a transaction rather than an ad.
const ANCHOR = /\b(order\s*(?:#|number|no\b|id)|confirmation\s*#|confirmation number|receipt|ticket\s*#|total paid|you're going to|you are going to|your tickets for|qty)\b/i;
// Mail that is not a concert ticket even when it has an anchor.
const NOT_A_SHOW = /\b(boarding pass|airline|flight|cinema|movie|fandango|showtimes?|parking(?:\s+(?:pass|only|receipt|reservation))|shuttle)\b/i;
const MARKETING = /\b(on sale now|presale code|win tickets|last chance|newsletter|unsubscribe)\b/i;
const TICKET_SUBJECT = /\b(tickets?|order confirmation|your order|e-?ticket|wristband|guestlist|rsvp|you're going|you got tickets)\b/i;

export const hasTicketSubject = (subject: string) => TICKET_SUBJECT.test(subject);

// "Label: value" on one line, or "Label" with its value on the next line.
function labeled(lines: string[], labels: string[]): { value: string; quote: string } | undefined {
  for (const label of labels) {
    const same = lines.find((l) => new RegExp(`^${label}\\s*:\\s*\\S`, 'i').test(l));
    if (same) return { value: same.replace(new RegExp(`^${label}\\s*:\\s*`, 'i'), '').trim(), quote: same };
    const next = valueAfter(lines, label) ?? valueAfter(lines, `${label}:`);
    if (next?.value) return { value: next.value, quote: next.value };
  }
  return undefined;
}

// Returns null for mail that is not a show (ads, other kinds of tickets);
// throws UnreadableEmail for a ticket subject whose body gives no name and date.
export function readVerbatim(email: RawEmailMessage, lines: string[]): ReadEmail | null {
  const body = lines.join('\n');
  if (NOT_A_SHOW.test(email.subject) || NOT_A_SHOW.test(email.from) || NOT_A_SHOW.test(lines.slice(0, 12).join(' '))) return null;
  const anchored = ANCHOR.test(body) || ANCHOR.test(email.subject);
  if (!anchored) {
    if (hasTicketSubject(email.subject) && !MARKETING.test(email.subject)) throw new UnreadableEmail('No order or confirmation marker.');
    return null;
  }

  // "Your tickets for <Event> at <Venue>" headline, or labeled Event/Show/Artist.
  const headline = lines.map((l) => l.match(/^(?:Your tickets for|You're going to|You are going to)\s+(.+?)(?:\s+at\s+(.+))?$/i)).find(Boolean);
  const event = labeled(lines, ['Event', 'Show', 'Artist']);
  const nameValue = headline?.[1]?.trim() ?? event?.value;
  const nameQuote = headline ? headline[0] : event?.quote;
  if (!nameValue || !nameQuote) throw new UnreadableEmail('No event name line.');

  const when = labeled(lines, ['Date', 'When', 'Date & time']);
  const date = when ? dateFields(when.value, email.sentAt) : {};
  if (!date.startDate && !date.dateText) throw new UnreadableEmail('No readable event date.');

  const venueLine = labeled(lines, ['Venue', 'Where', 'Location']);
  const total = labeled(lines, ['Total', 'Total Paid', 'Order Total']);
  const qty = labeled(lines, ['Tickets', 'Qty', 'Quantity']);
  const venueText = headline?.[2]?.trim() ?? venueLine?.value;
  const order = lines.find((l) => /^(?:order|confirmation)\s*(?:#|number|id)?\s*:?\s*[A-Z0-9-]{5,}$/i.test(l));
  const tickets = qty ? Number(qty.value.match(/^(\d+)\b/)?.[1]) : NaN;

  return {
    kind: 'order',
    name: quoted(nameValue, nameQuote),
    ...date,
    venue: venueFrom(venueText),
    city: cityFromAddress(venueLine ? lines[lines.indexOf(venueLine.quote) + 1] : undefined) ?? cityFrom(labeled(lines, ['City'])?.value),
    orderId: order?.replace(/^(?:order|confirmation)\s*(?:#|number|id)?\s*:?\s*/i, ''),
    tickets: Number.isFinite(tickets) && tickets > 0 ? tickets : undefined,
    total: money(total?.value),
  };
}
