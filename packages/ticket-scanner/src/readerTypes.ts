import type { RawEmailMessage } from './types.ts';

// What a seller's reader finds in one message, each value with its words.
export type EmailKind = 'order' | 'refund' | 'cancelled' | 'transferred_away';

export interface Quoted {
  value: string;
  quote: string; // the words in the email it was read from
  by?: 'schema_org' | 'pkpass' | 'ics'; // set when machine markup, not the body, gave it
}

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
  total?: string;
}

export interface EmailReader {
  seller: string;
  domain: string;
  search?: string; // Gmail search words that keep a scan to this seller's ticket mail
  matches(from: string): boolean;
  // null: not a ticket email (ads, reminders). A subject that announces
  // tickets but whose body cannot be read throws UnreadableEmail.
  read(email: RawEmailMessage, lines: string[]): ReadEmail | null;
}

export class UnreadableEmail extends Error {}
