import { normalizeName } from '../names.ts';
import { fromDomain } from '../text.ts';
import { cityFromAddress, count, dateFields, money, quoted, same, subjectAfter, valueAfter, venueFrom } from '../read.ts';
import type { EmailReader } from '../readerTypes.ts';
import { UnreadableEmail } from '../readerTypes.ts';

// "Your Tickets for <event>" and "Order Confirmation for <event>". The order
// card has had three layouts:
// - 2019 on: the event name, the tickets and total, the full date, calendar
//   links, then the venue and its address;
// - 2015 to 2018: the order summary, then "About this event" with the date,
//   the venue and its address;
// - 2013: "Your order for <event> is complete!", the date, the event name,
//   then the venue and its address.
const CALENDAR = /^(add to|add to my calendar:?|google|outlook|ical|yahoo|·|\(?view on map\)?)$/i;

const hasDate = (line: string | undefined, sentAt: string) => Boolean(line && dateFields(line, sentAt).startDate);

// Where the date line is, and where the venue starts after it.
function findCard(lines: string[], name: string, sentAt: string): { nameAt: number; dateAt: number; venueAt: number } | undefined {
  const names = lines.flatMap((l, i) => (same(l, name) ? [i] : []));
  for (const at of names) {
    const d = lines.slice(at + 1, at + 6).findIndex((l) => hasDate(l, sentAt));
    if (d >= 0) return { nameAt: at, dateAt: at + 1 + d, venueAt: at + 2 + d };
  }
  for (const at of names) if (hasDate(lines[at - 1], sentAt)) return { nameAt: at, dateAt: at - 1, venueAt: at + 1 };
  const about = lines.findIndex((l) => /^about this event$/i.test(l));
  if (about >= 0 && hasDate(lines[about + 1], sentAt)) return { nameAt: -1, dateAt: about + 1, venueAt: about + 2 };
  return undefined;
}

export const eventbrite: EmailReader = {
  seller: 'Eventbrite',
  domain: 'eventbrite.com',
  matches: (from) => fromDomain(from, 'eventbrite.com'),
  read(email, lines) {
    const name = subjectAfter(email.subject, /^(?:Your Tickets for|Order Confirmation for)\s+(.+)$/i);
    // A shuttle or parking pass sold for a show is not a show.
    if (!name || /\b(shuttles?|parking)\b/i.test(name)) return null;
    // 2015 to 2018 name the event only inside a sentence ("this is your
    // order confirmation for <event>").
    const nameLine = lines.find((l) => same(l, name)) ?? lines.find((l) => ` ${normalizeName(l)} `.includes(` ${normalizeName(name)} `));
    if (!nameLine) throw new UnreadableEmail('The order card was not found.');
    const card = findCard(lines, name, email.sentAt);
    if (!card) throw new UnreadableEmail('No event date on the order card.');
    let v = card.venueAt;
    while (v < lines.length && CALENDAR.test(lines[v])) v++;
    const address = lines.slice(v, v + 4).find((l) => cityFromAddress(l));
    const order = lines.map((l) => l.match(/^(?:Order #:\s*|#)(\d[\d-]*)/)?.[1]).find(Boolean);
    const between = card.nameAt >= 0 && card.nameAt < card.dateAt ? lines.slice(card.nameAt + 1, card.dateAt) : [];
    return {
      kind: 'order',
      name: quoted(name, card.nameAt >= 0 ? lines[card.nameAt] : nameLine),
      ...dateFields(lines[card.dateAt], email.sentAt),
      venue: address === lines[v] ? undefined : venueFrom(lines[v]),
      city: cityFromAddress(address),
      orderId: order,
      tickets: count(between.find((l) => /^\d+\s*x\s/i.test(l))),
      total: money(between.find((l) => /^Order total:/i.test(l)) ?? valueAfter(lines, 'TOTAL')?.value),
    };
  },
};
