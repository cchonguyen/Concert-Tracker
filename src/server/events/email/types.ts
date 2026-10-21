import type { EventField } from '../types';

// Email import: ticket emails become stage 1 candidates you review before
// anything is saved. See ARCHITECTURE.md ("Stage 1 from email").

// One message as a feeder hands it over (Gmail via this project's connector
// today). The server reads it; the feeder never interprets anything.
export interface RawEmail {
  id: string; // the mail provider's message id
  link?: string; // a link that opens the message (Gmail permalink)
  from: string;
  sentAt: string; // ISO timestamp
  subject: string;
  html?: string;
  text?: string;
}

// order: you got tickets; refund, cancelled, transferred_away: a ticket you
// will not use; other mail from a seller (ads, reminders) is not read.
export type EmailKind = 'order' | 'refund' | 'cancelled' | 'transferred_away';

export interface Quoted {
  value: string;
  quote: string; // the words in the email it was read from
}

// What a seller's reader found in one message, each value with its words.
export interface ReadEmail {
  kind: EmailKind;
  name: Quoted;
  startDate?: Quoted;
  endDate?: Quoted;
  dateText?: string; // date words that did not give a full date (no year, say)
  venue?: Quoted;
  city?: Quoted;
  orderId?: string;
  tickets?: number;
  total?: string; // as written, for the review screen only
}

export interface EmailReader {
  seller: string; // shown to you: "Ticketmaster"
  domain: string; // its mail comes from this domain or a subdomain; "Check email" searches for it
  search?: string; // Gmail search words that keep "Check email" to its ticket mail, for sellers that send many ads
  matches(from: string): boolean;
  // null: not a ticket email (ads, reminders). A subject that announces
  // tickets but whose body cannot be read throws UnreadableEmail.
  read(email: RawEmail, lines: string[]): ReadEmail | null;
}

export class UnreadableEmail extends Error {}

export interface EmailSource {
  messageId: string;
  link?: string;
  quote: string;
}

export type ImportField = 'name' | Exclude<EventField, 'region' | 'country'> | 'ticketPrice';
export type ImportFlag = 'refunded' | 'cancelled' | 'transferred_away';

// new: waiting for your review; added: saved as an event; skipped: you said
// you did not go; unreadable: a ticket email no reader understood; flag: a
// refund or similar kept aside until its order is read (never listed).
export type ImportStatus = 'new' | 'added' | 'skipped' | 'unreadable' | 'flag';

// One show found in your mail: every message about it, grouped.
export interface EmailImport {
  id: string;
  key: string; // seller + order id, or name + date; stable across re-imports
  status: ImportStatus;
  seller: string;
  name?: string;
  startDate?: string;
  endDate?: string;
  dateText?: string;
  venue?: string;
  city?: string;
  sources: Partial<Record<ImportField, EmailSource>>;
  messages: Array<{ id: string; link?: string; subject: string; sentAt: string; kind?: EmailKind }>;
  flags: ImportFlag[];
  orderIds?: string[]; // the seller's order numbers the emails gave
  tickets?: number;
  total?: string;
  // One ticket's cost: an email's total in dollars over its ticket count,
  // from the first email that gives both.
  ticketPrice?: number;
  eventId?: string; // the event it became, or the one already in your log
  createdAt: string;
  updatedAt: string;
}
