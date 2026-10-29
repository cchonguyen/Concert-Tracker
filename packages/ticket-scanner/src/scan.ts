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
import { brownPaperTickets } from './readers/brownPaperTickets.ts';
import { sickeningEvents } from './readers/sickeningEvents.ts';
import { tixr } from './readers/tixr.ts';
import { NO_RECEIPT, hasTicketSubject, readVerbatim } from './verbatimReader.ts';
import { BOUTIQUE } from './readers/boutique.ts';
import { RESALE } from './readers/resale.ts';
import { passRead, readIcs, readPkpass, readSchemaOrg, type MarkupRead } from './markup.ts';
import type { EmailKind, EmailReader, Quoted, ReadEmail } from './readerTypes.ts';
import { UnreadableEmail } from './readerTypes.ts';
import { emailLines, senderAddress } from './text.ts';
import type { EmailImportProposal, FieldEvidence, RawEmailMessage } from './types.ts';
import { normalize } from './verbatim.ts';

export const READERS: EmailReader[] = [ticketmaster, liveNation, tixr, dice, residentAdvisor, eventbrite, axs, frontGate, ticketWeb, brownPaperTickets, sickeningEvents, ...BOUTIQUE, ...RESALE];

// A forward from a phone often keeps only the sender's name ("From:
// Ticketmaster"). Then the reader is the one whose seller that name is.
function byDisplayName(from: string): EmailReader | undefined {
  if (from.includes('@')) return undefined;
  const name = normalizeName(from.replace(/<.*>/, ''));
  return READERS.find((r) => {
    const seller = normalizeName(r.seller);
    return name === seller || name.startsWith(`${seller} `);
  });
}

type Flag = EmailImportProposal['flags'][number]['kind'];
const FLAG: Record<Exclude<EmailKind, 'order'>, Flag> = { refund: 'refunded', cancelled: 'cancelled', transferred_away: 'transferred' };

interface Outcome {
  email: RawEmailMessage;
  seller: string;
  readBy: FieldEvidence['readBy'];
  lines: string[];
  read?: ReadEmail;
  unreadable?: string;
  skipped?: string; // not a receipt (promotion, newsletter): listed, not reviewed
  source: string[]; // machine markup a quote may also come from
}

// Synchronous: reads bodies only. Use scanEmails to also read schema.org
// markup and .pkpass / .ics attachments.
export function readRawEmails(raws: RawEmailMessage[]): EmailImportProposal[] {
  return group(raws.flatMap((raw) => outcomeOf(raw, [])));
}

// The whole funnel: Layer 2 markup and attachments, then the seller reader
// or Layer 4, merged so that markup gives the show and the body adds the
// price.
export async function scanEmails(raws: RawEmailMessage[]): Promise<EmailImportProposal[]> {
  const outcomes: Outcome[] = [];
  for (const raw of raws) outcomes.push(...outcomeOf(raw, await markupOf(raw)));
  return group(outcomes);
}

async function markupOf(raw: RawEmailMessage): Promise<MarkupRead[]> {
  const out: MarkupRead[] = [];
  const schema = readSchemaOrg(raw.html);
  if (schema) out.push(schema);
  for (const a of raw.attachments ?? []) {
    const bytes = base64(a.dataBase64);
    if (!bytes) continue;
    if (/\.pkpass$/i.test(a.filename) || a.mimeType === 'application/vnd.apple.pkpass') {
      const t = await readPkpass(bytes);
      const r = t && passRead(t);
      if (r) out.push(r);
    } else if (/\.ics$/i.test(a.filename) || a.mimeType === 'text/calendar') {
      const r = readIcs(new TextDecoder().decode(bytes));
      if (r) out.push(r);
    }
  }
  return out;
}

function base64(data: string): Uint8Array | null {
  try {
    const bin = atob(data.replace(/\s+/g, ''));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

// Markup fills what the body read lacks; the body's own values win, since
// they are what the user sees.
function withMarkup(read: ReadEmail | undefined, markup: MarkupRead[]): { read?: ReadEmail; by?: FieldEvidence['readBy'] } {
  const m = markup.find((x) => x.read.name && x.read.startDate) ?? markup[0];
  if (!m) return { read };
  if (!read) return { read: m.read, by: m.by };
  const tag = (x: ReadEmail['name'] | undefined) => x && { ...x, by: m.by };
  return {
    read: {
      ...read,
      startDate: read.startDate ?? tag(m.read.startDate),
      endDate: read.endDate ?? (read.startDate ? undefined : tag(m.read.endDate)),
      venue: read.venue ?? tag(m.read.venue),
      city: read.city ?? tag(m.read.city),
      orderId: read.orderId ?? m.read.orderId,
    },
  };
}

function outcomeOf(raw: RawEmailMessage, markup: MarkupRead[]): Outcome[] {
  let email = raw;
  let lines = emailLines(raw);
  let reader = READERS.find((r) => r.matches(email.from));
  let forwardedFrom = false;
  const source = markup.flatMap((m) => m.source);
  const forwarded = reader ? null : unwrapForward(raw, lines);
  if (forwarded) {
    email = { ...forwarded.email, link: raw.link, id: raw.id };
    lines = forwarded.lines;
    reader = READERS.find((r) => r.matches(email.from)) ?? byDisplayName(email.from);
    forwardedFrom = true;
    if (!forwarded.dated) {
      return [{ email, seller: reader?.seller ?? domainOf(email.from), readBy: 'layout', lines, source, unreadable: 'The forward does not say when the original was sent.' }];
    }
  }
  const seller = reader?.seller ?? domainOf(email.from);
  const label = forwardedFrom ? `forwarded:${seller}` : seller;
  const readBy: FieldEvidence['readBy'] = reader ? 'layout' : 'verbatim_heuristic';
  let read: ReadEmail | undefined;
  let unreadable: string | undefined;
  try {
    read = (reader ? reader.read(email, lines) : readVerbatim(email, lines)) ?? undefined;
  } catch (err) {
    if (!(err instanceof UnreadableEmail)) throw err;
    // No order or confirmation wording: a promotion or newsletter, not a missed receipt.
    if (!reader && err.message === NO_RECEIPT) return [{ email, seller: label, readBy, lines, source, skipped: 'No receipt wording in the message.' }];
    unreadable = err.message;
  }
  if (read && read.kind !== 'order') return [{ email, seller: label, readBy, lines, source, read }];
  const merged = withMarkup(read, markup);
  // A show without a day is not a proposal: markup can give a name and venue
  // with no local date (a UTC start), and the review list needs the date.
  if (merged.read && merged.read.kind === 'order' && !merged.read.startDate && !merged.read.dateText) {
    return [{ email, seller: label, readBy, lines, source, unreadable: 'No readable event date.' }];
  }
  if (merged.read) return [{ email, seller: label, readBy: read ? readBy : merged.by!, lines, source, read: merged.read }];
  if (unreadable !== undefined) return [{ email, seller: label, readBy, lines, source, unreadable }];
  return [];
}

function domainOf(from: string): string {
  return senderAddress(from).split('@')[1]?.replace(/^.*?([^.]+\.[^.]+)$/, '$1') ?? 'unknown';
}

// The source text a quote must occur in: the lines plus the subject.
const sourceOf = (o: Outcome) => [...o.lines, o.email.subject, ...o.source].join('\n');

// A field is kept only when its quote is a substring of the message (words
// as the reader copied them, whitespace and case aside) and, for names and
// venues, the value is a substring of that quote. Dates and cities are read
// from their quote, so only the quote is checked.
function evidence(o: Outcome, field: Quoted | undefined, valueInQuote: boolean): FieldEvidence | undefined {
  if (!field) return undefined;
  const { value, quote } = field;
  const q = normalize(quote);
  if (!q || !normalize(sourceOf(o)).includes(q)) return undefined;
  if (valueInQuote && !q.includes(normalize(value))) return undefined;
  return { value, quote, messageId: o.email.id, messageLink: o.email.link, readBy: field.by ?? o.readBy };
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
    if (o.skipped !== undefined) {
      const key = `skipped|${o.email.id}`;
      if (byKey.has(key)) continue;
      const p = blank(key, o.seller);
      p.status = 'skipped';
      p.rawSubject = o.email.subject;
      link(p, o);
      byKey.set(key, p);
      continue;
    }
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
    const name = evidence(o, read.name, true);
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
    const date = evidence(o, read.startDate, false);
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
    p.endDate ??= evidence(o, read.endDate, false);
    p.venue ??= evidence(o, read.venue, true);
    p.city ??= evidence(o, read.city, false);
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
