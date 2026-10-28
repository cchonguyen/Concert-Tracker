// RawEmailMessage[] -> EmailImportProposal[]: the whole pipeline, in memory,
// with no storage and no network. Seller readers run first; mail from other
// senders goes to the verbatim reader. Every value that leaves here has a
// quote that is a substring of the message, or it is dropped.

import { normalizeName } from './names.ts';
import { unwrapForward } from './forwarded.ts';
import { dice } from './readers/dice.ts';
import { eventbrite } from './readers/eventbrite.ts';
import { axs } from './readers/axs.ts';
import { frontGate } from './readers/frontGate.ts';
import { liveNation } from './readers/liveNation.ts';
import { residentAdvisor } from './readers/residentAdvisor.ts';
import { ticketmaster } from './readers/ticketmaster.ts';
import { ticketWeb } from './readers/ticketWeb.ts';
import { tixr } from './readers/tixr.ts';
import { hasTicketSubject, readVerbatim } from './verbatimReader.ts';
import type { EmailKind, EmailReader, ReadEmail } from './readerTypes.ts';
import { UnreadableEmail } from './readerTypes.ts';
import { emailLines, senderAddress } from './text.ts';
import type { EmailImportProposal, FieldEvidence, RawEmailMessage } from './types.ts';
import { normalize } from './verbatim.ts';

export const READERS: EmailReader[] = [ticketmaster, liveNation, tixr, dice, residentAdvisor, eventbrite, axs, frontGate, ticketWeb];

type Flag = EmailImportProposal['flags'][number]['kind'];
const FLAG: Record<Exclude<EmailKind, 'order'>, Flag> = { refund: 'refunded', cancelled: 'cancelled', transferred_away: 'transferred' };

interface Outcome {
  email: RawEmailMessage;
  seller: string;
  readBy: FieldEvidence['readBy'];
  lines: string[];
  read?: ReadEmail;
  unreadable?: string;
}

export function readRawEmails(raws: RawEmailMessage[]): EmailImportProposal[] {
  const outcomes: Outcome[] = [];
  for (const raw of raws) {
    let email = raw;
    let lines = emailLines(raw);
    let reader = READERS.find((r) => r.matches(email.from));
    let forwardedFrom = false;
    const forwarded = reader ? null : unwrapForward(raw, lines);
    if (forwarded) {
      email = { ...forwarded.email, link: raw.link, id: raw.id };
      lines = forwarded.lines;
      reader = READERS.find((r) => r.matches(email.from));
      forwardedFrom = true;
      if (!forwarded.dated) {
        outcomes.push({ email, seller: reader?.seller ?? domainOf(email.from), readBy: 'layout', lines, unreadable: 'The forward does not say when the original was sent.' });
        continue;
      }
    }
    const seller = reader?.seller ?? domainOf(email.from);
    const label = forwardedFrom ? `forwarded:${seller}` : seller;
    try {
      const read = reader ? reader.read(email, lines) : readVerbatim(email, lines);
      if (read) outcomes.push({ email, seller: label, readBy: reader ? 'layout' : 'verbatim_heuristic', lines, read });
    } catch (err) {
      if (!(err instanceof UnreadableEmail)) throw err;
      outcomes.push({ email, seller: label, readBy: reader ? 'layout' : 'verbatim_heuristic', lines, unreadable: err.message });
    }
  }
  return group(outcomes);
}

function domainOf(from: string): string {
  return senderAddress(from).split('@')[1]?.replace(/^.*?([^.]+\.[^.]+)$/, '$1') ?? 'unknown';
}

// The source text a quote must occur in: the lines plus the subject.
const sourceOf = (o: Outcome) => [...o.lines, o.email.subject].join('\n');

// A field is kept only when its quote is a substring of the message (words
// as the reader copied them, whitespace and case aside) and, for names and
// venues, the value is a substring of that quote. Dates and cities are read
// from their quote, so only the quote is checked.
function evidence(o: Outcome, value: string, quote: string, valueInQuote: boolean): FieldEvidence | undefined {
  const q = normalize(quote);
  if (!q || !normalize(sourceOf(o)).includes(q)) return undefined;
  if (valueInQuote && !q.includes(normalize(value))) return undefined;
  return { value, quote, messageId: o.email.id, messageLink: o.email.link, readBy: o.readBy };
}

function ticketPrice(o: Outcome, read: ReadEmail): EmailImportProposal['ticketPrice'] {
  const total = read.total?.match(/^\$([\d,]+(?:\.\d{2})?)$/)?.[1] ?? (/^free$/i.test(read.total ?? '') ? '0' : undefined);
  if (total === undefined || !read.tickets) return undefined;
  const sum = Number(total.replace(/,/g, ''));
  const amount = Math.round((sum / read.tickets) * 100) / 100;
  if (!Number.isFinite(amount)) return undefined;
  return { amount, total: sum, count: read.tickets, quote: `${read.total} for ${read.tickets} ticket${read.tickets === 1 ? '' : 's'}`, messageLink: o.email.link };
}

function blank(key: string, seller: string): EmailImportProposal {
  return { key, status: 'new', seller, flags: [], messageLinks: [] };
}

function keyOf(seller: string, read: ReadEmail): string {
  const name = normalizeName(read.name.value);
  if (read.startDate) return `${name}|${read.startDate.value}`;
  if (read.orderId) return `${normalizeName(seller)}|order|${read.orderId}`;
  return `${name}|${read.dateText ?? ''}`;
}

function group(outcomes: Outcome[]): EmailImportProposal[] {
  const byKey = new Map<string, EmailImportProposal>();
  const orders = new Map<string, EmailImportProposal>(); // seller|orderId -> proposal
  const sentAts = new Map<EmailImportProposal, string[]>();
  const seen = new Set<string>();
  const link = (p: EmailImportProposal, o: Outcome) => {
    if (!p.messageLinks.includes(o.email.link)) p.messageLinks.push(o.email.link);
  };

  for (const o of outcomes) {
    if (o.unreadable !== undefined || !o.read) {
      const key = `unreadable|${o.email.id}`;
      if (byKey.has(key)) continue;
      const p = blank(key, o.seller);
      p.status = 'unreadable';
      p.rawSubject = o.email.subject;
      link(p, o);
      byKey.set(key, p);
      continue;
    }
    const read = o.read;
    if (read.kind !== 'order') continue;
    const name = evidence(o, read.name.value, read.name.quote, true);
    if (!name) {
      // The name is not in the message: nothing is claimed.
      const key = `unreadable|${o.email.id}`;
      const p = blank(key, o.seller);
      p.status = 'unreadable';
      p.rawSubject = o.email.subject;
      link(p, o);
      byKey.set(key, p);
      continue;
    }
    const orderKey = read.orderId ? `${o.seller}|${read.orderId}` : undefined;
    const date = read.startDate && evidence(o, read.startDate.value, read.startDate.quote, false);
    const existingByOrder = orderKey ? orders.get(orderKey) : undefined;
    const key = keyOf(o.seller, read);
    const p =
      byKey.get(key) ??
      (existingByOrder && (!existingByOrder.date || !date || existingByOrder.date.value === date.value) ? existingByOrder : undefined) ??
      blank(key, o.seller);
    const dedupe = `${o.email.id}|${p.key}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    p.name ??= name;
    p.date ??= date || undefined;
    p.endDate ??= (read.endDate && evidence(o, read.endDate.value, read.endDate.quote, false)) || undefined;
    p.venue ??= (read.venue && evidence(o, read.venue.value, read.venue.quote, true)) || undefined;
    p.city ??= (read.city && evidence(o, read.city.value, read.city.quote, false)) || undefined;
    if (read.orderId) {
      p.orderNumber ??= read.orderId;
      orders.set(orderKey!, p);
    }
    p.ticketPrice ??= ticketPrice(o, read);
    link(p, o);
    byKey.set(p.key, p);
    sentAts.set(p, [...(sentAts.get(p) ?? []), o.email.sentAt]);
  }

  // Refunds and the like mark the show whose latest order came before them.
  for (const o of outcomes) {
    if (!o.read || o.read.kind === 'order') continue;
    const target = [...byKey.values()]
      .filter((p) => p.status === 'new' && p.seller === o.seller && p.name && normalizeName(p.name.value) === normalizeName(o.read!.name.value))
      .map((p) => ({ p, at: (sentAts.get(p) ?? []).filter((s) => s <= o.email.sentAt).sort().pop() }))
      .filter((x) => x.at)
      .sort((a, b) => (a.at! < b.at! ? 1 : -1))[0]?.p;
    if (target) {
      const kind = FLAG[o.read.kind as Exclude<EmailKind, 'order'>];
      target.flags.push({ kind, quote: o.read.name.quote, messageLink: o.email.link, sentAt: o.email.sentAt });
      link(target, o);
    } else {
      // No order read yet: kept as a flag row so a later scan can attach it.
      const key = `flag|${normalizeName(o.seller)}|${normalizeName(o.read.name.value)}`;
      const p = byKey.get(key) ?? blank(key, o.seller);
      p.status = 'flag';
      p.flags.push({ kind: FLAG[o.read.kind as Exclude<EmailKind, 'order'>], quote: o.read.name.quote, messageLink: o.email.link, sentAt: o.email.sentAt });
      link(p, o);
      byKey.set(key, p);
    }
  }
  return [...byKey.values()];
}

export { hasTicketSubject };
