import { fromDomain } from '../text.ts';
import { cityFrom, dateFields, quoted, subjectAfter, venueFrom } from '../read.ts';
import { gotTickets } from './ticketmaster.ts';
import type { EmailReader } from '../readerTypes.ts';
import { UnreadableEmail } from '../readerTypes.ts';

// Live Nation sells through Ticketmaster and sends two kinds of ticket mail
// (its ads come from the same domain and are not read):
// - "You Just Scored Tickets to <event>": Ticketmaster's order card.
// - "View your mobile tickets for your upcoming event": the event name,
//   then "Mon, Oct 07 @ <venue>, <City>, <ST>" (no year; the weekday gives it).
export const liveNation: EmailReader = {
  seller: 'Live Nation',
  domain: 'livenation.com',
  search: 'subject:("You Just Scored Tickets" OR "View your mobile tickets")',
  matches: (from) => fromDomain(from, 'livenation.com'),
  read(email, lines) {
    const name = subjectAfter(email.subject, /^You Just Scored Tickets to (.+)$/i);
    if (name) return gotTickets(email, lines, name);
    if (!/^View your mobile tickets\b/i.test(email.subject)) return null;
    const at = lines.findIndex((l) => /^[A-Za-z]{3},\s+[A-Za-z]{3}\s+\d{1,2}\s+@\s+.+/.test(l));
    if (at < 1) throw new UnreadableEmail('The event line ("Mon, Oct 07 @ venue") was not found.');
    const [when, where] = lines[at].split(/\s+@\s+/);
    const place = where.match(/^(.+?),\s*([^,]+,\s*[A-Z]{2})$/);
    const venue = venueFrom(place?.[1]);
    const city = cityFrom(place?.[2]);
    return {
      kind: 'order',
      name: quoted(lines[at - 1]),
      ...dateFields(when, email.sentAt),
      venue: venue && quoted(venue.value, lines[at]),
      city: city && quoted(city.value, lines[at]),
    };
  },
};
