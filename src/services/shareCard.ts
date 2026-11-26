// Event cards: what one shared card prints, and which events can have one.
// Pure code: no React, no DOM, no I/O, no clock. Callers pass `today` in.
// Docs: docs/specs/ticket-stub.md (Rules: Nothing invented, Private).
//
// Private fields (companions, price, rating, notes, order, seller, ticket
// count, admit) are never read here, and CardContent has no place to carry
// them. Only the stub's Went stamp, shorthand code and barcode are drawn there.

import type { LoggedEvent } from '../server/events/types';
import { wentTo } from '../server/events/attendance';
import { cityWithRegion } from '../server/events/regions';
import { eventYear, placeLabel, whenLabel } from './format';
import { barcodeBars, shortDate, shorthand, ticketLines } from './ticket';

export interface CardOptions {
  acts: boolean;
  exactDates: boolean;
  venue: boolean;
}

export interface CardContent {
  kicker: string;
  big: string[];
  eventLine?: string;
  small?: string;
  when?: string;
  where?: string;
  stub: {
    shortDate?: string[];
    went: true;
    code: string;
    bars: number[];
  };
}

// The date a card sorts by: its start date, else its year and month, else its year.
function sortKey(e: Pick<LoggedEvent, 'startDate' | 'year' | 'month'>): string {
  if (e.startDate) return e.startDate;
  if (e.year && e.month) return `${e.year}-${String(e.month).padStart(2, '0')}-01`;
  if (e.year) return `${e.year}-01-01`;
  return '';
}

// The content of one card. The option switches only remove lines; nothing is
// added that the event does not store.
export function cardContent(event: LoggedEvent, opts: CardOptions): CardContent {
  const year = eventYear(event);
  const kicker = year ? `LiveArchive · ${year}` : 'LiveArchive';

  let big: string[];
  let eventLine: string | undefined;
  let small: string | undefined;
  if (opts.acts) {
    const lines = ticketLines(
      event.name,
      event.seen.map((s) => ({ name: s.name, role: s.role })),
    );
    big = lines.big;
    eventLine = lines.showEventLine ? event.name : undefined;
    small =
      [lines.small.join(', '), lines.moreHeadliners > 0 ? `+${lines.moreHeadliners} more` : '']
        .filter(Boolean)
        .join(' · ') || undefined;
  } else {
    big = [event.name];
  }

  const when = opts.exactDates ? whenLabel(event) ?? undefined : year ? String(year) : undefined;
  const where = opts.venue
    ? placeLabel(event) ?? undefined
    : cityWithRegion(event.city, event.region) || undefined;
  const sd = opts.exactDates ? shortDate(event) : null;

  return {
    kicker,
    big,
    ...(eventLine !== undefined ? { eventLine } : {}),
    ...(small !== undefined ? { small } : {}),
    ...(when !== undefined ? { when } : {}),
    ...(where !== undefined ? { where } : {}),
    stub: {
      ...(sd ? { shortDate: sd } : {}),
      went: true,
      code: shorthand(event.name),
      bars: barcodeBars(event.id),
    },
  };
}

// The events you went to, newest first. Undated ones come last.
export function cardEvents(events: LoggedEvent[], today: string): LoggedEvent[] {
  return wentTo(events, today).sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });
}

// A plain sentence for the canvas's aria-label, built from the same content as the drawing.
export function cardText(c: CardContent): string {
  const parts = [c.kicker, c.big.join(' & '), c.eventLine, c.small, c.when, c.where];
  if (c.stub.shortDate) parts.push(c.stub.shortDate.join(' '));
  parts.push('Went');
  return parts.filter((p): p is string => Boolean(p)).join('. ');
}

// "livearchive-<slug>-<date>.png", with the date as yyyy-mm-dd or yyyy when known.
export function cardFileName(event: Pick<LoggedEvent, 'name' | 'startDate' | 'year'>): string {
  const slug =
    event.name
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'event';
  const date = event.startDate ?? (event.year ? String(event.year) : '');
  return date ? `livearchive-${slug}-${date}.png` : `livearchive-${slug}.png`;
}

// The cards whose name, acts, venue, city, region, country or year contain
// every word of the search, ignoring case and accents. An empty search keeps all.
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function searchCards(events: LoggedEvent[], query: string): LoggedEvent[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return events;
  return events.filter((e) => {
    const year = eventYear(e);
    const text = fold(
      [e.name, ...e.seen.map((s) => s.name), e.venue, e.city, e.region, e.country, year ? String(year) : '', e.startDate, e.endDate]
        .filter(Boolean)
        .join(' '),
    );
    return words.every((w) => text.includes(w));
  });
}
