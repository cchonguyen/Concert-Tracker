import { randomUUID } from 'node:crypto';
import { normalizeName } from '../../lineup/text';
import type { LoggedEvent } from '../types';
import { dice } from './dice';
import { eventbrite } from './eventbrite';
import { residentAdvisor } from './residentAdvisor';
import { emailLines } from './text';
import { ticketmaster } from './ticketmaster';
import { tixr } from './tixr';
import {
  EmailImport,
  EmailKind,
  EmailReader,
  EmailSource,
  ImportField,
  ImportFlag,
  RawEmail,
  ReadEmail,
  UnreadableEmail,
} from './types';

// From raw ticket emails to one review row per show. Nothing here saves an
// event: rows wait for you to tick "I went" (addImports).

export const READERS: EmailReader[] = [ticketmaster, tixr, dice, residentAdvisor, eventbrite];

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
  for (const email of emails) {
    const reader = READERS.find((r) => r.matches(email.from));
    if (!reader) {
      ignored++;
      continue;
    }
    try {
      const read = reader.read(email, emailLines(email));
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
  const set = (field: ImportField, value: { value: string; quote: string } | undefined) => {
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
      row.name = o.email.subject;
      row.messages.push(message(o.email));
      touch(row);
      continue;
    }
    if (o.read.kind !== 'order') continue;
    const key = importKey(o.seller, o.read);
    const row = byKey.get(key) ?? blank(key, o.seller, iso);
    if (known(row, o.email.id)) continue;
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
  for (const pending of byKey.values()) {
    if (pending.status !== 'flag') continue;
    for (const row of byKey.values()) {
      if (row.status === 'flag' || row.status === 'unreadable' || row.seller !== pending.seller) continue;
      if (!row.name || flagKey(row.seller, row.name) !== pending.key) continue;
      const before = row.flags.length + row.messages.length;
      for (const f of pending.flags) if (!row.flags.includes(f)) row.flags.push(f);
      for (const m of pending.messages) if (!known(row, m.id)) row.messages.push(m);
      if (row.flags.length + row.messages.length !== before) touch(row);
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
    createdAt: iso,
    updatedAt: iso,
  };
}

// What the review screen lists, newest first; kept-aside flags stay hidden.
export function reviewList(rows: EmailImport[]): EmailImport[] {
  const when = (r: EmailImport) => r.startDate ?? '0000';
  return rows
    .filter((r) => r.status !== 'flag')
    .sort((a, b) => when(b).localeCompare(when(a)) || b.createdAt.localeCompare(a.createdAt));
}
