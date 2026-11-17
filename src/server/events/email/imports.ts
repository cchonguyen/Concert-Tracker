import { randomUUID } from 'node:crypto';
import { normalizeName } from '../../lineup/text';
import type { LoggedEvent } from '../types';
import { isAhead } from '../attendance';
import { cityWithRegion, splitEventCity } from '../regions';
import { axs } from './axs';
import { dice } from './dice';
import { eventbrite } from './eventbrite';
import { unwrapForward } from './forwarded';
import { frontGate } from './frontGate';
import { liveNation } from './liveNation';
import { residentAdvisor } from './residentAdvisor';
import { emailLines } from './text';
import { ticketmaster } from './ticketmaster';
import { ticketWeb } from './ticketWeb';
import { tixr } from './tixr';
import {
  EmailImport,
  EmailKind,
  EmailReader,
  EmailSource,
  ImportField,
  ImportFlag,
  MergeField,
  RawEmail,
  ReadEmail,
  UnreadableEmail,
} from './types';

// From raw ticket emails to one review row per show. Nothing here saves an
// event: rows wait for you to tick "I went" (addImports).

export const READERS: EmailReader[] = [ticketmaster, liveNation, tixr, dice, residentAdvisor, eventbrite, axs, frontGate, ticketWeb];

export type ReadOutcome =
  | { email: RawEmail; seller: string; read: ReadEmail }
  | { email: RawEmail; seller: string; unreadable: string };

export interface ReadSummary {
  outcomes: ReadOutcome[];
  ignored: number; // ads, reminders and mail from senders without a reader
}

export function readEmails(emails: RawEmail[]): ReadSummary {
  const outcomes: ReadOutcome[] = [];
  let ignored = 0;
  for (const raw of emails) {
    let email = raw;
    let lines = emailLines(raw);
    let reader = READERS.find((r) => r.matches(email.from));
    // Forwarded to you: read the original by its own seller's reader.
    const forwarded = reader ? null : unwrapForward(raw, lines);
    if (forwarded) {
      email = forwarded.email;
      lines = forwarded.lines;
      reader = READERS.find((r) => r.matches(email.from));
    }
    if (!reader) {
      ignored++;
      continue;
    }
    try {
      // Without the original's send date, a date written without a year
      // could land in the wrong year, so the forward is not read.
      if (forwarded && !forwarded.dated) throw new UnreadableEmail('The forward does not say when the original was sent.');
      const read = reader.read(email, lines);
      if (read) outcomes.push({ email, seller: reader.seller, read });
      else ignored++;
    } catch (err) {
      if (!(err instanceof UnreadableEmail)) throw err;
      outcomes.push({ email, seller: reader.seller, unreadable: err.message });
    }
  }
  return { outcomes, ignored };
}

const FLAG: Record<Exclude<EmailKind, 'order'>, ImportFlag> = {
  refund: 'refunded',
  cancelled: 'cancelled',
  transferred_away: 'transferred_away',
};

// Several emails about one show (two orders, a resend) share a key: the
// name and date when the date is known, else the seller's order number.
export function importKey(seller: string, read: ReadEmail): string {
  const name = normalizeName(read.name.value);
  if (read.startDate) return `${name}|${read.startDate.value}`;
  if (read.orderId) return `${normalizeName(seller)}|order|${read.orderId}`;
  return `${name}|${read.dateText ?? ''}`;
}

const flagKey = (seller: string, name: string) => `flag|${normalizeName(seller)}|${normalizeName(name)}`;

function message(email: RawEmail, kind?: EmailKind): EmailImport['messages'][number] {
  return { id: email.id, link: email.link, subject: email.subject, sentAt: email.sentAt, kind };
}

function source(email: RawEmail, quote: string): EmailSource {
  return { messageId: email.id, link: email.link, quote };
}

function blank(key: string, seller: string, now: string): EmailImport {
  return { id: randomUUID(), key, status: 'new', seller, sources: {}, messages: [], flags: [], createdAt: now, updatedAt: now };
}

// Fills only what the row does not have yet, each value with its quote.
function fill(row: EmailImport, read: ReadEmail, email: RawEmail): void {
  const set = (field: Exclude<ImportField, 'ticketPrice'>, value: { value: string; quote: string } | undefined) => {
    if (!value || row[field]) return;
    row[field] = value.value;
    row.sources[field] = source(email, value.quote);
  };
  set('name', read.name);
  set('startDate', read.startDate);
  set('endDate', read.endDate);
  set('venue', read.venue);
  set('city', read.city);
  if (!row.startDate && !row.dateText && read.dateText) row.dateText = read.dateText;
  if (read.tickets && (!row.tickets || read.tickets > row.tickets)) row.tickets = read.tickets;
  row.total ??= read.total;
  fillPrice(row, read, email);
}

// The first email that gives one ticket's cost sets the row's price.
export function fillPrice(row: EmailImport, read: ReadEmail, email: RawEmail): boolean {
  const price = ticketPriceOf(read);
  if (!price || row.ticketPrice !== undefined) return false;
  row.ticketPrice = price.value;
  row.sources.ticketPrice = source(email, price.quote);
  return true;
}

// One ticket's cost, when the same email gives a dollar total (fees in) and
// how many tickets it covers. Other currencies are left out: the price has
// no currency of its own.
export function ticketPriceOf(read: ReadEmail): { value: number; quote: string } | undefined {
  const total = read.total?.match(/^\$([\d,]+(?:\.\d{2})?)$/)?.[1] ?? (/^free$/i.test(read.total ?? '') ? '0' : undefined);
  if (total === undefined || !read.tickets) return undefined;
  const value = Math.round((Number(total.replace(/,/g, '')) / read.tickets) * 100) / 100;
  if (!Number.isFinite(value)) return undefined;
  return { value, quote: `${read.total} for ${read.tickets} ticket${read.tickets === 1 ? '' : 's'}` };
}

// Events in your log that have no price yet take the one an email about
// them gives (a show you added from email, or one you typed that an email
// was matched to). A price you typed or cleared is never replaced.
export function pricesFromImports(rows: EmailImport[], events: LoggedEvent[], now: Date): LoggedEvent[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const changed = new Map<string, LoggedEvent>();
  for (const row of rows) {
    if (row.status !== 'new' && row.status !== 'added') continue;
    const event = row.eventId ? (changed.get(row.eventId) ?? byId.get(row.eventId)) : undefined;
    const s = row.sources.ticketPrice;
    if (!event || row.ticketPrice === undefined || !s || event.ticketPrice !== undefined || event.sources.ticketPrice) continue;
    changed.set(event.id, {
      ...event,
      ticketPrice: row.ticketPrice,
      sources: { ...event.sources, ticketPrice: { sourceType: 'email', sourceUrl: s.link, quote: s.quote } },
      updatedAt: now.toISOString(),
    });
  }
  return [...changed.values()];
}

// The same show already in your log: same date and the same name, or one
// name containing the other ("Robyn" and "Robyn - The Sexistential Tour").
export function findLogged(row: EmailImport, events: LoggedEvent[]): LoggedEvent | undefined {
  if (!row.startDate || !row.name) return undefined;
  const name = normalizeName(row.name);
  return events.find((e) => {
    if (e.startDate !== row.startDate) return false;
    const other = normalizeName(e.name);
    return other === name || ` ${name} `.includes(` ${other} `) || ` ${other} `.includes(` ${name} `);
  });
}

// Folds what was read into the stored rows. Returns the rows that changed.
export function mergeImports(existing: EmailImport[], outcomes: ReadOutcome[], events: LoggedEvent[], now: Date): EmailImport[] {
  const iso = now.toISOString();
  const byKey = new Map(existing.map((r) => [r.key, r]));
  const changed = new Set<EmailImport>();
  const touch = (row: EmailImport) => {
    row.updatedAt = iso;
    byKey.set(row.key, row);
    changed.add(row);
  };
  const known = (row: EmailImport, id: string) => row.messages.some((m) => m.id === id);

  for (const o of outcomes) {
    if ('unreadable' in o) {
      const key = `unreadable|${o.email.id}`;
      if (byKey.has(key)) continue;
      const row = blank(key, o.seller, iso);
      row.status = 'unreadable';
      row.unreadableReason = o.unreadable;
      row.name = o.email.subject;
      row.messages.push(message(o.email));
      touch(row);
      continue;
    }
    if (o.read.kind !== 'order') continue;
    // The receipt and the tickets for one order can name the show
    // differently ("Second Show Added!", "(Saturday)"); one order on one date
    // is one show.
    const key = importKey(o.seller, o.read);
    const orderId = o.read.orderId;
    const date = o.read.startDate?.value;
    const sameOrder = orderId
      ? [...byKey.values()].find(
          (r) =>
            r.seller === o.seller &&
            r.status !== 'unreadable' &&
            r.orderIds?.includes(orderId) &&
            (!r.startDate || !date || r.startDate === date),
        )
      : undefined;
    const row = byKey.get(key) ?? sameOrder ?? blank(key, o.seller, iso);
    if (known(row, o.email.id)) continue;
    if (orderId && !row.orderIds?.includes(orderId)) row.orderIds = [...(row.orderIds ?? []), orderId];
    row.messages.push(message(o.email, 'order'));
    fill(row, o.read, o.email);
    if (row.status === 'new' && !row.eventId) row.eventId = findLogged(row, events)?.id;
    touch(row);
  }

  // Refunds and the like mark the show they are about. One that arrives
  // before its order is kept aside until the order is read.
  for (const o of outcomes) {
    if ('unreadable' in o || o.read.kind === 'order') continue;
    const fk = flagKey(o.seller, o.read.name.value);
    const pending = byKey.get(fk) ?? { ...blank(fk, o.seller, iso), status: 'flag' as const, name: o.read.name.value };
    if (known(pending, o.email.id)) continue;
    pending.messages.push(message(o.email, o.read.kind));
    const flag = FLAG[o.read.kind];
    if (!pending.flags.includes(flag)) pending.flags.push(flag);
    touch(pending);
  }
  // A seller can sell the same name many times (a monthly club night), so
  // each refund marks only the show whose latest order came before it.
  for (const pending of [...byKey.values()]) {
    if (pending.status !== 'flag') continue;
    const shows = [...byKey.values()].filter(
      (row) =>
        row.status !== 'flag' &&
        row.status !== 'unreadable' &&
        row.seller === pending.seller &&
        Boolean(row.name) &&
        flagKey(row.seller, row.name!) === pending.key,
    );
    for (const m of pending.messages) {
      if (!m.kind || m.kind === 'order') continue;
      const orderedBefore = (row: EmailImport) =>
        row.messages.filter((o) => o.kind === 'order' && o.sentAt <= m.sentAt).reduce((last, o) => (o.sentAt > last ? o.sentAt : last), '');
      const row = shows.reduce<EmailImport | undefined>((best, r) => {
        const at = orderedBefore(r);
        return at && (!best || at > orderedBefore(best)) ? r : best;
      }, undefined);
      if (!row || known(row, m.id)) continue;
      row.messages.push(m);
      const flag = FLAG[m.kind];
      if (!row.flags.includes(flag)) row.flags.push(flag);
      touch(row);
    }
  }
  return [...changed];
}

// Your ticks become events: each field sourced to the email and the words
// it came from. Rows already in your log are not added again.
export function eventFromImport(row: EmailImport, now: Date): LoggedEvent {
  if (!row.name) throw new Error('An imported event needs a name.');
  const iso = now.toISOString();
  const sources: LoggedEvent['sources'] = {};
  for (const f of ['startDate', 'endDate', 'venue', 'city'] as const) {
    const s = row.sources[f];
    if (row[f] && s) sources[f] = { sourceType: 'email', sourceUrl: s.link, quote: s.quote };
  }
  const price = row.sources.ticketPrice;
  if (row.ticketPrice !== undefined && price) sources.ticketPrice = { sourceType: 'email', sourceUrl: price.link, quote: price.quote };
  return {
    id: randomUUID(),
    input: row.name,
    name: row.name,
    year: row.startDate ? Number(row.startDate.slice(0, 4)) : undefined,
    startDate: row.startDate,
    endDate: row.endDate,
    venue: row.venue,
    city: row.city,
    sources,
    details: row.startDate
      ? { status: 'resolved', candidates: [], notes: [`From your ${row.seller} email.`] }
      : { status: 'needs_date', candidates: [], notes: [`From your ${row.seller} email, which gives no full date.`] },
    seen: [],
    daysAttended: [],
    companions: [],
    ticketPrice: row.ticketPrice !== undefined && price ? row.ticketPrice : undefined,
    // A show still ahead is added as upcoming; it counts once you say you went.
    ...(isAhead({ startDate: row.startDate }, iso.slice(0, 10)) ? { attendance: 'planned' as const } : {}),
    createdAt: iso,
    updatedAt: iso,
  };
}

// "Same as one of mine": an email's show merged into an event you entered.
// Only empty fields are filled, each sourced to the email; a field you
// already have keeps your value even when the email says otherwise (it is
// listed as kept, and nothing is overwritten).
export interface MergeResult {
  event: LoggedEvent;
  filled: MergeField[];
  kept: Array<{ field: MergeField; yours: string; email: string }>;
}

export function mergeIntoEvent(row: EmailImport, event: LoggedEvent, now: Date): MergeResult {
  let next: LoggedEvent = { ...event, sources: { ...event.sources } };
  const filled: MergeField[] = [];
  const kept: MergeResult['kept'] = [];
  const fill = (field: MergeField, value: string | number | undefined, same: (a: string) => boolean, yours: string | undefined) => {
    const s = row.sources[field];
    if (value === undefined || value === '' || !s) return false;
    if (yours !== undefined && yours !== '') {
      if (!same(yours)) kept.push({ field, yours, email: String(value) });
      return false;
    }
    (next as any)[field] = value;
    next.sources[field] = { sourceType: 'email', sourceUrl: s.link, quote: s.quote };
    filled.push(field);
    return true;
  };
  const eq = (a: string, b: string) => normalizeName(a) === normalizeName(b);

  // A year you gave that the email's date is not in is a different date.
  const yearClash = row.startDate && !event.startDate && event.year && event.year !== Number(row.startDate.slice(0, 4));
  if (yearClash) kept.push({ field: 'startDate', yours: String(event.year), email: row.startDate! });
  else if (fill('startDate', row.startDate, (a) => a === row.startDate, event.startDate)) {
    next.year = Number(row.startDate!.slice(0, 4));
    next.month = undefined;
  }
  if (next.startDate === row.startDate) fill('endDate', row.endDate, (a) => a === row.endDate, event.endDate);
  fill('venue', row.venue, (a) => eq(a, row.venue!), event.venue);
  const yourCity = cityWithRegion(event.city, event.region);
  if (fill('city', row.city, (a) => eq(a, row.city!) || eq(event.city ?? '', row.city!.split(',')[0]), yourCity || undefined)) {
    next = splitEventCity(next);
  }
  if (!event.sources.ticketPrice && event.ticketPrice === undefined) fill('ticketPrice', row.ticketPrice, () => true, undefined);
  else if (row.ticketPrice !== undefined && event.ticketPrice !== undefined && event.ticketPrice !== row.ticketPrice) {
    kept.push({ field: 'ticketPrice', yours: String(event.ticketPrice), email: String(row.ticketPrice) });
  }
  if (filled.length) next.updatedAt = now.toISOString();
  return { event: filled.length ? next : event, filled, kept };
}

// Undo a merge: each field the email filled is cleared again, unless you
// have changed it since (its source is no longer that email).
export function unmergeFromEvent(row: EmailImport, event: LoggedEvent, now: Date): LoggedEvent {
  const next: LoggedEvent = { ...event, sources: { ...event.sources } };
  let changed = false;
  for (const field of row.mergedFields ?? []) {
    const s = next.sources[field];
    const from = row.sources[field];
    if (!s || s.sourceType !== 'email' || !from || s.quote !== from.quote || s.sourceUrl !== from.link) continue;
    (next as any)[field] = undefined;
    delete next.sources[field];
    if (field === 'city') {
      for (const part of ['region', 'country'] as const) {
        const p = next.sources[part];
        if (p?.sourceType === 'email' && p.quote === from.quote) {
          next[part] = undefined;
          delete next.sources[part];
        }
      }
    }
    changed = true;
  }
  if (changed) next.updatedAt = now.toISOString();
  return changed ? next : event;
}

// What the review screen lists, newest first. Kept-aside flags stay hidden,
// and so does an email no reader understood once a newer reader has read it
// into a show of its own.
export function reviewList(rows: EmailImport[]): EmailImport[] {
  const when = (r: EmailImport) => r.startDate ?? '0000';
  const read = new Set(rows.filter((r) => r.status !== 'unreadable').flatMap((r) => r.messages.map((m) => m.id)));
  return rows
    .filter((r) => r.status !== 'flag')
    .filter((r) => r.status !== 'unreadable' || !r.messages.every((m) => read.has(m.id)))
    .sort((a, b) => when(b).localeCompare(when(a)) || b.createdAt.localeCompare(a.createdAt));
}
