import { fromDomain } from './text';
import { cityFrom, dateFields, money, quoted, subjectAfter, venueFrom, withoutTicketType } from './read';
import type { EmailReader, Quoted, ReadEmail } from './types';

// AXS mail comes in several layouts. A ticket a friend sent you counts like
// one you bought: whether you went is yours to say on review.
// - "Thank you for your order for <event>": "Order details for <event> at
//   <venue> scheduled on 10/1/2026 8:00 PM".
// - "Thank you for your Order for <event>" (festival box office, 2026):
//   the order date, the event, then "Fri" / "April 9 -" / "12:00 PM".
// - "Thank you for your order for GA" (festival box office, 2023 to 2025):
//   "TICKET DETAILS" and the event, then its date on some ("Saturday,
//   October 19, 2024 4:00 PM").
// - "Your tickets were delivered" and "You Received Tickets": the date, the
//   event, then "Venue, City, ST". Before 2025 the delivery email named no
//   event and is not read.
// - "Tickets Just Got Sent To You" (until 2025): one sentence, "... to you
//   for <event> at <venue>, <City>, <ST> on Friday 9-22-23 at 6:45 pm".
// Resale listings and the like are not read.

// A numeric US date ("10/1/2026", "9-22-23") with the weekday checked
// when one is given.
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function numericDate(text: string, weekday?: string): Quoted | undefined {
  const m = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})\b/);
  if (!m) return undefined;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(Date.UTC(year, Number(m[1]) - 1, Number(m[2])));
  if (d.getUTCMonth() !== Number(m[1]) - 1 || d.getUTCDate() !== Number(m[2])) return undefined;
  if (weekday && WEEKDAYS.indexOf(weekday.slice(0, 3).toLowerCase()) !== d.getUTCDay()) return undefined;
  return quoted(d.toISOString().slice(0, 10), weekday ? `${weekday} ${m[0]}` : m[0]);
}

const named = (value: string, quote: string) => quoted(withoutTicketType(value), quote);

// "Venue, City, ST": the venue is everything before the city.
function place(line: string): Pick<ReadEmail, 'venue' | 'city'> {
  const m = line.match(/^(.+),\s*([^,]+,\s*[A-Z]{2})$/);
  if (!m) return {};
  return {
    venue: venueFrom(m[1]) && quoted(m[1].trim(), line),
    city: cityFrom(m[2]) && quoted(cityFrom(m[2])!.value, line),
  };
}

export const axs: EmailReader = {
  seller: 'AXS',
  domain: 'axs.com',
  matches: (from) => fromDomain(from, 'axs.com'),
  read(email, lines) {
    if (/^Thank you for your order for /i.test(email.subject)) return order(email.subject, lines, email.sentAt);
    if (/^(Your tickets were delivered|You Received Tickets)/i.test(email.subject)) return delivered(lines, email.sentAt);
    if (/^Tickets Just Got Sent To You/i.test(email.subject)) return sentToYou(lines);
    return null;
  },
};

function order(subject: string, lines: string[], sentAt: string): ReadEmail | null {
  const confirmation = lines.map((l) => l.match(/confirmation number is\s*#?(\d+)/i)?.[1] ?? l.match(/^#(\d+)$/)?.[1]).find(Boolean);
  const total = money(lines[lines.findIndex((l) => /^(Grand Total|Order Total|Total):?$/i.test(l)) + 1]);
  const details = lines.find((l) => /^Order details for .+ scheduled on /i.test(l));
  if (details) {
    const m = details.match(/^Order details for (.+?) at (.+?) scheduled on (.+)$/i);
    const event = m?.[1] ?? details.match(/^Order details for (.+?) scheduled on /i)![1];
    return {
      kind: 'order',
      name: named(event, details),
      startDate: numericDate(m?.[3] ?? details),
      venue: m ? quoted(m[2], details) : undefined,
      orderId: confirmation,
      total,
    };
  }
  // Festival box office, 2026: the line after the order date.
  const placed = lines.findIndex((l) => /^\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2} [AP]M$/i.test(l));
  if (placed >= 0 && /^(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/i.test(lines[placed + 2] ?? '')) {
    const when = lines.slice(placed + 2, placed + 5).join(' ');
    return {
      kind: 'order',
      name: named(lines[placed + 1], lines[placed + 1]),
      ...dateFields(when, sentAt),
      orderId: confirmation,
      total,
    };
  }
  const ticketDetails = lines.findIndex((l) => /^ticket details$/i.test(l));
  if (ticketDetails >= 0) {
    const event = lines[ticketDetails + 1];
    return {
      kind: 'order',
      name: named(event, event),
      ...dateFields(lines[ticketDetails + 2] ?? '', sentAt),
      orderId: confirmation,
      total,
    };
  }
  const event = subjectAfter(subject, /^Thank you for your order for\s+(.+)$/i);
  return event
    ? {
        kind: 'order',
        name: named(event, subject),
        orderId: confirmation,
        total,
      }
    : null;
}

function delivered(lines: string[], sentAt: string): ReadEmail | null {
  const d = lines.findIndex((l, i) => dateFields(l, sentAt).startDate && /,\s*[A-Z]{2}$/.test(lines[i + 2] ?? ''));
  if (d < 0) return null; // the older delivery email names no event
  const count = lines.map((l) => l.match(/transferred (\d+) tickets? to you/i)?.[1]).find(Boolean);
  return {
    kind: 'order',
    name: named(lines[d + 1], lines[d + 1]),
    ...dateFields(lines[d], sentAt),
    ...place(lines[d + 2]),
    tickets: count ? Number(count) : undefined,
  };
}

function sentToYou(lines: string[]): ReadEmail | null {
  const line = lines.find((l) => /transferred \d+ tickets? to you for /i.test(l));
  const m = line?.match(
    /transferred (\d+) tickets? to you for (.+?) at (.+?),\s*([^,]+,\s*[A-Z]{2}) on ([A-Za-z]+) (\d{1,2}-\d{1,2}-\d{2,4})/i,
  );
  if (!line || !m) return null;
  return {
    kind: 'order',
    name: named(m[2], line),
    startDate: numericDate(m[6], m[5]),
    venue: venueFrom(m[3]) && quoted(m[3], line),
    city: cityFrom(m[4]) && quoted(cityFrom(m[4])!.value, line),
    tickets: Number(m[1]),
  };
}
